import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
function key(hex: string): Buffer {
  if (!/^[a-f\d]{64}$/i.test(hex))
    throw new Error("TOKEN_ENCRYPTION_KEY must be 64 hex characters");
  return Buffer.from(hex, "hex");
}
// Shared with Python: v1.base64url(nonce[12] + ciphertext + tag[16]).
export function seal(value: unknown, hex: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(hex), nonce);
  cipher.setAAD(Buffer.from("relay-v1"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return "v1." + Buffer.concat([nonce, ciphertext]).toString("base64url");
}
export function unseal<T>(value: string, hex: string): T {
  if (!value.startsWith("v1.")) throw new Error("Invalid encrypted payload");
  const bytes = Buffer.from(value.slice(3), "base64url");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key(hex),
    bytes.subarray(0, 12),
  );
  cipher.setAAD(Buffer.from("relay-v1"));
  cipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(
    Buffer.concat([
      cipher.update(bytes.subarray(12, -16)),
      cipher.final(),
    ]).toString("utf8"),
  ) as T;
}
