export type Ind = { symbol: string; tf: string; price: number; adx: number; rsi: number; atr: number; ema20: number; ema50: number };
type Cond = { text: string; test: (i: Ind) => boolean };
export type Strategy = { id: string; name: string; regimes: string[]; side: 'BUY' | 'SELL'; conds: Cond[] };

// Add your own strategies here. Each strategy is a list of rules the server checks itself;
// the AI only chooses WHICH strategy fits the market, it never decides entry/exit alone.
export const STRATEGIES: Strategy[] = [
  { id: 'ema_pullback_long', name: 'EMA Pullback (Buy)', regimes: ['trend_up'], side: 'BUY', conds: [
    { text: 'ADX >= 25', test: (i) => i.adx >= 25 },
    { text: 'EMA20 > EMA50', test: (i) => i.ema20 > i.ema50 },
    { text: 'ราคาไม่ไกลจาก EMA20 (ไม่เกิน 1 ATR)', test: (i) => Math.abs(i.price - i.ema20) <= i.atr },
    { text: 'RSI 40-65', test: (i) => i.rsi >= 40 && i.rsi <= 65 } ] },
  { id: 'ema_pullback_short', name: 'EMA Pullback (Sell)', regimes: ['trend_down'], side: 'SELL', conds: [
    { text: 'ADX >= 25', test: (i) => i.adx >= 25 },
    { text: 'EMA20 < EMA50', test: (i) => i.ema20 < i.ema50 },
    { text: 'ราคาไม่ไกลจาก EMA20 (ไม่เกิน 1 ATR)', test: (i) => Math.abs(i.price - i.ema20) <= i.atr },
    { text: 'RSI 35-60', test: (i) => i.rsi >= 35 && i.rsi <= 60 } ] },
  { id: 'range_buy', name: 'Range Reversion (Buy)', regimes: ['range'], side: 'BUY', conds: [
    { text: 'ADX < 20', test: (i) => i.adx < 20 }, { text: 'RSI <= 30', test: (i) => i.rsi <= 30 } ] },
  { id: 'range_sell', name: 'Range Reversion (Sell)', regimes: ['range'], side: 'SELL', conds: [
    { text: 'ADX < 20', test: (i) => i.adx < 20 }, { text: 'RSI >= 70', test: (i) => i.rsi >= 70 } ] },
  { id: 'trend_follow_long', name: 'Trend Follow (Buy)', regimes: ['trend_up'], side: 'BUY', conds: [
    { text: 'ADX >= 25', test: (i) => i.adx >= 25 },
    { text: 'ราคา > EMA20 > EMA50', test: (i) => i.price > i.ema20 && i.ema20 > i.ema50 },
    { text: 'RSI 50-70', test: (i) => i.rsi >= 50 && i.rsi <= 70 } ] },
  { id: 'trend_follow_short', name: 'Trend Follow (Sell)', regimes: ['trend_down'], side: 'SELL', conds: [
    { text: 'ADX >= 25', test: (i) => i.adx >= 25 },
    { text: 'ราคา < EMA20 < EMA50', test: (i) => i.price < i.ema20 && i.ema20 < i.ema50 },
    { text: 'RSI 30-50', test: (i) => i.rsi >= 30 && i.rsi <= 50 } ] },
];
export const STRATEGY_IDS = [...STRATEGIES.map((s) => s.id), 'no_trade'] as unknown as [string, ...string[]];

export function evaluate(s: Strategy, i: Ind) {
  const results = s.conds.map((c) => ({ text: c.text, ok: c.test(i) }));
  return { passed: results.every((r) => r.ok), results };
}

// Market regimes the AI can name, and which strategies are pulled in for each one (editable in the dashboard).
export const REGIMES = ['trend_up', 'trend_down', 'range', 'volatile', 'news'] as const;
export type Regime = (typeof REGIMES)[number];
export const DEFAULT_MAP: Record<string, string[]> = {
  trend_up: ['ema_pullback_long'], trend_down: ['ema_pullback_short'],
  range: ['range_buy', 'range_sell'], volatile: [], news: [],
};
