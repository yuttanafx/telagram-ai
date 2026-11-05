import { createHash, timingSafeEqual } from 'crypto';
import { getUsers } from './store';
function eq(a: string | null | undefined, b: string | undefined) {
  if (!a || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export const isAdmin = (r: Request) => eq(r.headers.get('x-admin-key'), process.env.ADMIN_KEY);
export const isEA = (r: Request) => eq(r.headers.get('x-api-key'), process.env.EA_API_KEY);
export const isWebhook = (r: Request) =>
  eq(r.headers.get('x-api-key') ?? new URL(r.url).searchParams.get('key'), process.env.WEBHOOK_SECRET);

export const hashPw = (p: string) => createHash('sha256').update(p).digest('hex');
export type Who = { role: 'admin' | 'user'; name: string; id?: string; acct: string }; // acct = which trading account's data this person sees ('main' for admin)
// Admin = ADMIN_KEY. User = a password the admin generated (stored only as a hash; passwords are long and random).
export async function whoami(pw?: string | null): Promise<Who | null> {
  if (!pw) return null;
  if (eq(pw, process.env.ADMIN_KEY)) return { role: 'admin', name: 'Admin', acct: 'main' };
  const h = hashPw(pw);
  const u = (await getUsers()).find((x) => eq(x.hash, h));
  return u ? { role: 'user', name: u.name, id: u.id, acct: u.id } : null;
}
export const who = (r: Request) => whoami(r.headers.get('x-admin-key'));

// Admin can look at any account (x-acct header); a user always sees only their own.
export async function pickAcct(r: Request, me: Who): Promise<string> {
  if (me.role !== 'admin') return me.acct;
  const want = r.headers.get('x-acct');
  if (!want || want === 'main') return 'main';
  return (await getUsers()).some((u) => u.id === want) ? want : 'main';
}

// EA authentication. The legacy EA_API_KEY = the main account. A per-account EA key is bound to ONE MT5 account number:
// the EA also sends x-account (its AccountInfoInteger(ACCOUNT_LOGIN)) and it must match.
export type EAAuth = { ok: true; acct: string; login?: string; name: string } | { ok: false; status: number; msg: string };
export async function eaAuth(r: Request): Promise<EAAuth> {
  const key = r.headers.get('x-api-key');
  if (!key) return { ok: false, status: 401, msg: 'unauthorized' };
  if (eq(key, process.env.EA_API_KEY)) return { ok: true, acct: 'main', name: 'Main' };
  const h = hashPw(key);
  const u = (await getUsers()).find((x) => x.keyHash && eq(x.keyHash, h));
  if (!u) return { ok: false, status: 401, msg: 'unauthorized' };
  const login = (r.headers.get('x-account') || '').replace(/\D/g, '');
  if (u.login && login !== u.login) return { ok: false, status: 403, msg: 'account mismatch: this EA key belongs to a different MT5 account' };
  return { ok: true, acct: u.id, login: u.login, name: u.name };
}

// TradingView webhook: "account" = MT5 account number or user id. Missing = main account.
export async function resolveAcct(ref?: string | null): Promise<string | null> {
  const v = (ref ?? '').trim();
  if (!v || v === 'main') return 'main';
  const digits = v.replace(/\D/g, '');
  const u = (await getUsers()).find((x) => x.id === v || (!!x.login && x.login === digits));
  return u ? u.id : null;
}
