import { DEFAULT_GRID_MAP, DEFAULT_PROFILES, ProfileSchema, memberLimits, type GridOverride, type Profile } from './profiles';
import { REGIMES } from './strategies';
import { getAiConf, getGridOverride, hasOwnKey, saveAiConf, saveGridOverride } from './aiconf';
import { getJSON, getSettings, setJSON } from './store';
import { esc, tgSend, type Kb, type TgLink } from './telegram';
import type { Settings } from './types';

// Settings menu of the Telegram bot.
//  - Admin (account 'main'): edits the SHARED settings, exactly like the dashboard (every account that has no override of its own).
//  - Member: edits ONLY his own override of the grid profiles / regime map and his own AI provider and interval, within the admin's limits.
// Every grid change is staged first (old -> new summary) and applied only after the tap on "confirm".
type Me = TgLink;
type Op = { kind: 'prof'; pid: string; patch: Partial<Profile> } | { kind: 'map'; regime: string; pid: string } | { kind: 'reset' };

const LABEL: Record<string, string> = { lot: 'Lot เริ่ม', lotMult: 'Lot x', max: 'Max ไม้', step: 'Step (pts)', stepW: 'Step W', stepA: 'Step A', tpN: 'TP ปกติ $', tpO: 'TP เก่า $', recMult: 'Rec x' };
const FIELDS = Object.keys(LABEL);
const PROVIDERS = ['anthropic', 'openai', 'google'];
const INTERVALS = [5, 15, 30, 60];
export const CFG_KEYS = new Set(['cfg', 'gp', 'p', 'f', 'tg', 'ck', 'cn', 'gm', 'm', 'mp', 'gr', 'ai', 'a']);
const TTL = 120_000;
const isMember = (me: Me) => me.acct !== 'main';
const bk = (to: string, text = '‹ กลับ') => [{ text, callback_data: to }];
const yn = (v: any) => (v ? 'เปิด' : 'ปิด');
const show = (f: string, v: any) => (f === 'buy' || f === 'sell' ? yn(v) : String(v));
const nameOf = (f: string) => (f === 'buy' ? 'Buy' : f === 'sell' ? 'Sell' : LABEL[f] ?? f);

async function load(me: Me) {
  const s = await getSettings();
  const ov: GridOverride | null = isMember(me) ? await getGridOverride(me.acct) : null;
  return { s, ov };
}
const eff = (s: Settings, ov: GridOverride | null, pid: string): Profile | null => {
  const b = s.gridProfiles[pid] ?? DEFAULT_PROFILES[pid];
  if (!b) return null;
  const p = ov?.profiles?.[pid];
  return p ? { ...b, ...p, id: b.id, name: b.name } : b;
};
const mapped = (s: Settings, ov: GridOverride | null, r: string) => (ov?.map?.[r] && s.gridProfiles[ov.map[r]] ? ov.map[r] : s.gridMap[r] ?? DEFAULT_GRID_MAP[r]);

// allowed range of one field (schema bounds, narrowed by the admin's member limits)
function range(field: string, member: boolean): [number, number] {
  let lo = -Infinity, hi = Infinity;
  for (const c of (ProfileSchema.shape as any)[field]?._def?.checks ?? []) { if (c.kind === 'min') lo = c.value; if (c.kind === 'max') hi = c.value; }
  if (member) { const L = memberLimits(); hi = Math.min(hi, field === 'lot' ? L.lot : field === 'max' ? L.max : field === 'lotMult' ? L.lotMult : Infinity); }
  return [lo, hi];
}
function validate(me: Me, base: Profile, patch: Partial<Profile>): string | null {
  const next = { ...base, ...patch };
  if (!ProfileSchema.safeParse(next).success) return 'ค่าไม่ถูกต้อง (ตรวจช่วงค่าที่อนุญาต)';
  if (isMember(me)) for (const f of Object.keys(patch)) { const v = (patch as any)[f]; if (typeof v === 'number') { const [lo, hi] = range(f, true); if (v < lo || v > hi) return `${nameOf(f)} ต้องอยู่ระหว่าง ${lo} ถึง ${hi}`; } }
  return null;
}

/* ---------- screens ---------- */
export async function cfgHome(chatId: string, me: Me) {
  const kb: Kb = [[{ text: 'โปรไฟล์กริด', callback_data: 'gp' }, { text: 'จับคู่สภาพตลาด', callback_data: 'gm' }], [{ text: 'AI: ผู้ให้บริการ/ความถี่', callback_data: 'ai' }]];
  if (isMember(me)) kb.push([{ text: 'รีเซ็ตกลับเป็นค่ากลาง', callback_data: 'gr' }]);
  kb.push(bk('ea', '‹ ตั้งค่า EA'));
  const L = memberLimits();
  return tgSend(chatId, 'ตั้งค่า\n' + (isMember(me)
    ? `แก้ได้เฉพาะบัญชีของคุณ ค่าที่ไม่ได้แก้จะใช้ค่ากลางของผู้ดูแล\nเพดานที่ผู้ดูแลกำหนด: lot ไม่เกิน ${L.lot}, ไม้ไม่เกิน ${L.max}, Lot x ไม่เกิน ${L.lotMult}`
    : 'แก้ค่ากลาง มีผลกับทุกบัญชีที่ไม่ได้ตั้งของตัวเอง (เหมือนหน้า Dashboard)'), kb);
}

async function profileView(chatId: string, me: Me, pid: string) {
  const { s, ov } = await load(me);
  const p = eff(s, ov, pid);
  if (!p) return tgSend(chatId, 'ไม่พบโปรไฟล์นี้', [bk('gp')]);
  const mine = new Set(Object.keys(ov?.profiles?.[pid] ?? {}));
  const star = (f: string) => (mine.has(f) ? '*' : '');
  const text = `${p.name} (${p.id})${mine.size ? '\n* = ค่าที่คุณแก้เอง' : ''}\nBuy: ${yn(p.buy)}${star('buy')}  Sell: ${yn(p.sell)}${star('sell')}\n` +
    FIELDS.map((f) => `${LABEL[f]}: ${(p as any)[f]}${star(f)}`).join('\n') + '\nกดชื่อค่าที่ต้องการแก้ แล้วพิมพ์ตัวเลขใหม่';
  const kb: Kb = [
    [{ text: `Buy: ${yn(p.buy)}`, callback_data: `tg:${pid}:buy` }, { text: `Sell: ${yn(p.sell)}`, callback_data: `tg:${pid}:sell` }],
    ...Array.from({ length: Math.ceil(FIELDS.length / 3) }, (_, i) => FIELDS.slice(i * 3, i * 3 + 3).map((f) => ({ text: `${LABEL[f]}: ${(p as any)[f]}`, callback_data: `f:${pid}:${f}` }))),
    bk('gp'),
  ];
  return tgSend(chatId, text, kb);
}

async function stage(chatId: string, me: Me, op: Op) {
  const { s, ov } = await load(me);
  let lines: string;
  if (op.kind === 'prof') {
    const cur = eff(s, ov, op.pid);
    if (!cur) return tgSend(chatId, 'ไม่พบโปรไฟล์นี้');
    lines = `แก้โปรไฟล์ ${cur.name}\n` + Object.entries(op.patch).map(([f, v]) => `${nameOf(f)}: ${show(f, (cur as any)[f])} → ${show(f, v)}`).join('\n');
  } else if (op.kind === 'map') {
    lines = `สภาพตลาด ${op.regime}: ${s.gridProfiles[mapped(s, ov, op.regime)]?.name ?? '-'} → ${s.gridProfiles[op.pid]?.name ?? op.pid}`;
  } else lines = 'รีเซ็ตการตั้งค่ากริดทั้งหมดของคุณ กลับไปใช้ค่ากลางของผู้ดูแล';
  await setJSON(`tg:cfg:${chatId}`, { op, exp: Date.now() + TTL });
  return tgSend(chatId, `⚠️ <b>ยืนยันการแก้ค่า</b>\n<blockquote>${esc(lines)}</blockquote>\n<i>${isMember(me) ? 'มีผลกับบัญชีของคุณเท่านั้น' : 'มีผลกับทุกบัญชีที่ไม่ได้ตั้งเอง'} EA จะใช้ค่าใหม่ในรอบถัดไป</i>`,
    [[{ text: '✅ ยืนยัน', callback_data: 'ck' }, { text: '❌ ยกเลิก', callback_data: 'cn' }]], true);
}

async function apply(me: Me, op: Op): Promise<string> {
  const { s, ov } = await load(me);
  if (op.kind === 'prof') {
    const base = eff(s, ov, op.pid);
    if (!base) return 'ไม่พบโปรไฟล์นี้';
    const bad = validate(me, base, op.patch);
    if (bad) return bad;
    if (!isMember(me)) {
      const shared = s.gridProfiles[op.pid] ?? DEFAULT_PROFILES[op.pid];
      await setJSON('settings', { ...s, gridProfiles: { ...s.gridProfiles, [op.pid]: ProfileSchema.parse({ ...shared, ...op.patch }) } });
    } else await saveGridOverride(me.acct, { ...ov, profiles: { ...ov?.profiles, [op.pid]: { ...ov?.profiles?.[op.pid], ...op.patch } } });
    return 'บันทึกแล้ว';
  }
  if (op.kind === 'map') {
    if (!(REGIMES as readonly string[]).includes(op.regime) || !s.gridProfiles[op.pid]) return 'ค่าไม่ถูกต้อง';
    if (!isMember(me)) await setJSON('settings', { ...s, gridMap: { ...s.gridMap, [op.regime]: op.pid } });
    else await saveGridOverride(me.acct, { ...ov, map: { ...ov?.map, [op.regime]: op.pid } });
    return 'บันทึกแล้ว';
  }
  if (!isMember(me)) return 'คำสั่งนี้สำหรับสมาชิก';
  await saveGridOverride(me.acct, {});
  return 'รีเซ็ตแล้ว ตอนนี้ใช้ค่ากลางของผู้ดูแลทั้งหมด';
}

/* ---------- button router (callback_data split on ':') ---------- */
export async function cfgButton(chatId: string, me: Me, parts: string[]) {
  const [k, x, y] = parts;
  if (k === 'cfg') return cfgHome(chatId, me);

  if (k === 'gp') {
    const { s, ov } = await load(me);
    return tgSend(chatId, 'เลือกโปรไฟล์กริดที่จะแก้', [...Object.values(s.gridProfiles).map((p) => [{ text: `${p.name}${ov?.profiles?.[p.id] ? ' *' : ''}`, callback_data: `p:${p.id}` }]), bk('cfg')]);
  }
  if (k === 'p') return profileView(chatId, me, x);
  if (k === 'f' || k === 'tg') {
    const { s, ov } = await load(me);
    const cur = eff(s, ov, x);
    const field = y;
    if (!cur || !(k === 'tg' ? field === 'buy' || field === 'sell' : FIELDS.includes(field))) return tgSend(chatId, 'ปุ่มนี้ใช้ไม่ได้ ลองเปิดเมนูใหม่');
    if (k === 'tg') return stage(chatId, me, { kind: 'prof', pid: x, patch: { [field]: !(cur as any)[field] } });
    const [lo, hi] = range(field, isMember(me));
    await setJSON(`tg:edit:${chatId}`, { pid: x, field, exp: Date.now() + TTL });
    return tgSend(chatId, `${cur.name}: ${LABEL[field]} ตอนนี้ ${(cur as any)[field]}\nพิมพ์ค่าใหม่ (ช่วง ${lo} ถึง ${hi}) หรือกดยกเลิก`, [[{ text: '❌ ยกเลิก', callback_data: 'cn' }]]);
  }
  if (k === 'gm') {
    const { s, ov } = await load(me);
    return tgSend(chatId, 'จับคู่สภาพตลาดกับโปรไฟล์ เลือกสภาพตลาดที่จะเปลี่ยน', [...REGIMES.map((r) => [{ text: `${r} → ${s.gridProfiles[mapped(s, ov, r)]?.name ?? '-'}${ov?.map?.[r] ? ' *' : ''}`, callback_data: `m:${r}` }]), bk('cfg')]);
  }
  if (k === 'm') {
    if (!(REGIMES as readonly string[]).includes(x)) return;
    const { s } = await load(me);
    return tgSend(chatId, `สภาพตลาด ${x} ให้ใช้โปรไฟล์ไหน`, [...Object.values(s.gridProfiles).map((p) => [{ text: p.name, callback_data: `mp:${x}:${p.id}` }]), bk('gm')]);
  }
  if (k === 'mp') return stage(chatId, me, { kind: 'map', regime: x, pid: y });
  if (k === 'gr') return isMember(me) ? stage(chatId, me, { kind: 'reset' }) : tgSend(chatId, 'คำสั่งนี้สำหรับสมาชิก');

  if (k === 'ck') {
    const key = `tg:cfg:${chatId}`, p = await getJSON<{ op: Op; exp: number } | null>(key, null);
    if (!p || p.exp < Date.now()) return tgSend(chatId, 'ไม่มีรายการที่รอยืนยัน (หรือหมดเวลาแล้ว)', [bk('cfg', '‹ ตั้งค่า')]);
    await setJSON(key, null); // one-shot
    const msg = await apply(me, p.op);
    return tgSend(chatId, msg, [bk('cfg', '‹ ตั้งค่า')]);
  }
  if (k === 'cn') {
    await Promise.all([setJSON(`tg:cfg:${chatId}`, null), setJSON(`tg:edit:${chatId}`, null)]);
    return tgSend(chatId, 'ยกเลิกแล้ว', [bk('cfg', '‹ ตั้งค่า')]);
  }

  if (k === 'ai' || k === 'a') {
    if (k === 'a') {
      const patch = x === 'p' && PROVIDERS.includes(y) ? { provider: y as any } : x === 'i' && INTERVALS.includes(Number(y)) ? { intervalMin: Number(y) } : null;
      if (!patch) return;
      if (isMember(me)) await saveAiConf(me.acct, patch); else await setJSON('settings', { ...(await getSettings()), ...patch });
    }
    const c = await getAiConf(me.acct);
    return tgSend(chatId, `AI ตอนนี้: ${c.provider} · โมเดล ${c.model || 'ค่าเริ่มต้น'} · วิเคราะห์ทุก ${c.intervalMin} นาที` +
      (isMember(me) ? `\nAPI key ของคุณ: ${(await hasOwnKey(me.acct)) ? 'มีแล้ว' : 'ยังไม่มี (ใส่บนเว็บ ไม่ควรพิมพ์ในแชท)'}\nโมเดลและ API key ตั้งบนเว็บ` : ''),
      [PROVIDERS.map((p) => ({ text: (c.provider === p ? '• ' : '') + p, callback_data: `a:p:${p}` })), INTERVALS.map((i) => ({ text: `${c.intervalMin === i ? '• ' : ''}${i} นาที`, callback_data: `a:i:${i}` })), bk('cfg')]);
  }

}

/* ---------- typed number for "edit this field" ---------- */
export async function cfgValue(chatId: string, me: Me, ed: { pid: string; field: string }, text: string) {
  const v = Number(text.replace(',', '.'));
  if (!text.trim() || !Number.isFinite(v)) return tgSend(chatId, 'พิมพ์เป็นตัวเลข เช่น 0.02 หรือกดยกเลิก', [[{ text: '❌ ยกเลิก', callback_data: 'cn' }]]);
  const { s, ov } = await load(me);
  const base = eff(s, ov, ed.pid);
  if (!base || !FIELDS.includes(ed.field)) return tgSend(chatId, 'ปุ่มนี้ใช้ไม่ได้ ลองเปิดเมนูใหม่');
  const bad = validate(me, base, { [ed.field]: v });
  if (bad) return tgSend(chatId, bad + '\nพิมพ์ค่าใหม่ หรือกดยกเลิก', [[{ text: '❌ ยกเลิก', callback_data: 'cn' }]]);
  await setJSON(`tg:edit:${chatId}`, null);
  return stage(chatId, me, { kind: 'prof', pid: ed.pid, patch: { [ed.field]: v } });
}
