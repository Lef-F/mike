import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    decryptApiKey,
    decryptJsonBlob,
    encryptApiKey,
    encryptJsonBlob,
    hasStoredApiKey,
    isEncryptedApiKey,
    needsJsonBlobUpgrade,
} from "../src/lib/apiKeys";

describe("user API key encryption", () => {
    it("encrypts and decrypts stored keys", () => {
        const previous = process.env.USER_API_KEYS_ENCRYPTION_KEY;
        process.env.USER_API_KEYS_ENCRYPTION_KEY = "test-encryption-secret";
        try {
            const encrypted = encryptApiKey("sk-test-value");
            assert.ok(encrypted);
            assert.ok(isEncryptedApiKey(encrypted));
            assert.notEqual(encrypted, "sk-test-value");
            assert.equal(decryptApiKey(encrypted), "sk-test-value");
            assert.equal(hasStoredApiKey(encrypted), true);
        } finally {
            if (previous === undefined) {
                delete process.env.USER_API_KEYS_ENCRYPTION_KEY;
            } else {
                process.env.USER_API_KEYS_ENCRYPTION_KEY = previous;
            }
        }
    });

    it("requires the encryption secret for new stored keys", () => {
        const previous = process.env.USER_API_KEYS_ENCRYPTION_KEY;
        delete process.env.USER_API_KEYS_ENCRYPTION_KEY;
        try {
            assert.throws(() => encryptApiKey("sk-test-value"), {
                message: /USER_API_KEYS_ENCRYPTION_KEY/,
            });
            assert.equal(decryptApiKey("legacy-plaintext"), "legacy-plaintext");
        } finally {
            if (previous !== undefined) {
                process.env.USER_API_KEYS_ENCRYPTION_KEY = previous;
            }
        }
    });
});

describe("MCP credential JSON blob encryption", () => {
    it("encrypts and decrypts a JSON object roundtrip", () => {
        const previous = process.env.USER_API_KEYS_ENCRYPTION_KEY;
        process.env.USER_API_KEYS_ENCRYPTION_KEY = "test-encryption-secret";
        try {
            const value = { Authorization: "Bearer sk-secret-token" };
            const encrypted = encryptJsonBlob(value);
            assert.ok(encrypted, "expected ciphertext to be returned");
            assert.ok(isEncryptedApiKey(encrypted));
            assert.notEqual(encrypted, JSON.stringify(value));
            assert.deepEqual(decryptJsonBlob(encrypted), value);
        } finally {
            if (previous === undefined) {
                delete process.env.USER_API_KEYS_ENCRYPTION_KEY;
            } else {
                process.env.USER_API_KEYS_ENCRYPTION_KEY = previous;
            }
        }
    });

    it("encrypts oauth-token-shaped blobs without leaking shape", () => {
        const previous = process.env.USER_API_KEYS_ENCRYPTION_KEY;
        process.env.USER_API_KEYS_ENCRYPTION_KEY = "test-encryption-secret";
        try {
            const tokens = {
                access_token: "at-123",
                refresh_token: "rt-456",
                token_type: "Bearer",
                expires_in: 3600,
            };
            const encrypted = encryptJsonBlob(tokens);
            assert.ok(encrypted);
            assert.equal(encrypted.includes("refresh_token"), false);
            assert.equal(encrypted.includes("at-123"), false);
            assert.deepEqual(decryptJsonBlob(encrypted), tokens);
        } finally {
            if (previous === undefined) {
                delete process.env.USER_API_KEYS_ENCRYPTION_KEY;
            } else {
                process.env.USER_API_KEYS_ENCRYPTION_KEY = previous;
            }
        }
    });

    it("treats null and undefined as null on encrypt and decrypt", () => {
        const previous = process.env.USER_API_KEYS_ENCRYPTION_KEY;
        process.env.USER_API_KEYS_ENCRYPTION_KEY = "test-encryption-secret";
        try {
            assert.equal(encryptJsonBlob(null), null);
            assert.equal(encryptJsonBlob(undefined), null);
            assert.equal(decryptJsonBlob(null), null);
            assert.equal(decryptJsonBlob(undefined), null);
        } finally {
            if (previous === undefined) {
                delete process.env.USER_API_KEYS_ENCRYPTION_KEY;
            } else {
                process.env.USER_API_KEYS_ENCRYPTION_KEY = previous;
            }
        }
    });

    it("passes legacy plaintext jsonb objects through unchanged on decrypt", () => {
        const previous = process.env.USER_API_KEYS_ENCRYPTION_KEY;
        process.env.USER_API_KEYS_ENCRYPTION_KEY = "test-encryption-secret";
        try {
            const legacy = { Authorization: "Bearer legacy" };
            // Simulates a row written before encryption-at-rest landed: the
            // jsonb column still holds the structured object directly.
            assert.deepEqual(decryptJsonBlob(legacy), legacy);
            assert.deepEqual(decryptJsonBlob([1, 2, 3]), [1, 2, 3]);
        } finally {
            if (previous === undefined) {
                delete process.env.USER_API_KEYS_ENCRYPTION_KEY;
            } else {
                process.env.USER_API_KEYS_ENCRYPTION_KEY = previous;
            }
        }
    });

    it("flags legacy values as needing upgrade and skips null + already-encrypted", () => {
        const previous = process.env.USER_API_KEYS_ENCRYPTION_KEY;
        process.env.USER_API_KEYS_ENCRYPTION_KEY = "test-encryption-secret";
        try {
            assert.equal(needsJsonBlobUpgrade(null), false);
            assert.equal(needsJsonBlobUpgrade(undefined), false);
            assert.equal(
                needsJsonBlobUpgrade({ Authorization: "Bearer x" }),
                true,
            );
            const encrypted = encryptJsonBlob({ a: 1 })!;
            assert.equal(needsJsonBlobUpgrade(encrypted), false);
        } finally {
            if (previous === undefined) {
                delete process.env.USER_API_KEYS_ENCRYPTION_KEY;
            } else {
                process.env.USER_API_KEYS_ENCRYPTION_KEY = previous;
            }
        }
    });

    it("propagates the missing-secret throw on encrypt-time", () => {
        const previous = process.env.USER_API_KEYS_ENCRYPTION_KEY;
        delete process.env.USER_API_KEYS_ENCRYPTION_KEY;
        try {
            assert.throws(
                () => encryptJsonBlob({ Authorization: "Bearer x" }),
                { message: /USER_API_KEYS_ENCRYPTION_KEY/ },
            );
        } finally {
            if (previous !== undefined) {
                process.env.USER_API_KEYS_ENCRYPTION_KEY = previous;
            }
        }
    });
});
