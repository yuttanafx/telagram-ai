import { who } from '@/lib/auth';
import { saveLinks, tgApi, tgEnabled } from '@/lib/telegram';
export const dynamic = 'force-dynamic';

// Admin only (header x-admin-key). Body: { "action": "set" | "info" | "delete" | "unlink_all" }
//   set        register https://<this site>/api/telegram as the bot webhook (needs TELEGRAM_BOT_TOKEN + TELEGRAM_WEBHOOK_SECRET)
//   info       show bot name and webhook status
//   delete     remove the webhook
//   unlink_all log every chat out
export async function POST(req: Request) {
  if ((await who(req))?.role !== 'admin') return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!tgEnabled()) return Response.json({ error: 'ยังไม่ได้ตั้ง TELEGRAM_BOT_TOKEN' }, { status: 400 });
  const { action } = await req.json().catch(() => ({ action: 'info' }));
  if (action === 'set') {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) return Response.json({ error: 'ตั้ง TELEGRAM_WEBHOOK_SECRET ก่อน (16 ตัวขึ้นไป ใช้ได้เฉพาะ A-Z a-z 0-9 _ -)' }, { status: 400 });
    const url = `${new URL(req.url).origin}/api/telegram`;
    const r = await tgApi('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
    await tgApi('setMyCommands', { commands: [
      { command: 'menu', description: 'เมนูปุ่มกด' }, { command: 'settings', description: 'ตั้งค่ากริดและ AI' }, { command: 'status', description: 'สถานะระบบและ AI ล่าสุด' }, { command: 'orders', description: 'ออเดอร์ของ EA' }, { command: 'daily', description: 'สรุปยอดรายวัน' },
      { command: 'pause', description: 'หยุดระบบ (ผู้ดูแล)' }, { command: 'resume', description: 'เปิดระบบ (ผู้ดูแล)' },
      { command: 'login', description: 'ผูกแชทกับบัญชี' }, { command: 'logout', description: 'เลิกผูกแชท' }, { command: 'help', description: 'วิธีใช้' } ] });
    return Response.json({ ...r, url });
  }
  if (action === 'delete') return Response.json(await tgApi('deleteWebhook', { drop_pending_updates: true }));
  if (action === 'unlink_all') { await saveLinks({}); return Response.json({ ok: true }); }
  const [me, hook] = await Promise.all([tgApi('getMe'), tgApi('getWebhookInfo')]);
  return Response.json({ bot: me.result?.username ?? me, webhook: hook.result ?? hook });
}
