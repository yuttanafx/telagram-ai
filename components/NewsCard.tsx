'use client';
import { useState } from 'react';

const when = (ts: number) => new Date(ts).toLocaleString('th-TH', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const clock = (ts: number) => new Date(ts).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
const left = (ts: number) => {
  const m = Math.round((ts - Date.now()) / 60000);
  return m <= 0 ? 'ออกแล้ว/กำลังออก' : m < 60 ? `อีก ${m} นาที` : `อีก ${Math.floor(m / 60)} ชม. ${m % 60} นาที`;
};

// News guard card: shows the guard status and the next high-impact events for the traded currencies.
// Admin can switch the guard, set the window, and start a manual "breaking news" pause.
export default function NewsCard({ news, isAdmin, busy, save }: { news: any; isAdmin: boolean; busy: boolean; save: (body: any) => void }) {
  const [bf, setBf] = useState<number>(news.before);
  const [af, setAf] = useState<number>(news.after);
  const [imp, setImp] = useState<string>(news.impact);
  const active = (news.groups as any[]).find((g) => g.active);
  const manual = news.until && news.until > Date.now();
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>ข่าวแรง · หยุดเทรดก่อนข่าว</h2>
        <span className={'chip ' + (active ? 'no' : news.enabled ? 'ok' : 'no')}>{active ? 'กำลังหยุดเปิดออเดอร์ใหม่' : news.enabled ? 'เฝ้าระวังข่าวอยู่' : 'ปิดการเฝ้าระวัง'}</span>
      </div>
      {news.enabled && news.status === 'error' && <div className="err" role="alert">ดึงปฏิทินข่าวไม่สำเร็จ ({news.error || 'ไม่ทราบสาเหตุ'}) ตอนนี้ระบบ <b>ยังไม่ได้ป้องกันข่าวตามเวลา</b> ใช้ปุ่มหยุดเพราะข่าวด่วนด้านล่างแทนได้</div>}
      {news.enabled && news.status === 'stale' && <div className="mute">ใช้ปฏิทินข่าวที่เก็บไว้ (ดึงข้อมูลใหม่ไม่สำเร็จ: {news.error})</div>}
      {active && <div style={{ fontSize: 15, lineHeight: 1.6 }}>⚠️ <b>{active.active.cur === 'ALL' ? '' : active.active.cur + ' '}{active.active.title}</b> — หยุดเปิดออเดอร์ใหม่ของ {(news.groups as any[]).filter((g) => g.active).map((g) => g.symbol).join(', ')} จนถึง {clock(active.resumeAt)} (ออเดอร์ที่เปิดอยู่แล้วไม่ถูกปิด)</div>}
      {!active && news.enabled && news.status !== 'error' && (news.upcoming.length ? null : <div className="mute">ไม่มีข่าวแรงของสกุลเงินที่เทรดใน 24 ชั่วโมงข้างหน้า</div>)}
      {!!news.upcoming.length && <div style={{ display: 'grid', gap: 8, fontSize: 14 }}>
        {(news.upcoming as any[]).map((e) => (
          <div key={e.cur + e.title + e.ts} className="row" style={{ justifyContent: 'space-between' }}>
            <span><span className={'chip ' + (e.impact === 'High' ? 'no' : 'ok')}>{e.cur}</span> {e.title}{e.forecast ? <span className="mute"> · คาด {e.forecast}{e.previous ? ` / ก่อนหน้า ${e.previous}` : ''}</span> : null}</span>
            <span className="mute">{when(e.ts)} · {left(e.ts)}</span>
          </div>
        ))}
      </div>}
      <div className="mute">เวลาตามเครื่องของคุณ · ครอบคลุมข่าวที่มีกำหนดเวลาในปฏิทิน ส่วนข่าวด่วนที่ไม่มีกำหนด ให้กดหยุดเอง</div>
      {isAdmin && <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12, display: 'grid', gap: 10 }}>
        <div className="row">
          <button className={'btn ' + (news.enabled ? 'main' : '')} aria-pressed={news.enabled} disabled={busy} onClick={() => save({ newsOn: !news.enabled })}>{news.enabled ? 'หยุดเทรดช่วงข่าว: เปิด' : 'หยุดเทรดช่วงข่าว: ปิด'}</button>
          <label className="sub" htmlFor="nbf">ก่อนข่าว</label>
          <select id="nbf" value={bf} onChange={(e) => setBf(Number(e.target.value))}>{[10, 15, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{m} นาที</option>)}</select>
          <label className="sub" htmlFor="naf">หลังข่าว</label>
          <select id="naf" value={af} onChange={(e) => setAf(Number(e.target.value))}>{[10, 15, 30, 45, 60].map((m) => <option key={m} value={m}>{m} นาที</option>)}</select>
          <label className="sub" htmlFor="nim">ระดับข่าว</label>
          <select id="nim" value={imp} onChange={(e) => setImp(e.target.value)}><option value="High">แรงมาก (High)</option><option value="Medium">แรงมาก + ปานกลาง</option></select>
          <button className="btn main" disabled={busy} onClick={() => save({ newsBefore: bf, newsAfter: af, newsImpact: imp })}>บันทึก</button>
        </div>
        <div className="row">
          <span className="sub">ข่าวด่วน (ไม่มีในปฏิทิน):</span>
          {manual
            ? <><span className="chip no">หยุดอยู่จนถึง {clock(news.until)}</span><button className="btn" disabled={busy} onClick={() => save({ newsUntil: 0 })}>ยกเลิกการหยุด</button></>
            : [30, 60, 120].map((m) => <button key={m} className="btn warn" disabled={busy} onClick={() => save({ newsUntil: Date.now() + m * 60_000 })}>หยุดเปิดออเดอร์ใหม่ {m} นาที</button>)}
        </div>
      </div>}
    </section>
  );
}
