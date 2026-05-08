import crypto from "crypto";

/**
 * HMAC-signed, non-expiring download tokens.
 *
 * The token encodes the R2 storage path + filename; the backend route
 * `/download/:token` validates the signature and streams the file. This
 * gives persistent links safe to store in chat history without signed-URL
 * expiry or R2 CORS headaches.
 */

/**
 * Resolves the shared HMAC signing secret. Used here for download tokens
 * and re-exported for other call sites that share the same threat model
 * (e.g. MCP OAuth state tokens in lib/mcp/oauth.ts) so a single env var
 * gates every signed token in the app.
 */
export function getSigningSecret(): string {
    const secret = process.env.DOWNLOAD_SIGNING_SECRET;
    if (!secret?.trim()) {
        throw new Error(
            "DOWNLOAD_SIGNING_SECRET is required. " +
                "Generate a strong random value (e.g. `openssl rand -hex 32`) and set it in the environment.",
        );
    }
    return secret.trim();
}

function timingSafeEqStr(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function signDownload(path: string, filename: string): string {
    const payload = JSON.stringify({ p: path, f: filename });
    const enc = Buffer.from(payload, "utf8").toString("base64url");
    const sig = crypto
        .createHmac("sha256", getSigningSecret())
        .update(enc)
        .digest();
    return `${enc}.${sig.toString("base64url")}`;
}

export function verifyDownload(
    token: string,
): { path: string; filename: string } | null {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [enc, sigEnc] = parts;
    const expected = crypto
        .createHmac("sha256", getSigningSecret())
        .update(enc)
        .digest();
    if (!timingSafeEqStr(sigEnc, expected.toString("base64url"))) return null;
    try {
        const parsed = JSON.parse(Buffer.from(enc, "base64url").toString("utf8")) as {
            p: string;
            f: string;
        };
        if (!parsed?.p || !parsed?.f) return null;
        return { path: parsed.p, filename: parsed.f };
    } catch {
        return null;
    }
}

/**
 * Returns a relative download URL (e.g. "/download/abc.def"). The frontend
 * prefixes it with NEXT_PUBLIC_API_BASE_URL when rendering `<a href=…>`.
 */
export function buildDownloadUrl(path: string, filename: string): string {
    return `/download/${signDownload(path, filename)}`;
}
