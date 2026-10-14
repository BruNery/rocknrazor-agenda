import type { Pool } from 'pg';
import webpush from 'web-push';

export interface StaffMessage { title: string; body: string; url: string; tag: string }
/** Aviso aos barbeiros (não confundir com a notificação ao cliente, em `Notifier`). */
export interface StaffNotifier { notify(employeeId: string, msg: StaffMessage): Promise<void> }
export class FakeStaffNotifier implements StaffNotifier { sent: { employeeId: string; msg: StaffMessage }[] = []; async notify(employeeId: string, msg: StaffMessage) { this.sent.push({ employeeId, msg }); } }

export interface Sub { endpoint: string; keys: { p256dh: string; auth: string } }
/** Envia 1 mensagem a 1 dispositivo. `gone` = o dispositivo já não existe (desinstalou ou revogou). */
export interface PushSender { send(sub: Sub, payload: string): Promise<{ gone: boolean }> }
export class FakePushSender implements PushSender {
  sent: { endpoint: string; payload: any }[] = []; goneEndpoints = new Set<string>(); failEndpoints = new Set<string>();
  async send(sub: Sub, payload: string) { if (this.failEndpoints.has(sub.endpoint)) throw new Error('rede em baixo'); if (this.goneEndpoints.has(sub.endpoint)) return { gone: true }; this.sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); return { gone: false }; }
}
export class WebPushSender implements PushSender {
  constructor(publicKey: string, privateKey: string, subject: string) { webpush.setVapidDetails(subject, publicKey, privateKey); }
  async send(sub: Sub, payload: string) {
    try { await webpush.sendNotification(sub, payload, { TTL: 60 * 60 * 12, urgency: 'high' }); return { gone: false }; }
    catch (e: any) { if (e.statusCode === 404 || e.statusCode === 410) return { gone: true }; throw e; }
  }
}

/** Entrega o aviso a todos os dispositivos ativos do barbeiro. Uma falha nunca estraga a marcação. */
export class PushStaffNotifier implements StaffNotifier {
  constructor(private pool: Pool, private sender: PushSender, private log: (m: string, e?: unknown) => void = () => {}) {}
  async notify(employeeId: string, msg: StaffMessage) {
    const r = await this.pool.query("select s.id, s.endpoint, s.p256dh, s.auth from push_subscriptions s join users u on u.id = s.user_id where u.employee_id = $1 and u.active", [employeeId]);
    await Promise.all(r.rows.map(async row => {
      try {
        const { gone } = await this.sender.send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify(msg));
        if (gone) await this.pool.query('delete from push_subscriptions where id = $1', [row.id]); else await this.pool.query('update push_subscriptions set last_ok = now() where id = $1', [row.id]);
      } catch (e) { this.log('push falhou', e); }
    }));
  }
}

const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
export const fmtWhen = (date: string, startMin: number) => { const wd = new Date(date + 'T00:00:00Z').getUTCDay(); return `${WD[wd]} ${date.slice(8)}/${date.slice(5, 7)} às ${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`; };
