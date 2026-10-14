import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { localToEpochMs } from '@rr/domain';
import { buildApp } from '../src/app';
import { FakeNotifier } from '../src/service';
import { PushStaffNotifier, FakePushSender } from '../src/push';
import { hashPassword } from '../src/auth';
import { freshDb } from './helpers';

const D = '2026-10-15'; const NOW = localToEpochMs('2026-10-14', 8 * 60);
let pool: Awaited<ReturnType<typeof freshDb>>, app: ReturnType<typeof buildApp>, sender: FakePushSender;
const PW = 'uma-palavra-passe-boa';
const logins: Record<string, string> = {};
const sub = (n: string) => ({ endpoint: `https://push.exemplo.test/${n}`, keys: { p256dh: 'p256dh-chave-de-teste-' + n, auth: 'auth-chave-' + n } });
const login = async (u: string) => (logins[u] = ((await app.inject({ method: 'POST', url: '/auth/login', payload: { username: u, password: PW } })).headers['set-cookie'] as string).split(';')[0]);
const subscribe = (u: string, n: string) => app.inject({ method: 'POST', url: '/push/subscribe', headers: { cookie: logins[u] }, payload: sub(n) });
const online = (employeeId: string, startMin: number, name = 'Rui Teste') => app.inject({ method: 'POST', url: '/public/bookings', payload: { customer: { name, phone: '912345678' }, date: D, startMin, serviceIds: ['corte'], employeeId } });

beforeEach(async () => {
  pool = await freshDb(); sender = new FakePushSender();
  app = buildApp(pool, new FakeNotifier(), () => NOW, { staff: new PushStaffNotifier(pool, sender), vapidPublicKey: 'CHAVE_PUBLICA' });
  for (const [u, role, emp] of [['admin', 'admin', null], ['andre', 'barber', 'a'], ['marcos', 'barber', 'b']] as const) await pool.query('insert into users(username, password_hash, role, employee_id) values ($1,$2,$3,$4)', [u, await hashPassword(PW), role, emp]);
  for (const u of ['admin', 'andre', 'marcos']) await login(u);
});
afterAll(async () => { await pool?.end(); });

describe('Avisos no telemóvel', () => {
  it('só quem tem sessão regista um telemóvel; a chave pública é pública; endpoint tem de ser https', async () => {
    expect((await app.inject({ url: '/push/key' })).json().key).toBe('CHAVE_PUBLICA');
    expect((await app.inject({ method: 'POST', url: '/push/subscribe', payload: sub('x') })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/push/subscribe', headers: { cookie: logins.andre }, payload: { ...sub('x'), endpoint: 'http://inseguro.test/x' } })).statusCode).toBe(400);
    expect((await subscribe('andre', 'x')).statusCode).toBe(200); expect((await subscribe('andre', 'x')).statusCode).toBe(200); // repetir não duplica
    expect((await pool.query('select count(*)::int n from push_subscriptions')).rows[0].n).toBe(1);
  });
  it('nova marcação online: só o barbeiro escolhido recebe o aviso, em todos os seus telemóveis', async () => {
    await subscribe('andre', 'andre-telemovel'); await subscribe('andre', 'andre-tablet'); await subscribe('marcos', 'marcos-telemovel');
    expect((await online('a', 660)).statusCode).toBe(200);
    expect(sender.sent.map(s => s.endpoint).sort()).toEqual(['https://push.exemplo.test/andre-tablet', 'https://push.exemplo.test/andre-telemovel']);
    expect(sender.sent[0].payload).toMatchObject({ title: 'Nova marcação', body: 'Rui Teste · qui 15/10 às 11:00 · Corte', url: `/?dia=${D}` });
  });
  it('o cliente cancelar avisa o barbeiro; o próprio barbeiro não é avisado das suas ações; o admin a mexer avisa o barbeiro', async () => {
    await subscribe('andre', 'andre-telemovel');
    const id = (await online('a', 660)).json().bookingId; sender.sent.length = 0;
    expect((await app.inject({ method: 'POST', url: `/public/bookings/${id}/cancel` })).statusCode).toBe(200);
    expect(sender.sent.length).toBe(1); expect(sender.sent[0].payload.title).toBe('Marcação cancelada'); sender.sent.length = 0;
    const mk = (u: string, startMin: number) => app.inject({ method: 'POST', url: '/hq/bookings', headers: { cookie: logins[u] }, payload: { employeeId: 'a', date: D, startMin, endMin: startMin + 40, serviceIds: ['corte'], notify: false } });
    expect((await mk('andre', 700)).statusCode).toBe(200); expect(sender.sent.length).toBe(0); // fez ele mesmo
    const bid = (await mk('admin', 800)).json().bookingId; expect(sender.sent.length).toBe(1); sender.sent.length = 0; // admin criou na agenda dele
    await app.inject({ method: 'POST', url: `/hq/bookings/${bid}/reschedule`, headers: { cookie: logins.admin }, payload: { date: D, startMin: 900, notify: false } });
    expect(sender.sent[0].payload.title).toBe('Marcação reagendada'); expect(sender.sent[0].payload.body).toContain('15:00');
  });
  it('dispositivos revogados (410) são apagados; falhas de rede não estragam a marcação', async () => {
    await subscribe('andre', 'morto'); await subscribe('andre', 'vivo'); await subscribe('andre', 'falha');
    sender.goneEndpoints.add('https://push.exemplo.test/morto'); sender.failEndpoints.add('https://push.exemplo.test/falha');
    const r = await online('a', 660); expect(r.statusCode).toBe(200); // a marcação fica feita
    expect((await pool.query('select endpoint from push_subscriptions order by endpoint')).rows.map(x => x.endpoint)).toEqual(['https://push.exemplo.test/falha', 'https://push.exemplo.test/vivo']);
    expect(sender.sent.map(s => s.endpoint)).toEqual(['https://push.exemplo.test/vivo']);
  });
  it('conta desativada deixa de receber avisos; sair do telemóvel (unsubscribe) também; um utilizador não apaga o telemóvel de outro', async () => {
    await subscribe('andre', 'a1'); await subscribe('marcos', 'm1');
    expect((await app.inject({ method: 'POST', url: '/push/unsubscribe', headers: { cookie: logins.marcos }, payload: { endpoint: sub('a1').endpoint } })).statusCode).toBe(200);
    expect((await pool.query('select count(*)::int n from push_subscriptions')).rows[0].n).toBe(2); // o de André continua
    await pool.query("update users set active = false where username = 'andre'");
    await online('a', 660); expect(sender.sent.length).toBe(0);
    await app.inject({ method: 'POST', url: '/push/unsubscribe', headers: { cookie: logins.marcos }, payload: { endpoint: sub('m1').endpoint } });
    expect((await pool.query('select count(*)::int n from push_subscriptions')).rows[0].n).toBe(1);
  });
  it('o telemóvel passa para o utilizador que fez login a seguir (telemóvel partilhado)', async () => {
    await subscribe('andre', 'partilhado'); await subscribe('marcos', 'partilhado');
    await online('a', 660); expect(sender.sent.length).toBe(0);
    await online('b', 700, 'Outro'); expect(sender.sent.length).toBe(1);
  });
});
