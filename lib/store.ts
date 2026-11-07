import { Redis } from '@upstash/redis';
import { randomUUID } from 'crypto';
import type { Cmd, Mkt, Settings } from './types';
import { riskCheck } from './risk';
import { DEFAULT_MAP } from './strategies';
import { DEFAULT_GRID_MAP, DEFAULT_PROFILES } from './profiles';

// The Vercel / Upstash integration may add a custom prefix to the variable names (e.g. STORAGE_KV_REST_API_URL), so also accept any *KV_REST_API_URL / *KV_REST_API_TOKEN
// (the read-only token ends with KV_REST_API_READ_ONLY_TOKEN and is deliberately not matched, because this app writes).
const pickEnv = (re: RegExp) => { const k = Object.keys(process.env).find((n) => re.test(n) && process.env[n]); return k ? process.env[k] : undefined; };
const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? pickEnv(/KV_REST_API_URL$/);
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? pickEnv(/KV_REST_API_TOKEN$/);
const redis = url && token ? new Redis({ url, token }) : null;
const mem: Record<string, any> = ((globalThis as any).__hubmem ??= {});

// Redis commands are the scarce resource (Upstash bills / limits per command), so reads are cheap on purpose:
//  - getJSON(k, d, ttlMs): optional short cache inside this server instance for data that rarely changes
//    (settings, users, keys ...). A write through setJSON drops the cached copy at once on this instance; other
//    warm instances may serve the old copy for at most ttlMs.
//  - getMany(): one MGET for many keys instead of one GET each.
//  - every(key, ms): per-instance throttle for bookkeeping writes (EA "last seen", chart candles ...).
const memo = ((globalThis as any).__hubmemo ??= new Map<string, { v: any; exp: number }>()) as Map<string, { v: any; exp: number }>;
const gate = ((globalThis as any).__hubgate ??= new Map<string, number>()) as Map<string, number>;
const stat = ((globalThis as any).__hubcmds ??= { n: 0 }) as { n: number };
export const redisCmds = () => stat.n; // commands issued by this server instance since it started
export function every(key: string, ms: number): boolean {
  const now = Date.now();
  if (now - (gate.get(key) ?? 0) < ms) return false;
  if (gate.size > 2000) gate.clear();
  gate.set(key, now);
  return true;
}
export async function getJSON<T>(k: string, d: T, ttlMs = 0): Promise<T> {
  if (ttlMs) { const h = memo.get(k); if (h && h.exp > Date.now()) return structuredClone(h.v) as T; }
  stat.n++;
  const v = (redis ? ((await redis.get<T>(k)) ?? d) : ((mem[k] as T) ?? d)) as T;
  if (ttlMs) { if (memo.size > 500) memo.clear(); memo.set(k, { v: structuredClone(v), exp: Date.now() + ttlMs }); }
  return v;
}
export async function setJSON(k: string, v: any) {
  stat.n++;
  memo.delete(k);
  if (redis) await redis.set(k, v); else mem[k] = v;
}
export async function getMany<T = any>(keys: string[]): Promise<(T | null)[]> {
  if (!keys.length) return [];
  stat.n++;
  if (redis) return ((await redis.mget<(T | null)[]>(...keys)) ?? []).map((x) => x ?? null);
  return keys.map((k) => (mem[k] as T) ?? null);
}

export const defaultSettings = (): Settings => ({
  provider: (process.env.AI_PROVIDER as Settings['provider']) || 'anthropic', model: '', paused: false, intervalMin: 15, regimeSource: 'ai', holdSec: 15, newsOn: true, newsBefore: 30, newsAfter: 15, newsImpact: 'High', newsUntil: 0, map: DEFAULT_MAP, gridProfiles: DEFAULT_PROFILES, gridMap: DEFAULT_GRID_MAP,
});
export const getSettings = async () => ({ ...defaultSettings(), ...(await getJSON<Partial<Settings>>('settings', {}, 10_000)) });
// Every trading account has its own queue, latest decision, throttle timers and voice flag.
// 'main' = the admin's own account (EA_API_KEY) and keeps the original key names, so existing data keeps working.
export const ak = (base: string, acct = 'main') => (acct === 'main' ? base : `${base}:${acct}`);
export const getCmds = (acct = 'main') => getJSON<Cmd[]>(ak('cmds', acct), []);
export const saveCmds = (c: Cmd[], acct = 'main') => setJSON(ak('cmds', acct), c.slice(0, 200));

// Adds a command to the queue after risk checks. Blocked commands are kept for the log.
export async function addCmd(p: Pick<Cmd, 'symbol' | 'side' | 'lot' | 'sl' | 'tp' | 'source'> & { mkt?: Mkt; noHold?: boolean }, acct = 'main'): Promise<Cmd> {
  const cmds = await getCmds(acct);
  const settings = await getSettings();
  let reason: string | null = settings.paused ? 'ระบบถูกหยุดชั่วคราว' : null;
  if (!reason) { // news guard: no NEW orders around high-impact news (fail-open: a calendar problem never blocks order intake)
    try { const { newsFor, newsText } = await import('./news'); const n = await newsFor(p.symbol, settings); if (n.active) reason = newsText(n); } catch {}
  }
  if (!reason) reason = riskCheck(p, cmds);
  if (!reason && p.source === 'ai') {
    const dup = cmds.find((c) => c.symbol === p.symbol && c.side === p.side && Date.now() - c.ts < Math.max(10, settings.intervalMin) * 60_000 && c.status !== 'blocked' && c.status !== 'failed');
    if (dup) reason = 'มีคำสั่งเดียวกันในช่วงเวลาที่กันซ้ำ';
  }
  const cmd: Cmd = { id: randomUUID().slice(0, 8), ts: Date.now(), status: reason ? 'blocked' : 'pending', note: reason ?? undefined, ...p };
  // Hold the order briefly ONLY while a dashboard with voice alerts is open (it pings /api/state?voice=1),
  // so the spoken market summary comes before the EA receives the order. Nobody listening = no delay.
  if (!reason && settings.holdSec > 0 && !p.noHold) {
    const voiceAt = await getJSON<number>(ak('voiceAt', acct), 0);
    if (Date.now() - voiceAt < 20_000) cmd.holdUntil = Date.now() + settings.holdSec * 1000;
  }
  delete (cmd as any).noHold;
  await saveCmds([cmd, ...cmds], acct);
  try { const { notifyCmd } = await import('./telegram'); await notifyCmd(cmd, acct); } catch {} // Telegram alert (no-op when the bot is not configured)
  return cmd;
}

// AI provider keys entered from the dashboard. Env vars are used as a fallback.
export type Keys = Partial<Record<Settings['provider'], string>>;
const ENV_KEY: Record<Settings['provider'], string | undefined> = {
  get anthropic() { return process.env.ANTHROPIC_API_KEY; },
  get openai() { return process.env.OPENAI_API_KEY; },
  get google() { return process.env.GOOGLE_GENERATIVE_AI_API_KEY; },
};
export const getStoredKeys = () => getJSON<Keys>('apikeys', {}, 10_000);
export async function getKeys(): Promise<Keys> {
  const saved = await getStoredKeys();
  return { anthropic: saved.anthropic || ENV_KEY.anthropic, openai: saved.openai || ENV_KEY.openai, google: saved.google || ENV_KEY.google };
}

import type { User } from './types';
export const getUsers = () => getJSON<User[]>('users', [], 10_000);
export const saveUsers = (u: User[]) => setJSON('users', u);
