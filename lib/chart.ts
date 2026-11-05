// Candles sent by the EA (broker data) -> indicators -> market regime, all by fixed rules (no AI, no external feed).
export type Bar = [number, number, number, number, number]; // [time(sec), open, high, low, close], oldest first

export function ema(v: number[], n: number): number[] {
  const k = 2 / (n + 1), out: number[] = [];
  v.forEach((x, i) => out.push(i === 0 ? x : x * k + out[i - 1] * (1 - k)));
  return out;
}

// Wilder ADX / ATR (same as the common indicators). Returns the latest value and the ATR series.
export function adxAtr(bars: Bar[], n = 14): { adx: number; atr: number; atrs: number[] } | null {
  if (bars.length < n * 2 + 2) return null;
  const tr: number[] = [], pdm: number[] = [], mdm: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const [, , h, l] = bars[i], [, , ph, pl, pc] = bars[i - 1];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  const sum = (a: number[], s: number, e: number) => a.slice(s, e).reduce((x, y) => x + y, 0);
  let t = sum(tr, 0, n), p = sum(pdm, 0, n), m = sum(mdm, 0, n);
  const atrs = [t / n], dx: number[] = [];
  const dxAt = () => { const pi = (100 * p) / t, mi = (100 * m) / t; return pi + mi === 0 ? 0 : (100 * Math.abs(pi - mi)) / (pi + mi); };
  dx.push(dxAt());
  for (let i = n; i < tr.length; i++) {
    t = t - t / n + tr[i]; p = p - p / n + pdm[i]; m = m - m / n + mdm[i];
    atrs.push(t / n); dx.push(dxAt());
  }
  if (dx.length < n) return null;
  let adx = dx.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < dx.length; i++) adx = (adx * (n - 1) + dx[i]) / n;
  return { adx, atr: atrs[atrs.length - 1], atrs };
}

export type ChartRegime = { regime: 'trend_up' | 'trend_down' | 'range' | 'volatile'; adx: number; ema20: number; ema50: number; atr: number };
const TREND_ADX = 25, RANGE_ADX = 20, SPIKE = 1.8;

// volatile: ATR is far above its recent average. trend: ADX >= 25 and EMA20 vs EMA50. range: ADX < 20.
// Between 20 and 25 the previous regime is kept, so the answer does not flip back and forth.
export function regimeFromBars(bars: Bar[], prev?: string): ChartRegime | null {
  const closes = bars.map((b) => b[4]);
  const a = adxAtr(bars);
  if (!a || bars.length < 60) return null;
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  const f = e20[e20.length - 1], s = e50[e50.length - 1];
  const recent = a.atrs.slice(-50);
  const avg = recent.reduce((x, y) => x + y, 0) / recent.length;
  let regime: ChartRegime['regime'];
  if (avg > 0 && a.atr > SPIKE * avg) regime = 'volatile';
  else if (a.adx >= TREND_ADX) regime = f >= s ? 'trend_up' : 'trend_down';
  else if (a.adx < RANGE_ADX) regime = 'range';
  else regime = prev === 'trend_up' || prev === 'trend_down' || prev === 'range' ? prev : 'range';
  return { regime, adx: a.adx, ema20: f, ema50: s, atr: a.atr };
}
