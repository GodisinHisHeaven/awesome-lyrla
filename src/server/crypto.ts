import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { StoredTokenEnvelope } from './store.js';

function encryptionKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function encryptJson(value: unknown, secret: string): StoredTokenEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptJson<T>(envelope: StoredTokenEnvelope, secret: string): T {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(secret),
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  const cleartext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(cleartext.toString('utf8')) as T;
}
