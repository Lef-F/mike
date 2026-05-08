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

function b64url(buf: Buffer): string {
    return buf.toString("base64url");
}

function fromB64url(value: string): Buffer {
    return Buffer.from(value, "base64url");
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
    return `${ENCRYPTED_PREFIX}${b64url(iv)}.${b64url(tag)}.${b64url(ciphertext)}`;
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
        fromB64url(ivRaw),
    );
    decipher.setAuthTag(fromB64url(tagRaw));
    const plaintext = Buffer.concat([
        decipher.update(fromB64url(ciphertextRaw)),
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
