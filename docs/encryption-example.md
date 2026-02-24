# Client-Side Encryption Example

REPRAM stores opaque bytes. It doesn't encrypt, decrypt, or inspect your data. If you need confidentiality, encrypt before storing and decrypt after retrieving. This is a feature, not a gap — the node literally cannot leak what it cannot read.

This example uses Node.js (TypeScript) with the built-in `crypto` module. No dependencies beyond what ships with Node 18+.

## Encrypted Store and Retrieve

AES-256-GCM with a preshared key. The IV is prepended to the ciphertext so the value is self-contained.

```typescript
import crypto from "node:crypto";

const REPRAM_URL = process.env.REPRAM_URL ?? "http://localhost:8080";

// Derive a 256-bit key from a passphrase. In production, use a proper
// key management system — this is a minimal example.
function deriveKey(passphrase: string, salt: string): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, 100_000, 32, "sha256");
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag(); // 128-bit authentication tag

  // Pack as: IV (12) + tag (16) + ciphertext
  const packed = Buffer.concat([iv, tag, encrypted]);
  return packed.toString("base64");
}

function decrypt(packed: string, key: Buffer): string {
  const buf = Buffer.from(packed, "base64");

  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

// --- Usage ---

const key = deriveKey("my-shared-secret", "my-app-salt");

// Store encrypted data
const secret = "sensitive agent payload";
const ciphertext = encrypt(secret, key);

const storeResponse = await fetch(`${REPRAM_URL}/v1/data/my-secret-key`, {
  method: "PUT",
  headers: { "X-TTL": "300" },
  body: ciphertext,
});
console.log("Stored:", storeResponse.status); // 201

// Retrieve and decrypt
const getResponse = await fetch(`${REPRAM_URL}/v1/data/my-secret-key`);
const retrieved = await getResponse.text();
const plaintext = decrypt(retrieved, key);
console.log("Decrypted:", plaintext); // "sensitive agent payload"
```

The node sees base64 gibberish. When the TTL expires, the gibberish is gone. At no point does the network have access to the plaintext.

## Opaque Key Derivation

If key names themselves are sensitive (they reveal what agents are communicating, or what tasks exist), derive keys from a shared secret so the namespace is opaque:

```typescript
function deriveKey(components: string[], secret: string): string {
  const input = components.join(":") + ":" + secret;
  return crypto.createHash("sha256").update(input).digest("hex");
}

// Both agents independently compute the same key:
const key = deriveKey(["task-742", "agent-a", "agent-b"], "our-shared-secret");
// → "a3f8c1..." (deterministic, opaque)

// Agent A stores:
await fetch(`${REPRAM_URL}/v1/data/${key}`, {
  method: "PUT",
  headers: { "X-TTL": "600" },
  body: encrypt("handoff payload", encryptionKey),
});

// Agent B retrieves (computes the same key independently):
const response = await fetch(`${REPRAM_URL}/v1/data/${key}`);
const payload = decrypt(await response.text(), encryptionKey);
```

An observer watching the network sees a SHA-256 hash as the key and base64 noise as the value. They learn nothing about who is communicating, what the task is, or what data was exchanged. The entry self-destructs in 10 minutes.

## Combining with MCP

If you're using the `repram-mcp` tools from an AI agent, encrypt the data string before passing it to `repram_store` and decrypt after `repram_retrieve`:

```
1. Agent encrypts payload → base64 ciphertext
2. Agent calls repram_store(data=ciphertext, key=derived_opaque_key)
3. Other agent calls repram_retrieve(key=derived_opaque_key)
4. Other agent decrypts ciphertext → original payload
```

The MCP server and REPRAM node are both oblivious to the contents. This is the "bring your own security" model: REPRAM provides the ephemeral transport, you provide the confidentiality layer that fits your threat model.
