import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function key(purpose: string): Buffer {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret || secret.length < 16) throw new Error("ACCOUNT_SECURITY_KEY_UNAVAILABLE");
  return createHmac("sha256", secret).update(`campus-account-security-v1:${purpose}`).digest();
}

// A random challenge id and server key produce a retry-stable token. Only its
// digest is persisted; notification payloads never contain the bearer token.
export function challengeToken(id: string, purpose: string): string {
  return createHmac("sha256", key("challenge")).update(`${purpose}:${id}`).digest("base64url");
}
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function equalDigest(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function encryptMfa(secret: string, userId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key("mfa"), iv);
  cipher.setAAD(Buffer.from(userId));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}
export function decryptMfa(encrypted: string, userId: string): string {
  const raw = Buffer.from(encrypted, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key("mfa"), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function newTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  return bits.match(/.{5}/g)!.map((value) => alphabet[parseInt(value, 2)]).join("");
}
export function totpCode(secret: string, counter: number, digits = 6): string {
  if (!/^[A-Z2-7]+$/.test(secret)) throw new Error("INVALID_TOTP_SECRET");
  const bits = [...secret].map((c) => alphabet.indexOf(c).toString(2).padStart(5, "0")).join("");
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((v) => parseInt(v, 2)));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", bytes).update(message).digest();
  const offset = mac[mac.length - 1] & 15;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).toString().padStart(digits, "0");
}
export function matchTotpCounter(secret: string, code: string, lastCounter: bigint | null, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const counter = Math.floor(now / 30_000);
  for (const candidate of [counter, counter - 1, counter + 1]) {
    if (candidate < 0 || (lastCounter !== null && BigInt(candidate) <= lastCounter)) continue;
    if (timingSafeEqual(Buffer.from(code), Buffer.from(totpCode(secret, candidate)))) return candidate;
  }
  return null;
}
