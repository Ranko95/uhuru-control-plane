import { createHash } from 'node:crypto';

export const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest();
export function secret(raw: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const bytes = Buffer.from(raw, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === raw
    ? bytes
    : null;
}
