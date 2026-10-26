import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/** AES-256-GCM with a key derived from APP_SECRET. Used so Google tokens are never stored in plaintext. */
const key = (secret: string) => Buffer.from(hkdfSync('sha256', secret, 'study-helper', 'token-encryption', 32));

export function encryptJson(value: unknown, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(secret), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decryptJson<T>(blob: string, secret: string): T {
  const [v, iv, tag, data] = blob.split('.');
  if (v !== 'v1') throw new Error('unknown token format');
  const d = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8')) as T;
}

export const sha256b64url = (s: string) => createHash('sha256').update(s).digest('base64url');
export const randomToken = (n = 32) => randomBytes(n).toString('base64url');
