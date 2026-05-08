// Thin wrapper around the MCP TypeScript SDK's Streamable-HTTP client.
//
// Mike opens one client per (user, MCP server) per chat request. Connections
// are short-lived: we initialize, list tools, run any tools the model calls,
// then close in a `finally` on the request handler. There is no connection
// pool — each chat request pays an `initialize` round-trip per enabled
// server. This keeps the design stateless and avoids needing a worker.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;

export class McpHttpClient {
    private client: Client | null = null;
    private transport: StreamableHTTPClientTransport | null = null;

    constructor(
        private readonly url: string,
        private readonly headers: Record<string, string>,
        private readonly authProvider?: OAuthClientProvider,
    ) {}

    async connect(): Promise<void> {
        this.transport = new StreamableHTTPClientTransport(new URL(this.url), {
            requestInit: {
                headers: this.headers,
            },
            ...(this.authProvider ? { authProvider: this.authProvider } : {}),
        });
        this.client = new Client(
            { name: "mike", version: "1.0.0" },
            { capabilities: {} },
        );
        await withTimeout(
            this.client.connect(this.transport),
            CONNECT_TIMEOUT_MS,
            "MCP connect",
        );
    }

    async listTools(): Promise<Tool[]> {
        if (!this.client) throw new Error("MCP client not connected");
        const result = await withTimeout(
            this.client.listTools(),
            CONNECT_TIMEOUT_MS,
            "MCP listTools",
        );
        return result.tools as Tool[];
    }

    /**
     * Calls a tool and returns a structured {ok, content, truncated} result.
     * Errors (transport failures, MCP `isError`) become ok=false with the
     * error message in `content` so the model can surface them rather than
     * crashing the chat. `content` is hard-capped at MAX_TOOL_CONTENT_BYTES
     * (configurable via MCP_MAX_TOOL_BYTES) to prevent a misbehaving connector
     * from blowing the LLM context window or DoSing the chat.
     */
    async callTool(
        name: string,
        args: Record<string, unknown>,
    ): Promise<{ ok: boolean; content: string; truncated: boolean }> {
        if (!this.client) {
            return {
                ok: false,
                content: "MCP client not connected",
                truncated: false,
            };
        }
        try {
            const result = await withTimeout(
                this.client.callTool({ name, arguments: args }),
                CALL_TIMEOUT_MS,
                `MCP callTool(${name})`,
            );
            const blocks = (result.content ?? []) as Array<{
                type?: string;
                text?: string;
            }>;
            const text = blocks
                .filter((b) => b?.type === "text" && typeof b.text === "string")
                .map((b) => b.text)
                .join("\n\n");
            if (result.isError) {
                return capContent(
                    false,
                    `Error: ${text || "(no detail)"}`,
                );
            }
            return capContent(true, text || "(tool returned no text content)");
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, content: `Failed: ${msg}`, truncated: false };
        }
    }

    async close(): Promise<void> {
        try {
            await this.client?.close();
        } catch {
            /* ignore */
        }
        try {
            await this.transport?.close();
        } catch {
            /* ignore */
        }
        this.client = null;
        this.transport = null;
    }
}

// Cap tool output before it reaches the LLM. A misbehaving connector that
// returns multi-megabyte responses would blow the model's context window,
// rack up token cost, and effectively DoS the chat. Default 64 KB; override
// via MCP_MAX_TOOL_BYTES.
const MAX_TOOL_CONTENT_BYTES = (() => {
    const raw = Number(process.env.MCP_MAX_TOOL_BYTES);
    return Number.isFinite(raw) && raw > 0 ? raw : 64 * 1024;
})();

function capContent(
    ok: boolean,
    raw: string,
): { ok: boolean; content: string; truncated: boolean } {
    const buf = Buffer.from(raw, "utf8");
    if (buf.byteLength <= MAX_TOOL_CONTENT_BYTES) {
        return { ok, content: raw, truncated: false };
    }
    const head = buf.subarray(0, MAX_TOOL_CONTENT_BYTES).toString("utf8");
    const skipped = buf.byteLength - MAX_TOOL_CONTENT_BYTES;
    const marker = `\n\n[…truncated ${skipped} bytes; raise MCP_MAX_TOOL_BYTES to see more]`;
    return { ok, content: head + marker, truncated: true };
}

function withTimeout<T>(
    p: Promise<T>,
    ms: number,
    label: string,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(
            () => reject(new Error(`${label} timed out after ${ms}ms`)),
            ms,
        );
        p.then(
            (v) => {
                clearTimeout(t);
                resolve(v);
            },
            (e) => {
                clearTimeout(t);
                reject(e);
            },
        );
    });
}
