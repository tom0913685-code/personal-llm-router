import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// @article topic:credential-encryption
// api_key 加密方案，對齊 provider-adapter-spec.md：AES-256-GCM（自帶
// authentication tag，可偵測密文被竄改）+ 本機 .env 的 ENCRYPTION_KEY，
// 寫入 DB 前加密，讀取解密後只留在記憶體，不落地、不寫 log。見
// docs/article-notes.md。

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM 建議用 12 bytes IV

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error('ENCRYPTION_KEY is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars), got ${key.length} bytes`);
  }
  return key;
}

// 密文格式：iv:authTag:ciphertext，皆為 hex，方便存成單一 TEXT 欄位。
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decrypt(payload: string): string {
  const key = getKey();
  const [ivHex, authTagHex, ciphertextHex] = payload.split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('Malformed encrypted payload');
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
  return plaintext.toString('utf8');
}
