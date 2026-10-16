import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { localToEpochMs } from '@rr/domain';
import { buildApp } from '../src/app';
import { FakeNotifier } from '../src/service';
import { freshDb } from './helpers';

const D = '2026-10-14'; const NOW = localToEpochMs(D, 8 * 60);
let pool: Awaited<ReturnType<typeof freshDb>>, app: ReturnType<typeof buildApp>;
beforeEach(async () => { pool = await freshDb(); app = buildApp(pool, new FakeNotifier(), () => NOW); });
afterAll(async () => { await pool?.end(); });
const post = (url: string, payload: object, cookie?: string) => app.inject({ method: 'POST', url, payload, headers: cookie ? { cookie } : {} });
const cookieOf = (r: any) => String(r.headers['set-cookie']).split(';')[0];
const reg = (extra: object = {}) => post('/client/register', { name: 'Rui Silva', phone: '+351 913 357 837', password: 'segredo-bom-1', consent: true, ...extra });

describe('Contas de cliente', () => {
  it('regista um cliente novo, dá-lhe ID de membro e abre sessão', async () => {
    const r = await reg(); expect(r.statusCode).toBe(200);
    const me = (await app.inject({ url: '/client/me', headers: { cookie: cookieOf(r) } })).json().me;
    expect(me).toMatchObject({ name: 'Rui Silva', points: 0 }); expect(me.memberCode).toMatch(/^RNR-/);
    expect((await app.inject({ url: '/client/me' })).statusCode).toBe(401);
    expect(String(r.headers['set-cookie'])).toMatch(/HttpOnly/);
  });
  it('exige consentimento, palavra-passe com 8+ e não repete conta', async () => {
    expect((await reg({ consent: false })).statusCode).toBe(400); expect((await reg({ password: 'curta' })).statusCode).toBe(400);
    expect((await reg()).statusCode).toBe(200); expect((await reg({ phone: '913357837' })).json().error).toBe('conta_existe'); // mesmo número, outro indicativo
  });
  it('cliente que já existe no HQ só reclama a conta com o ID de membro certo', async () => {
    const id = (await pool.query("insert into customers(name, phone, member_code) values ('Rui Antigo','+351913357837','RNR-AAAAAA') returning id")).rows[0].id;
    await pool.query("insert into points_ledger(customer_id, delta, kind, note) values ($1, 120, 'manual', 'teste')", [id]);
    expect((await reg()).json().error).toBe('codigo_necessario');
    expect((await reg({ memberCode: 'RNR-BBBBBB' })).json().error).toBe('codigo_errado');
    const ok = await reg({ memberCode: ' rnr-aaaaaa ' }); expect(ok.statusCode).toBe(200);
    const me = (await app.inject({ url: '/client/me', headers: { cookie: cookieOf(ok) } })).json().me; expect(me).toMatchObject({ id: Number(id), name: 'Rui Antigo', points: 120 }); // fica com a ficha e os pontos que já tinha
    expect((await pool.query('select count(*)::int n from customers')).rows[0].n).toBe(1);
  });
  it('cliente do HQ sem ID de membro: manda falar com a barbearia', async () => {
    await pool.query("insert into customers(name, phone) values ('Sem Codigo','+351913357837')");
    expect((await reg()).json().error).toBe('contactar_barbearia');
  });
  it('login, erro de palavra-passe, bloqueio após 5 tentativas, logout', async () => {
    await reg();
    expect((await post('/client/login', { phone: '913357837', password: 'errada-errada' })).statusCode).toBe(401);
    expect((await post('/client/login', { phone: '+351 913 357 837', password: 'segredo-bom-1' })).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) await post('/client/login', { phone: '913357837', password: 'x' + i });
    expect((await post('/client/login', { phone: '913357837', password: 'segredo-bom-1' })).statusCode).toBe(429); // mesmo certa, fica bloqueado
    await pool.query('delete from login_failures');
    const l = await post('/client/login', { phone: '913357837', password: 'segredo-bom-1' }); const c = cookieOf(l);
    await post('/client/logout', {}, c); expect((await app.inject({ url: '/client/me', headers: { cookie: c } })).statusCode).toBe(401);
  });
  it('perfil e palavra-passe: muda nome/e-mail e a palavra-passe', async () => {
    const c = cookieOf(await reg());
    const p = await app.inject({ method: 'PATCH', url: '/client/me', payload: { name: 'Rui S.', email: 'rui@x.pt' }, headers: { cookie: c } }); expect(p.json().me).toMatchObject({ name: 'Rui S.', email: 'rui@x.pt' });
    expect((await post('/client/password', { current: 'errada-errada', next: 'nova-palavra-1' }, c)).statusCode).toBe(403);
    expect((await post('/client/password', { current: 'segredo-bom-1', next: 'nova-palavra-1' }, c)).statusCode).toBe(200);
    expect((await post('/client/login', { phone: '913357837', password: 'nova-palavra-1' })).statusCode).toBe(200);
  });
  it('marca com os dados da conta; só vê, muda e cancela as suas marcações', async () => {
    const a = cookieOf(await reg()), b = cookieOf(await reg({ name: 'Outro', phone: '+351 912 000 111' }));
    const bk = await post('/client/bookings', { date: D, startMin: 14 * 60, serviceIds: ['corte'], employeeId: 'a' }, a); expect(bk.statusCode).toBe(200);
    const id = bk.json().bookingId;
    expect((await pool.query('select c.name from bookings b join customers c on c.id = b.customer_id where b.id = $1', [id])).rows[0].name).toBe('Rui Silva');
    expect((await app.inject({ url: '/client/bookings', headers: { cookie: a } })).json().bookings).toHaveLength(1);
    expect((await app.inject({ url: '/client/bookings', headers: { cookie: b } })).json().bookings).toHaveLength(0);
    expect((await post(`/client/bookings/${id}/cancel`, {}, b)).statusCode).toBe(404); // a marcação de outro cliente não existe para mim
    expect((await app.inject({ url: `/client/bookings/${id}`, headers: { cookie: b } })).statusCode).toBe(404);
    expect((await post(`/client/bookings/${id}/reschedule`, { date: D, startMin: 15 * 60 }, a)).statusCode).toBe(200);
    expect((await post(`/client/bookings/${id}/cancel`, {}, a)).statusCode).toBe(200);
    expect((await post('/client/bookings', { date: D, startMin: 14 * 60, serviceIds: ['corte'] })).statusCode).toBe(401); // sem login não marca por aqui
  });
});
