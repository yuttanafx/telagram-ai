import { z } from 'zod';

// A grid profile = the parameter set of the grid EA (Terravolteco SmartGold) for one kind of market.
export const ProfileSchema = z.object({
  id: z.string().min(1).max(30), name: z.string().min(1).max(40),
  buy: z.boolean(), sell: z.boolean(),
  lot: z.number().min(0.01).max(1), lotMult: z.number().min(1).max(3),
  step: z.number().int().min(50).max(10000), stepW: z.number().min(1).max(5), stepA: z.number().min(1).max(5),
  max: z.number().int().min(1).max(20), tpN: z.number().min(0.5).max(1000), tpO: z.number().min(0.5).max(1000),
  recMult: z.number().min(1).max(3),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const DEFAULT_PROFILES: Record<string, Profile> = {
  trend_buy: { id: 'trend_buy', name: 'Trend Buy', buy: true, sell: false, lot: 0.01, lotMult: 1.5, step: 600, stepW: 1.7, stepA: 3.0, max: 10, tpN: 5, tpO: 20, recMult: 2.0 },
  trend_sell: { id: 'trend_sell', name: 'Trend Sell', buy: false, sell: true, lot: 0.01, lotMult: 1.5, step: 600, stepW: 1.7, stepA: 3.0, max: 10, tpN: 5, tpO: 20, recMult: 2.0 },
  range: { id: 'range', name: 'Range สองฝั่ง', buy: true, sell: true, lot: 0.01, lotMult: 1.3, step: 400, stepW: 1.4, stepA: 2.0, max: 6, tpN: 4, tpO: 8, recMult: 1.5 },
  defensive: { id: 'defensive', name: 'Defensive หยุดเปิดชุดใหม่', buy: false, sell: false, lot: 0.01, lotMult: 1.0, step: 1000, stepW: 2.0, stepA: 3.0, max: 1, tpN: 3, tpO: 5, recMult: 1.0 },
};
export const DEFAULT_GRID_MAP: Record<string, string> = { trend_up: 'trend_buy', trend_down: 'trend_sell', range: 'range', volatile: 'defensive', news: 'defensive' };

// Grid profile for one symbol and regime. A pair can have its own profile set (settings.symGrid, keyed by the first 6 letters/digits
// of the symbol, e.g. XAUUSD); a pair without one uses the shared set.
export function gridFor(s: { gridProfiles: Record<string, Profile>; gridMap: Record<string, string>; symGrid?: Record<string, { profiles: Record<string, Profile>; map: Record<string, string> }> }, symbol: string, regime: string) {
  const k = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const o = s.symGrid?.[k];
  const pid = (o?.map ?? s.gridMap)[regime] ?? DEFAULT_GRID_MAP[regime] ?? 'defensive';
  const prof = (o?.profiles ?? s.gridProfiles)[pid] ?? s.gridProfiles[pid] ?? DEFAULT_PROFILES.defensive;
  return { pid, prof, scoped: !!o };
}

// ---- per-member grid settings -------------------------------------------------------------------------------------------
// A member can override single fields of a profile and re-map a regime to another profile, for HIS OWN account only.
// Anything he does not override falls back to the shared (admin) settings. The admin caps what a member may choose (env vars).
export type GridOverride = { profiles?: Record<string, Partial<Profile>>; map?: Record<string, string> };
const envNum = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const memberLimits = () => ({ lot: envNum(process.env.MEMBER_MAX_LOT, 1), max: envNum(process.env.MEMBER_MAX_ORDERS, 20), lotMult: envNum(process.env.MEMBER_MAX_LOTMULT, 3) });
const clampMember = (p: Profile): Profile => { const L = memberLimits(); return { ...p, lot: Math.min(p.lot, L.lot), max: Math.min(p.max, L.max), lotMult: Math.min(p.lotMult, L.lotMult) }; };

// Same as gridFor, plus the account's own overrides (applied on top of whichever profile set the pair resolves to).
export function gridForAcct(s: Parameters<typeof gridFor>[0], ov: GridOverride | null | undefined, symbol: string, regime: string) {
  const base = gridFor(s, symbol, regime);
  if (!ov || (!ov.profiles && !ov.map)) return { ...base, mine: false };
  const pid = ov.map?.[regime] && s.gridProfiles[ov.map[regime]] ? ov.map[regime] : base.pid;
  const k = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const src = (s.symGrid?.[k]?.profiles ?? s.gridProfiles)[pid] ?? s.gridProfiles[pid] ?? DEFAULT_PROFILES[pid] ?? DEFAULT_PROFILES.defensive;
  const patch = ov.profiles?.[pid];
  const prof = clampMember(patch ? { ...src, ...patch, id: src.id, name: src.name } : src);
  return { pid, prof, scoped: base.scoped, mine: !!patch || pid !== base.pid };
}
