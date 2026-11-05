'use client';
import { ema, type Bar } from '@/lib/chart';

const REGIME_TH: Record<string, string> = { trend_up: 'แนวโน้มขาขึ้น', trend_down: 'แนวโน้มขาลง', range: 'ไซด์เวย์', volatile: 'ผันผวน', news: 'ช่วงข่าว' };
const REGIME_COLOR: Record<string, string> = { trend_up: 'var(--up)', trend_down: 'var(--down)', range: 'var(--accent)', volatile: 'var(--warn)', news: 'var(--warn)' };

// Candlestick chart drawn from the candles the EA sends (broker data), with EMA20 / EMA50 and the current regime.
export default function ChartCard({ chart, symbol, tf, regime }: { chart: { ts: number; bars: Bar[] }; symbol: string; tf: string; regime?: string }) {
  const all = chart.bars;
  const closes = all.map((b) => b[4]);
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  const N = Math.min(90, all.length), off = all.length - N;
  const bars = all.slice(off), f = e20.slice(off), s = e50.slice(off);
  const W = 640, H = 280, PL = 8, PR = 64, PT = 34, PB = 14;
  const hi = Math.max(...bars.map((b) => b[2]), ...f, ...s), lo = Math.min(...bars.map((b) => b[3]), ...f, ...s);
  const pad = (hi - lo) * 0.06 || 1;
  const y = (v: number) => PT + ((hi + pad - v) / (hi - lo + pad * 2)) * (H - PT - PB);
  const step = (W - PL - PR) / N, bw = Math.max(2, step * 0.6);
  const x = (i: number) => PL + step * i + step / 2;
  const line = (a: number[]) => a.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = bars[bars.length - 1], lastC = last[4];
  const ageMin = Math.max(0, Math.round((Date.now() - chart.ts) / 60_000));
  const digits = lastC >= 100 ? 2 : 5;
  const summary = `${symbol} ${tf} แท่งล่าสุดปิดที่ ${lastC.toFixed(digits)} สภาพตลาด ${regime ? REGIME_TH[regime] ?? regime : 'ยังไม่ระบุ'} ข้อมูลอายุ ${ageMin} นาที`;
  const rc = regime ? REGIME_COLOR[regime] ?? 'var(--mute)' : 'var(--mute)';
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => lo - pad + (hi - lo + pad * 2) * t);

  return (
    <section className="card">
      <h2>กราฟจาก EA <span className="mute">{symbol} · {tf} · ข้อมูลเมื่อ {ageMin} นาทีที่แล้ว</span></h2>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} style={{ width: '100%', height: 'auto' }}>
        <title>{summary}</title>
        <rect x={PL} y={PT} width={W - PL - PR} height={H - PT - PB} fill={rc} opacity={0.06} />
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={W - PR + 6} y={y(t) + 4} fontSize={11} fill="var(--mute)">{t.toFixed(digits)}</text>
          </g>
        ))}
        {bars.map((b, i) => {
          const up = b[4] >= b[1], c = up ? 'var(--up)' : 'var(--down)';
          return (
            <g key={b[0]}>
              <line x1={x(i)} x2={x(i)} y1={y(b[2])} y2={y(b[3])} stroke={c} strokeWidth={1} />
              <rect x={x(i) - bw / 2} y={Math.min(y(b[1]), y(b[4]))} width={bw} height={Math.max(1, Math.abs(y(b[1]) - y(b[4])))} fill={c} />
            </g>
          );
        })}
        <path d={line(f)} fill="none" stroke="var(--accent)" strokeWidth={1.6} />
        <path d={line(s)} fill="none" stroke="var(--warn)" strokeWidth={1.6} />
        <line x1={PL} x2={W - PR} y1={y(lastC)} y2={y(lastC)} stroke={rc} strokeDasharray="4 3" strokeWidth={1} />
        <rect x={W - PR + 2} y={y(lastC) - 9} width={PR - 4} height={18} rx={4} fill={rc} />
        <text x={W - PR + 6} y={y(lastC) + 4} fontSize={11} fontWeight={700} fill="var(--bg)">{lastC.toFixed(digits)}</text>
        <text x={PL + 4} y={20} fontSize={13} fontWeight={700} fill={rc}>{regime ? REGIME_TH[regime] ?? regime : 'ยังไม่ระบุสภาพตลาด'}</text>
        <text x={PL + 170} y={20} fontSize={11} fill="var(--accent)">— EMA20</text>
        <text x={PL + 232} y={20} fontSize={11} fill="var(--warn)">— EMA50</text>
      </svg>
    </section>
  );
}
