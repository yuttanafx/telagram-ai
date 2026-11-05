import type { Cmd } from './types';
export function riskCheck(c: { symbol: string; lot: number }, cmds: Cmd[]): string | null {
  const maxLot = Number(process.env.MAX_LOT ?? 0.1);
  if (!(c.lot > 0) || c.lot > maxLot) return `lot ต้องอยู่ระหว่าง 0 ถึง ${maxLot}`;
  const allow = (process.env.ALLOWED_SYMBOLS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (allow.length && !allow.includes(c.symbol.toUpperCase())) return 'symbol ไม่อยู่ในรายการที่อนุญาต';
  if (cmds.filter((x) => x.status === 'pending' || x.status === 'sent').length >= 10) return 'คิวค้างเกิน 10 คำสั่ง';
  return null;
}
