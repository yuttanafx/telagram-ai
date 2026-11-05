// Market regime pulled straight from TradingView's public technicals feed (the same ADX / EMA numbers shown on the
// chart's "Technicals" panel). No Pine script, no alert, no webhook: the server asks TradingView on every EA push.
// The feed is unofficial and undocumented, so every failure returns null and the caller falls back to something else.
import { getJSON, setJSON } from './store';
import { symKey } from './regime';

// EA timeframe (M1, M5, M15, M30, H1, H4, D1, W1, MN1) -> TradingView column suffix
const SUFFIX: Record<string, string> = { M1: '|1', M5: '|5', M15: '|15', M30: '|30', H1: '|60', H2: '|120', H4: '|240', D1: '', W1: '|1W', MN1: '|1M' };
const MARKETS = ['forex', 'cfd', 'global'];
// Which exchanges to try for a broker symbol. Override with TV_EXCHANGES="OANDA,FX_IDC,..." (first one that answers wins).
const EXCHANGES = () => (process.env.TV_EXCHANGES ?? 'OANDA,FX_IDC,FOREXCOM,CAPITALCOM').split(',').map((s) => s.trim()).filter(Boolean);
// Optional per-symbol override, e.g. TV_SYMBOL_MAP={"XAUUSD":"OANDA:XAUUSD","BTCUSD":"BITSTAMP:BTCUSD"}
const override = (k: string): string | null => { try { return JSON.parse(process.env.TV_SYMBOL_MAP ?? '{}')[k] ?? null; } catch { return null; } };

// Common broker names that TradingView does not know
const ALIAS: Record<string, string> = { GOLD: 'XAUUSD', SILVER: 'XAGUSD', XAUUSD: 'XAUUSD', USOIL: 'USOIL', UKOIL: 'UKOIL' };

export type TvTech = { ticker: string; adx: number; diPlus: number; diMinus: number; ema20: number; ema50: number; price: number };
const TREND_ADX = 25, RANGE_ADX = 20;

// Same rule as lib/chart.ts and the old Pine script: ADX >= 25 -> trend (direction from EMA20 vs EMA50), ADX < 20 -> range,
// in between keep the previous regime so the answer does not flip back and forth.
export function regimeFromTech(t: Pick<TvTech, 'adx' | 'ema20' | 'ema50'>, prev?: string): 'trend_up' | 'trend_down' | 'range' {
  if (t.adx >= TREND_ADX) return t.ema20 >= t.ema50 ? 'trend_up' : 'trend_down';
  if (t.adx < RANGE_ADX) return 'range';
  return prev === 'trend_up' || prev === 'trend_down' || prev === 'range' ? prev : 'range';
}

export async function fetchTech(symbol: string, tf: string): Promise<TvTech | null> {
  const k0 = symKey(symbol), k = ALIAS[k0] ?? k0, sfx = SUFFIX[tf.toUpperCase()];
  if (sfx === undefined) return null;
  const cacheKey = `tvtech:${k}:${tf.toUpperCase()}`;
  const c = await getJSON<{ ts: number; t: TvTech } | null>(cacheKey, null);
  if (c && Date.now() - c.ts < 60_000) return c.t;           // many accounts, one request per minute per symbol/timeframe
  const tickers = override(k) ? [override(k)!] : EXCHANGES().map((e) => `${e}:${k}`);
  const cols = ['ADX', 'ADX+DI', 'ADX-DI', 'EMA20', 'EMA50', 'close'].map((x) => (x === 'close' ? x : x + sfx));
  for (const m of MARKETS) {
    try {
      const r = await fetch(`${process.env.TV_SCAN_URL ?? "https://scanner.tradingview.com"}/${m}/scan`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
        body: JSON.stringify({ symbols: { tickers }, columns: cols }), signal: AbortSignal.timeout(6_000), cache: 'no-store',
      });
      if (!r.ok) continue;
      const j: { data?: { s: string; d: (number | null)[] }[] } = await r.json();
      const row = j.data?.find((x) => x.d.every((v) => typeof v === 'number' && isFinite(v)));   // first ticker that has real numbers
      if (!row) continue;
      const [adx, diPlus, diMinus, ema20, ema50, price] = row.d as number[];
      const t = { ticker: row.s, adx, diPlus, diMinus, ema20, ema50, price };
      await setJSON(cacheKey, { ts: Date.now(), t });
      return t;
    } catch { /* try the next market */ }
  }
  return null;
}
