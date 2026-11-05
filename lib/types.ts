export type Mkt = { regime: string; confidence: number; strategy: string; reason: string; tf: string; ts: number; ind: { price: number; adx: number; rsi: number; atr: number; ema20: number; ema50: number } };
export type Cmd = {
  id: string; ts: number; symbol: string; side: 'BUY' | 'SELL'; lot: number;
  sl?: number; tp?: number; status: 'pending' | 'sent' | 'done' | 'failed' | 'blocked';
  source: 'webhook' | 'ai' | 'manual'; ticket?: number; price?: number; note?: string;
  holdUntil?: number; mkt?: Mkt; // holdUntil: EA does not receive the order before this time (lets the dashboard read out a market summary first)
};
export type Settings = { holdSec: number; newsOn: boolean; newsBefore: number; newsAfter: number; newsImpact: 'High' | 'Medium'; newsUntil: number; provider: 'anthropic' | 'openai' | 'google'; model: string; paused: boolean; intervalMin: number; regimeSource: 'ai' | 'chart' | 'tradingview' | 'webhook' | 'both'; map: Record<string, string[]>; gridProfiles: Record<string, import('./profiles').Profile>; gridMap: Record<string, string>; symGrid?: Record<string, { profiles: Record<string, import('./profiles').Profile>; map: Record<string, string> }> };
export type User = { id: string; name: string; hash: string; createdAt: number; lastSeen?: number; login?: string; keyHash?: string }; // login = the one MT5 account number this user's EA may use, keyHash = hash of that account's EA key
