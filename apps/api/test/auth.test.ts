import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { localToEpochMs } from '@rr/domain';
import { buildApp } from '../src/app';
import { FakeNotifier } from '../src/service';
import { hashPassword } from '../src/auth';
import { freshDb } from './helpers';

const D = '2026-10-14'; const NOW = localToEpochMs(D, 8 * 60);
let pool: Awaited<ReturnType<typeof freshDb>>, app: ReturnType<typeof buildApp>;
const PW = 'uma-palavra-passe-boa';
async function addUser(username: string, role: 'admin' | 'barber', employeeId: string | null, pw = PW) { await pool.query('insert into users(username, password_hash, role, employee_id) values ($1,$2,$3,$4)', [username, await hashPassword(pw), role, employeeId]); }
async function login(username: string, password = PW) { const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } }); const c = (r.headers['set-cookie'] as string | undefined)?.split(';')[0]; return { r, cookie: c ?? '' }; }
const as = (cookie: string) => ({ cookie });
beforeEach(async () => {
  pool = await freshDb(); app = buildApp(pool, new FakeNotifier(), () => NOW);
  await addUser('admin', 'admin', null); await addUser('andre', 'barber', 'a'); await addUser('marcos', 'barber', 'b');
  await pool.query("insert into customers(name, phone) values ('Cliente do André','911'),('Cliente do Marcos','922')");
  await pool.query(`insert into bookings(id, employee_id, customer_id, date, start_min, end_min, service_ids, source) values
    ('ba','a',1,'${D}',600,640,'{corte}','hq'),('bb','b',2,'${D}',600,640,'{corte}','hq')`);
});
afterAll(async () => { await pool?.end(); });

describe('Login e sessões', () => {
  it('rotas do HQ sem sessão dão 401; com sessão válida entram; /auth/me diz quem é', async () => {
    expect((await app.inject({ url: `/hq/bookings?date=${D}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/hq/bookings/ba/cancel', payload: { notify: false } })).statusCode).toBe(401);
    const { r, cookie } = await login('andre'); expect(r.statusCode).toBe(200);
    expect(r.headers['set-cookie']).toMatch(/HttpOnly/); expect(r.headers['set-cookie']).toMatch(/SameSite=Strict/);
    expect((await app.inject({ url: '/auth/me', headers: as(cookie) })).json().user).toEqual({ username: 'andre', role: 'barber', employeeId: 'a' });
  });
  it('palavra-passe errada e utilizador inexistente dão a mesma resposta (não revela quem existe)', async () => {
    const a = await login('andre', 'errada'), b = await login('fantasma', 'errada');
    expect(a.r.statusCode).toBe(401); expect(b.r.statusCode).toBe(401); expect(a.r.json()).toEqual(b.r.json());
  });
  it('bloqueia depois de 5 tentativas falhadas (mesmo com a palavra-passe certa) e o sucesso limpa o contador', async () => {
    for (let i = 0; i < 5; i++) expect((await login('andre', 'x' + i)).r.statusCode).toBe(401);
    expect((await login('andre')).r.statusCode).toBe(429);
    await pool.query('delete from login_failures');
    expect((await login('andre')).r.statusCode).toBe(200);
    for (let i = 0; i < 3; i++) await login('marcos', 'x');
    await login('marcos'); expect((await pool.query("select count(*)::int n from login_failures where username='marcos'")).rows[0].n).toBe(0);
  });
  it('logout termina a sessão; sessão expirada e conta desativada deixam de entrar', async () => {
    const { cookie } = await login('andre'); await app.inject({ method: 'POST', url: '/auth/logout', headers: as(cookie), payload: {} });
    expect((await app.inject({ url: `/hq/bookings?date=${D}`, headers: as(cookie) })).statusCode).toBe(401);
    const s2 = await login('andre'); await pool.query("update sessions set expires_at = now() - interval '1 minute'");
    expect((await app.inject({ url: '/auth/me', headers: as(s2.cookie) })).statusCode).toBe(401);
    const s3 = await login('marcos'); await pool.query("update users set active = false where username = 'marcos'");
    expect((await app.inject({ url: '/auth/me', headers: as(s3.cookie) })).statusCode).toBe(401);
    expect((await login('marcos')).r.statusCode).toBe(401);
  });
  it('as palavras-passe não ficam em texto simples e a sessão só guarda o hash do token', async () => {
    const { cookie } = await login('andre');
    expect((await pool.query("select password_hash from users where username='andre'")).rows[0].password_hash).not.toContain(PW);
    const token = cookie.split('=')[1]; expect((await pool.query('select token_hash from sessions')).rows.every(r => r.token_hash !== token)).toBe(true);
  });
});

describe('Permissões: cada barbeiro só vê e mexe no que é seu', () => {
  it('lista de marcações: barbeiro só vê as suas; pedir as de outro dá 403; admin vê todas', async () => {
    const a = (await login('andre')).cookie, ad = (await login('admin')).cookie;
    const mine = (await app.inject({ url: `/hq/bookings?date=${D}`, headers: as(a) })).json().bookings;
    expect(mine.map((b: any) => b.id)).toEqual(['ba']); expect(mine[0].customer.name).toBe('Cliente do André');
    expect((await app.inject({ url: `/hq/bookings?date=${D}&employeeId=b`, headers: as(a) })).statusCode).toBe(403);
    expect((await app.inject({ url: `/hq/bookings?date=${D}`, headers: as(ad) })).json().bookings.map((b: any) => b.id).sort()).toEqual(['ba', 'bb']);
    expect(JSON.stringify(mine)).not.toContain('Marcos');
  });
  it('não cria, cancela nem reagenda marcações de outro barbeiro (404, sem revelar que existem)', async () => {
    const a = (await login('andre')).cookie;
    expect((await app.inject({ method: 'POST', url: '/hq/bookings', headers: as(a), payload: { employeeId: 'b', date: D, startMin: 700, endMin: 740, serviceIds: ['corte'], notify: false } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/hq/bookings/bb/cancel', headers: as(a), payload: { notify: false } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/hq/bookings/bb/reschedule', headers: as(a), payload: { date: D, startMin: 900, notify: false } })).statusCode).toBe(404);
    expect((await pool.query("select status from bookings where id='bb'")).rows[0].status).toBe('confirmed');
    // as suas próprias funcionam
    expect((await app.inject({ method: 'POST', url: '/hq/bookings/ba/cancel', headers: as(a), payload: { notify: false } })).statusCode).toBe(200);
  });
  it('não associa clientes de outros barbeiros às suas marcações; o admin pode', async () => {
    const a = (await login('andre')).cookie, ad = (await login('admin')).cookie;
    const body = (customerId: number, employeeId: string, startMin: number) => ({ customerId, employeeId, date: D, startMin, endMin: startMin + 40, serviceIds: ['corte'], notify: false });
    expect((await app.inject({ method: 'POST', url: '/hq/bookings', headers: as(a), payload: body(2, 'a', 700) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/hq/bookings', headers: as(a), payload: body(1, 'a', 700) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/hq/bookings', headers: as(ad), payload: body(2, 'a', 800) })).statusCode).toBe(200);
    expect((await pool.query("select actor from audit_log order by id desc limit 1")).rows[0].actor).toBe('admin'); // auditoria com o utilizador real
  });
  it('só o admin cria contas e repõe palavras-passe; repor fecha as sessões abertas', async () => {
    const a = (await login('andre')).cookie, ad = (await login('admin')).cookie;
    const mk = { username: 'tito', password: 'outra-palavra-passe', role: 'barber', employeeId: 'b' };
    expect((await app.inject({ method: 'POST', url: '/admin/users', headers: as(a), payload: mk })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/admin/users', payload: mk })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/admin/users', headers: as(ad), payload: { ...mk, password: 'curta' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/admin/users', headers: as(ad), payload: { ...mk, employeeId: undefined } })).statusCode).toBe(422);
    const ok = await app.inject({ method: 'POST', url: '/admin/users', headers: as(ad), payload: mk }); expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/admin/users', headers: as(ad), payload: mk })).statusCode).toBe(409);
    const t = await login('tito', mk.password); expect(t.r.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/admin/users/${ok.json().id}/password`, headers: as(ad), payload: { password: 'nova-palavra-passe-1' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/auth/me', headers: as(t.cookie) })).statusCode).toBe(401);
    expect((await login('tito', 'nova-palavra-passe-1')).r.statusCode).toBe(200);
  });
});

describe('Atendimentos e dashboards', () => {
  const sale = (extra = {}) => ({ payment: 'cartao', items: [{ kind: 'service', refId: 'corte', name: 'Corte Premium', qty: 1, unitCents: 1700 }, { kind: 'product', refId: 'pomada', name: 'Pomada', qty: 2, unitCents: 1500 }], ...extra });
  it('barbeiro regista o atendimento da sua marcação (uma vez só) e não o de outro', async () => {
    const a = (await login('andre')).cookie;
    expect((await app.inject({ method: 'POST', url: '/hq/bookings/bb/sale', headers: as(a), payload: sale() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/hq/bookings/ba/sale', headers: as(a), payload: sale() })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/hq/bookings/ba/sale', headers: as(a), payload: sale() })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/hq/bookings/ba/sale', headers: as(a), payload: { payment: 'cartao', items: [] } })).statusCode).toBe(400);
  });
  it('dashboard do barbeiro: só os seus números; pedir os de outro dá 403; admin vê a loja e cada barbeiro', async () => {
    const a = (await login('andre')).cookie, m = (await login('marcos')).cookie, ad = (await login('admin')).cookie;
    await app.inject({ method: 'POST', url: '/hq/bookings/ba/sale', headers: as(a), payload: sale() });
    await app.inject({ method: 'POST', url: '/hq/bookings/bb/sale', headers: as(m), payload: sale({ items: [{ kind: 'service', refId: 'corte', name: 'Corte Premium', qty: 1, unitCents: 1700 }] }) });
    const q = `from=${D}&to=${D}`;
    const mine = (await app.inject({ url: `/hq/dashboard?${q}`, headers: as(a) })).json();
    expect(mine.scope).toBe('a'); expect(mine.current.total.revenueCents).toBe(4700); expect(mine.current.total.avgTicketCents).toBe(4700); expect(mine.current.total.productUnits).toBe(2);
    expect((await app.inject({ url: `/hq/dashboard?${q}&employeeId=b`, headers: as(a) })).statusCode).toBe(403);
    const shop = (await app.inject({ url: `/hq/dashboard?${q}`, headers: as(ad) })).json();
    expect(shop.scope).toBe('loja'); expect(shop.current.total.revenueCents).toBe(4700 + 1700); expect(shop.current.perBarber.length).toBe(2);
    expect((await app.inject({ url: `/hq/dashboard?${q}&employeeId=b`, headers: as(ad) })).json().current.total.revenueCents).toBe(1700);
    expect((await app.inject({ url: `/hq/dashboard?${q}` })).statusCode).toBe(401);
  });
  it('dashboards só têm números: nunca nomes, telefones ou e-mails de clientes', async () => {
    const a = (await login('andre')).cookie, ad = (await login('admin')).cookie;
    await pool.query("update customers set email = 'segredo@exemplo.pt' where id = 1");
    await app.inject({ method: 'POST', url: '/hq/bookings/ba/sale', headers: as(a), payload: sale() });
    for (const c of [a, ad]) { const txt = (await app.inject({ url: `/hq/dashboard?from=${D}&to=${D}`, headers: as(c) })).body; for (const secret of ['Cliente do André', 'Cliente do Marcos', '911', '922', 'segredo@exemplo.pt']) expect(txt).not.toContain(secret); }
  });
});
