import { decide } from './ai';
import { ak, getJSON, getMany, setJSON } from './store';
import type { Ind } from './strategies';

type D = Awaited<ReturnType<typeof decide>>;

// One AI call is reused for the same symbol and timeframe within ~80% of the interval, but ONLY inside one account:
// every member pays for their own tokens (own API key), so a result bought by one account is never handed to another.
export async function regimeFor(ind: Ind & { symbol: string; tf: string }, intervalMin: number, acct = 'main'): Promise<D> {
  const k = ak(`regime:${ind.symbol}:${ind.tf}`, acct);
  const c = await getJSON<{ ts: number; d: D } | null>(k, null);
  if (c && Date.now() - c.ts < intervalMin * 48_000) return c.d;
  const d = await decide(ind, acct);
  if (d.confidence > 0) await setJSON(k, { ts: Date.now(), d });
  return d;
}

// ---- One row per symbol an account's EA(s) report: the dashboard lists them so you can see every pair's trend and pick one ----
export type SymRow = { symbol: string; key: string; tf: string; ts: number; regime: string; confidence: number; reason: string; profile?: string; hold?: boolean; price?: number };
// Saving a row costs Redis commands and the EA reports every minute, so: skip the write when nothing visible changed
// (same regime / profile / hold) for 2.5 minutes, and only look at the index when this instance has not seen the pair yet.
const lastRow = ((globalThis as any).__hubrows ??= new Map<string, { sig: string; ts: number }>()) as Map<string, { sig: string; ts: number }>;
const knownIdx = ((globalThis as any).__hubidx ??= new Set<string>()) as Set<string>;
export async function saveSymRow(acct: string, r: Omit<SymRow, 'key'>) {
  const key = r.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const id = acct + ':' + key, sig = [r.tf, r.regime, r.profile, r.hold, Math.round(r.confidence * 100)].join('|'), prev = lastRow.get(id);
  if (!(prev && prev.sig === sig && Date.now() - prev.ts < 150_000)) {
    await setJSON(ak('symrow:' + key, acct), { ...r, key });
    if (lastRow.size > 500) lastRow.clear();
    lastRow.set(id, { sig, ts: Date.now() });
  }
  if (!knownIdx.has(id)) {
    const idx = await getJSON<string[]>(ak('symidx', acct), []);
    if (!idx.includes(key)) await setJSON(ak('symidx', acct), [...idx, key].slice(-30));
    knownIdx.add(id);
  }
}
// `idx` can be passed in when the caller has already read it together with other keys (one MGET).
export async function listSymRows(acct: string, idx?: string[]): Promise<SymRow[]> {
  const ix = idx ?? (await getJSON<string[]>(ak('symidx', acct), []));
  const rows = await getMany<SymRow>(ix.map((k) => ak('symrow:' + k, acct)));
  return rows.filter((x): x is SymRow => !!x).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

// ---- Market regime reported from outside (TradingView alert -> /api/webhook) ----
// Broker symbols differ (XAUUSD, XAUUSDm, XAUUSD.a ...), so both sides are reduced to the first 6 letters/digits.
export const symKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
export type ExtRegime = { regime: string; confidence: number; ts: number; ttl: number };
const extKey = (symbol: string, acct?: string) => ak('xregime:' + symKey(symbol), acct ?? 'all');

// scope: one account, or every account when `acct` is omitted
export async function saveExternalRegime(symbol: string, r: ExtRegime, acct?: string) {
  await setJSON(extKey(symbol, acct), r);
}

// newest still-valid regime for this account (its own signal wins over the all-accounts one when newer)
export async function externalRegime(symbol: string, acct: string): Promise<ExtRegime | null> {
  const [own, all] = await Promise.all([getJSON<ExtRegime | null>(extKey(symbol, acct), null), getJSON<ExtRegime | null>(extKey(symbol), null)]);
  const ok = [own, all].filter((x): x is ExtRegime => !!x && Date.now() - x.ts < x.ttl);
  return ok.sort((a, b) => b.ts - a.ts)[0] ?? null;
}
