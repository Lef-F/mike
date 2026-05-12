import crypto from "crypto";

const ENCRYPTED_PREFIX = "enc:v1:";

function getEncryptionSecret(): string {
    const secret = process.env.USER_API_KEYS_ENCRYPTION_KEY;
    if (!secret?.trim()) {
        throw new Error(
            "USER_API_KEYS_ENCRYPTION_KEY is required to store user API keys",
        );
    }
    return secret.trim();
}

function keyFromSecret(secret: string): Buffer {
    return crypto.createHash("sha256").update(secret, "utf8").digest();
}

export function isEncryptedApiKey(value: string | null | undefined): boolean {
    return typeof value === "string" && value.startsWith(ENCRYPTED_PREFIX);
}

export function encryptApiKey(value: string | null | undefined): string | null {
    const plaintext = value?.trim();
    if (!plaintext) return null;

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(
        "aes-256-gcm",
        keyFromSecret(getEncryptionSecret()),
        iv,
    );
    const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${ENCRYPTED_PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptApiKey(value: string | null | undefined): string | null {
    if (!value) return null;
    if (!isEncryptedApiKey(value)) {
        // Legacy plaintext values are supported so existing deployments can
        // continue while getUserApiKeys opportunistically rewrites them.
        return value;
    }

    const payload = value.slice(ENCRYPTED_PREFIX.length);
    const [ivRaw, tagRaw, ciphertextRaw] = payload.split(".");
    if (!ivRaw || !tagRaw || !ciphertextRaw) {
        throw new Error("Stored API key has an invalid encrypted format");
    }

    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        keyFromSecret(getEncryptionSecret()),
        Buffer.from(ivRaw, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertextRaw, "base64url")),
        decipher.final(),
    ]);
    return plaintext.toString("utf8");
}

export function hasStoredApiKey(value: string | null | undefined): boolean {
    return typeof value === "string" && value.trim().length > 0;
}

/** The set of LLM provider keys we encrypt at rest. */
export const PROVIDER_KEY_COLUMNS = [
    "claude_api_key",
    "gemini_api_key",
    "openrouter_api_key",
] as const;
export type ProviderKeyColumn = (typeof PROVIDER_KEY_COLUMNS)[number];

/** Maps the API names the frontend sends to the column names we store. */
export const PROVIDER_KEY_COLUMN_BY_INPUT: Record<string, ProviderKeyColumn> = {
    claude: "claude_api_key",
    gemini: "gemini_api_key",
    openrouter: "openrouter_api_key",
};

/**
 * For each provider key column that is stored as plaintext, returns a record
 * of `{ column: encryptedValue }` suitable for a database UPDATE (opportunistic
 * upgrade path). Returns an empty object when no upgrades are needed.
 */
export function buildPlaintextUpgrades(
    row: Partial<Record<ProviderKeyColumn, string | null>>,
): Partial<Record<ProviderKeyColumn, string>> {
    const updates: Partial<Record<ProviderKeyColumn, string>> = {};
    for (const col of PROVIDER_KEY_COLUMNS) {
        const stored = row[col] ?? null;
        if (stored && !isEncryptedApiKey(stored)) {
            updates[col] = encryptApiKey(stored)!;
        }
    }
    return updates;
}

/**
 * Converts a frontend `api_keys` payload (e.g. `{ claude: "sk-…" }`) into a
 * record of encrypted column values ready to be merged into a database UPDATE.
 */
export function encryptApiKeyInputs(
    apiKeys: Partial<Record<string, string | null>>,
): Partial<Record<ProviderKeyColumn, string | null>> {
    const updates: Partial<Record<ProviderKeyColumn, string | null>> = {};
    for (const [input, col] of Object.entries(PROVIDER_KEY_COLUMN_BY_INPUT)) {
        if (input in apiKeys) {
            updates[col] = encryptApiKey(apiKeys[input]);
        }
    }
    return updates;
}

// ---------------------------------------------------------------------------
// JSON-blob helpers — used for MCP credentials (headers + oauth_tokens).
//
// Storage format: we JSON-serialize the value, encrypt the resulting string
// with the same AES-256-GCM envelope as the per-key helpers above, and write
// the ciphertext string into the jsonb column. A JSON string is itself valid
// jsonb, so this round-trips cleanly without needing a column type change.
// On read we sniff `typeof value === "string" && startsWith("enc:v1:")` to
// distinguish encrypted blobs from legacy plaintext objects.
//
// Encrypting the whole blob (rather than each leaf) keeps the format simple,
// minimizes cipher operations, and avoids leaking the shape (e.g. "this row
// has a refresh_token" vs "only an access_token") to anyone who can read the
// table.
// ---------------------------------------------------------------------------

/**
 * Encrypts an arbitrary JSON-serializable value to an `enc:v1:` ciphertext
 * string suitable for storing in a jsonb column. Returns null for null/
 * undefined/empty inputs so callers can pass through "no value" cleanly.
 */
export function encryptJsonBlob(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const serialized = JSON.stringify(value);
    if (!serialized) return null;
    return encryptApiKey(serialized);
}

/**
 * Reverse of {@link encryptJsonBlob}. Accepts an encrypted ciphertext string,
 * a legacy plaintext object/array (returned as-is), or null/undefined. Throws
 * only if the value is an `enc:v1:` envelope but the ciphertext is malformed
 * or the encryption key is wrong.
 */
export function decryptJsonBlob<T = unknown>(
    value: unknown,
): T | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" && isEncryptedApiKey(value)) {
        const plaintext = decryptApiKey(value);
        if (plaintext === null) return null;
        return JSON.parse(plaintext) as T;
    }
    // Legacy plaintext path: the column was written before encryption was
    // enabled, so the jsonb already holds the structured value directly.
    return value as T;
}

/**
 * True if the given jsonb-shaped value looks like a legacy plaintext blob
 * that should be opportunistically re-encrypted. Strings that already carry
 * the `enc:v1:` envelope are skipped; null/undefined are skipped; everything
 * else (objects, arrays, plain strings without the envelope) is a candidate.
 */
export function needsJsonBlobUpgrade(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === "string" && isEncryptedApiKey(value)) return false;
    return true;
}
