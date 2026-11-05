import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

// Members' own AI API keys are stored encrypted (AES-256-GCM). The secret is KEY_ENC_SECRET if set, otherwise ADMIN_KEY.
// Note: whoever controls the server's environment variables can decrypt them. Changing the secret makes saved keys unreadable (members re-enter them).
let k: Buffer | null = null;
const secret = () => (k ??= scryptSync(process.env.KEY_ENC_SECRET || process.env.ADMIN_KEY || 'signal-hub', 'signalhub-aikeys-v1', 32));

export function seal(plain: string): string {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', secret(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['enc1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
export function unseal(v: string): string {
  if (!v.startsWith('enc1:')) return v; // plain value (never written by this code, tolerated)
  try {
    const [, iv, tag, ct] = v.split(':');
    const d = createDecipheriv('aes-256-gcm', secret(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch { return ''; } // wrong secret / damaged value
}
