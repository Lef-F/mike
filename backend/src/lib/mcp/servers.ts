// Per-request MCP server loader.
//
// Called once at the top of each chat request. Reads the user's enabled MCP
// servers from Postgres, opens a Streamable-HTTP client to each in parallel,
// fetches its tool list, and converts each tool to the OpenAI-style schema
// Mike's LLM adapter speaks. Tool names are prefixed with `mcp__<slug>__` so
// the dispatcher in chatTools can route calls back to the right server.

import { createHash } from "crypto";
import {
    decryptJsonBlob,
    encryptJsonBlob,
    needsJsonBlobUpgrade,
} from "../apiKeys";
import type { OpenAIToolSchema } from "../llm/types";
import type { createServerSupabase } from "../supabase";
import { McpHttpClient } from "./client";
import { DbOAuthProvider, ReauthRequiredError } from "./oauth";
import type { LoadedMcpServer, McpServerRow } from "./types";

/**
 * Decodes the credential-bearing jsonb columns on a freshly-fetched row,
 * mutating the row in place to expose plaintext to the rest of the loader.
 * Returns a partial UPDATE patch for any column that was stored as legacy
 * plaintext and should be re-written encrypted; the caller fires that off
 * best-effort so the hot path isn't blocked on the upgrade write.
 *
 * `oauth_code_verifier` is a per-text-column secret read on demand by
 * DbOAuthProvider.codeVerifier(); we don't touch it here.
 */
export function decryptMcpRowCredentials(
    row: McpServerRow,
): Partial<Record<"headers" | "oauth_tokens", string>> {
    const upgrades: Partial<Record<"headers" | "oauth_tokens", string>> = {};

    const rawHeaders = row.headers as unknown;
    const decryptedHeaders =
        decryptJsonBlob<Record<string, string>>(rawHeaders) ?? {};
    row.headers = decryptedHeaders;
    if (needsJsonBlobUpgrade(rawHeaders)) {
        const enc = encryptJsonBlob(decryptedHeaders);
        if (enc) upgrades.headers = enc;
    }

    const rawTokens = row.oauth_tokens as unknown;
    const decryptedTokens = decryptJsonBlob<Record<string, unknown>>(rawTokens);
    row.oauth_tokens = decryptedTokens;
    if (needsJsonBlobUpgrade(rawTokens) && decryptedTokens) {
        const enc = encryptJsonBlob(decryptedTokens);
        if (enc) upgrades.oauth_tokens = enc;
    }

    return upgrades;
}

const TOOL_NAME_MAX = 64;
const TOOL_PREFIX = "mcp__";

export async function loadEnabledMcpServersForUser(
    userId: string,
    db: ReturnType<typeof createServerSupabase>,
): Promise<LoadedMcpServer[]> {
    const { data, error } = await db
        .from("user_mcp_servers")
        .select("*")
        .eq("user_id", userId)
        .eq("enabled", true);
    if (error || !data || data.length === 0) return [];

    const rows = data as McpServerRow[];

    // Decrypt credential columns in place + opportunistically rewrite any
    // legacy plaintext rows in the background. We don't await the upgrade
    // so a failing-forever encryption write can't block tool loading on
    // every chat turn — but we do log it so callers can detect it.
    for (const row of rows) {
        const upgrades = decryptMcpRowCredentials(row);
        if (Object.keys(upgrades).length > 0) {
            void db
                .from("user_mcp_servers")
                .update(upgrades)
                .eq("id", row.id)
                .then(({ error: upgErr }) => {
                    if (upgErr) {
                        console.warn(
                            `[mcp] failed to encrypt-at-rest upgrade row ${row.id}: ${upgErr.message}`,
                        );
                    }
                });
        }
    }

    const results = await Promise.allSettled(
        rows.map((row) => loadOne(row, userId, db)),
    );

    const out: LoadedMcpServer[] = [];
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const row = rows[i];
        if (r.status === "fulfilled" && r.value) {
            out.push(r.value);
            // Clear stale error on success.
            if (row.last_error) {
                await db
                    .from("user_mcp_servers")
                    .update({ last_error: null })
                    .eq("id", row.id);
            }
        } else {
            const reason = r.status === "rejected" ? r.reason : "unknown error";
            const isReauth = reason instanceof ReauthRequiredError;
            const err =
                reason instanceof Error ? reason.message : String(reason);
            console.warn(
                `[mcp] failed to load server ${row.slug} (${row.url}): ${err}`,
            );
            await db
                .from("user_mcp_servers")
                .update({
                    last_error: isReauth
                        ? "reauth_required"
                        : err.slice(0, 1000),
                })
                .eq("id", row.id);
        }
    }
    return out;
}

async function loadOne(
    row: McpServerRow,
    userId: string,
    db: ReturnType<typeof createServerSupabase>,
): Promise<LoadedMcpServer | null> {
    let authProvider: DbOAuthProvider | undefined;
    if (row.auth_type === "oauth") {
        // No tokens yet → don't even try to connect; the UI will surface a
        // "Sign in" affordance and the user kicks off /oauth/start.
        if (!row.oauth_tokens) {
            throw new ReauthRequiredError(
                "Connector not yet authorized — sign in from settings",
            );
        }
        authProvider = new DbOAuthProvider(db, row.id, userId, "use");
    }
    const client = new McpHttpClient(
        row.url,
        row.headers ?? {},
        authProvider,
    );
    await client.connect();
    const mcpTools = await client.listTools();

    const tools: OpenAIToolSchema[] = [];
    const toolNameMap = new Map<string, string>();
    for (const t of mcpTools) {
        const prefixed = prefixedToolName(row.slug, t.name);
        toolNameMap.set(prefixed, t.name);
        tools.push({
            type: "function",
            function: {
                name: prefixed,
                description: `[${row.name}] ${t.description ?? ""}`.trim(),
                parameters: (t.inputSchema as Record<string, unknown>) ?? {
                    type: "object",
                    properties: {},
                },
            },
        });
    }

    return {
        row,
        tools,
        toolNameMap,
        client: {
            callTool: (name, args) => client.callTool(name, args),
            close: () => client.close(),
        },
    };
}

/**
 * `mcp__<slug>__<toolName>`, capped at 64 chars (Anthropic's limit).
 * If the natural name is too long, the toolName tail is replaced with a
 * 12-hex-char hash so the prefix stays intact and the dispatcher can route.
 */
export function prefixedToolName(slug: string, toolName: string): string {
    const natural = `${TOOL_PREFIX}${slug}__${toolName}`;
    if (natural.length <= TOOL_NAME_MAX) return natural;
    const hash = createHash("sha256")
        .update(toolName)
        .digest("hex")
        .slice(0, 12);
    const head = `${TOOL_PREFIX}${slug}__`;
    const room = TOOL_NAME_MAX - head.length - 1 /* underscore */ - hash.length;
    const truncated = toolName.slice(0, Math.max(0, room));
    return `${head}${truncated}_${hash}`.slice(0, TOOL_NAME_MAX);
}

export async function closeMcpServers(servers: LoadedMcpServer[]): Promise<void> {
    await Promise.allSettled(servers.map((s) => s.client.close()));
}

/**
 * Look up which loaded server owns a prefixed tool name. Used by the chat
 * tool dispatcher.
 */
export function findMcpServerForTool(
    prefixedName: string,
    servers: LoadedMcpServer[],
): { server: LoadedMcpServer; originalName: string } | null {
    for (const s of servers) {
        const original = s.toolNameMap.get(prefixedName);
        if (original) return { server: s, originalName: original };
    }
    return null;
}
