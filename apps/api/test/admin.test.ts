import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { localToEpochMs } from '@rr/domain';
import { buildApp } from '../src/app';
import { BookingService, FakeNotifier } from '../src/service';
import { hashPassword } from '../src/auth';
import { freshDb } from './helpers';

const D = '2026-10-14'; const NOW = localToEpochMs(D, 8 * 60); const PW = 'uma-palavra-passe-boa';
let pool: Awaited<ReturnType<typeof freshDb>>, app: ReturnType<typeof buildApp>, svc: BookingService, adm: string, bar: string;
const login = async (username: string) => ((await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password: PW } })).headers['set-cookie'] as string).split(';')[0];
const call = (cookie: string, method: any, url: string, payload?: any) => app.inject({ method, url, payload, headers: { cookie } });
const rules = async () => (await call(adm, 'GET', '/admin/settings')).json().rules;
const put = async (patch: object) => call(adm, 'PUT', '/admin/settings', { ...(await rules()), ...patch });
const cust = (i = 1) => ({ name: `c${i}`, phone: `91000000${i}` });

beforeEach(async () => {
  pool = await freshDb(); app = buildApp(pool, new FakeNotifier(), () => NOW); svc = new BookingService(pool, new FakeNotifier());
  for (const [u, role, e] of [['admin', 'admin', null], ['andre', 'barber', 'a']] as const) await pool.query('insert into users(username, password_hash, role, employee_id) values ($1,$2,$3,$4)', [u, await hashPassword(PW), role, e]);
  adm = await login('admin'); bar = await login('andre');
});
afterAll(async () => { await pool?.end(); });

describe('regras de marcação configuráveis no HQ', () => {
  it('só o administrador vê e altera; valores inválidos são recusados', async () => {
    expect((await app.inject({ url: '/admin/settings' })).statusCode).toBe(401);
    expect((await call(bar, 'GET', '/admin/settings')).statusCode).toBe(403);
    expect((await call(bar, 'PUT', '/admin/settings', await rules())).statusCode).toBe(403);
    expect((await put({ holdMin: 0 })).statusCode).toBe(400);
    expect((await put({ gridMin: 7 })).statusCode).toBe(400);
    expect((await put({ anyBarberPolicy: 'sorte' })).statusCode).toBe(400);
    expect(await rules()).toMatchObject({ holdMin: 5, cancelLeadMin: 180, gridMin: 10, allowOnlineOverlap: false });
  });
  it('duração da reserva temporária vem das definições', async () => {
    await put({ holdMin: 2 });
    const h = await svc.hold({ date: D, startMin: 600, serviceIds: ['corte'], employeeId: 'a', nowMs: NOW });
    expect((h as any).expiresAtMs).toBe(NOW + 2 * 60_000);
    expect((await svc.createOnline({ customer: cust(), date: D, startMin: 600, serviceIds: ['corte'], employeeId: 'a', nowMs: NOW + 2 * 60_000 + 1 })).ok).toBe(true);
  });
  it('prazo para cancelar/remarcar vem das definições', async () => {
    const r = await svc.createOnline({ customer: cust(), date: D, startMin: 660, serviceIds: ['corte'], employeeId: 'a', nowMs: NOW }); const id = (r as any).bookingId;
    const at = localToEpochMs(D, 9 * 60 + 30); // faltam 90 min
    expect(await svc.cancel({ bookingId: id, by: 'customer', actor: 'c', notify: false, nowMs: at })).toMatchObject({ ok: false, error: 'fora_do_prazo' });
    await put({ cancelLeadMin: 60 });
    expect((await svc.cancel({ bookingId: id, by: 'customer', actor: 'c', notify: false, nowMs: at })).ok).toBe(true);
  });
  it('limite de marcações em aberto por telefone (0 = sem limite)', async () => {
    await put({ maxOpenOnline: 1 });
    expect((await svc.createOnline({ customer: cust(), date: D, startMin: 600, serviceIds: ['corte'], employeeId: 'a', nowMs: NOW })).ok).toBe(true);
    expect(await svc.createOnline({ customer: cust(), date: D, startMin: 700, serviceIds: ['corte'], employeeId: 'a', nowMs: NOW })).toMatchObject({ ok: false, error: 'limite_marcacoes_abertas' });
    await put({ maxOpenOnline: 0 });
    expect((await svc.createOnline({ customer: cust(), date: D, startMin: 700, serviceIds: ['corte'], employeeId: 'a', nowMs: NOW })).ok).toBe(true);
  });
  it('sobreposição online: desligada por omissão; ligada, deixa sobrepor marcações mas nunca bloqueios', async () => {
    await svc.createHq({ actor: 'x', employeeId: 'a', date: D, startMin: 600, endMin: 640, serviceIds: ['corte'], notify: false, nowMs: NOW });
    expect((await svc.availability(D, ['corte'], 'a', NOW)).some(s => s.startMin === 610)).toBe(false);
    await put({ allowOnlineOverlap: true });
    expect((await svc.availability(D, ['corte'], 'a', NOW)).some(s => s.startMin === 610)).toBe(true);
    await pool.query("insert into blocks(id, employee_id, date, start_min, end_min) values ('k','a',$1,700,760)", [D]);
    expect((await svc.availability(D, ['corte'], 'a', NOW)).some(s => s.startMin === 710)).toBe(false);
  });
  it('"qualquer barbeiro": por menos marcações ou pela ordem do HQ', async () => {
    await pool.query("update employees set sort_order = case id when 'a' then 1 else 2 end");
    await svc.createHq({ actor: 'x', employeeId: 'a', date: D, startMin: 540, endMin: 580, serviceIds: ['corte'], notify: false, nowMs: NOW });
    const first = async (h: number) => (await svc.createOnline({ customer: cust(h), date: D, startMin: h, serviceIds: ['corte'], nowMs: NOW }) as any).employeeId;
    expect(await first(600)).toBe('b'); // a já tem 1 marcação
    await put({ anyBarberPolicy: 'first_in_order' });
    expect(await first(700)).toBe('a'); // ordem: a antes de b
    await pool.query("update employees set sort_order = case id when 'a' then 2 else 1 end");
    expect(await first(800)).toBe('b');
  });
});

describe('catálogo gerido pelo HQ', () => {
  it('criar barbeiro e serviço, atribuir e aparecer no catálogo público; desativar esconde mas mantém histórico', async () => {
    expect((await call(adm, 'POST', '/admin/employees', { id: 'edu', name: 'Eduardo', nickname: 'Aquaman', specialties: 'Skin fades', order: 5 })).statusCode).toBe(200);
    expect((await call(adm, 'POST', '/admin/employees', { id: 'edu', name: 'Outro' })).statusCode).toBe(409);
    expect((await call(adm, 'POST', '/admin/services', { id: 'sig', name: 'Signature Cut', durationMin: 40, priceCents: 2800 })).statusCode).toBe(200);
    expect((await call(adm, 'PUT', '/admin/employees/edu/services', { services: [{ serviceId: 'sig' }] })).statusCode).toBe(200);
    expect((await call(adm, 'PUT', '/admin/employees/edu/services', { services: [{ serviceId: 'nao-existe' }] })).statusCode).toBe(422);
    let cat = (await app.inject({ url: '/public/catalog' })).json();
    expect(cat.employees.map((e: any) => e.id)).toContain('edu'); expect(cat.services.find((s: any) => s.id === 'sig').priceCents).toBe(2800);
    expect((await svc.availability(D, ['sig'], 'edu', NOW)).length).toBeGreaterThan(0);
    await call(adm, 'PATCH', '/admin/services/sig', { active: false });
    expect((await svc.availability(D, ['sig'], 'edu', NOW))).toEqual([]);
    expect((await call(adm, 'PATCH', '/admin/employees/edu', { active: false })).statusCode).toBe(200);
    cat = (await app.inject({ url: '/public/catalog' })).json();
    expect(cat.employees.map((e: any) => e.id)).not.toContain('edu'); expect(cat.services.map((s: any) => s.id)).not.toContain('sig');
  });
  it('desativar um barbeiro fecha o acesso e as sessões dele', async () => {
    expect((await call(bar, 'GET', `/hq/bookings?date=${D}`)).statusCode).toBe(200);
    await call(adm, 'PATCH', '/admin/employees/a', { active: false });
    expect((await call(bar, 'GET', `/hq/bookings?date=${D}`)).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'andre', password: PW } })).statusCode).toBe(401);
  });
  it('produtos: criar, editar preço/stock, desativar; barbeiro não gere nada', async () => {
    expect((await call(adm, 'POST', '/admin/products', { id: 'pomada', name: 'Pomada', priceCents: 1500, stock: 10 })).statusCode).toBe(200);
    expect((await call(adm, 'PATCH', '/admin/products/pomada', { priceCents: 1600, stock: null, active: false })).statusCode).toBe(200);
    expect((await call(adm, 'GET', '/admin/products')).json().products[0]).toMatchObject({ priceCents: 1600, stock: null, active: false });
    for (const [m, u, p] of [['POST', '/admin/products', { id: 'x', name: 'x', priceCents: 1 }], ['POST', '/admin/services', { id: 'x', name: 'x', durationMin: 10, priceCents: 1 }], ['POST', '/admin/employees', { id: 'x', name: 'x' }], ['PUT', '/admin/opening-hours', { hours: [] }]] as const)
      expect((await call(bar, m, u, p)).statusCode).toBe(403);
  });
  it('horário de funcionamento editável', async () => {
    expect((await call(adm, 'PUT', '/admin/opening-hours', { hours: [{ weekday: 3, openMin: 600, closeMin: 700 }, { weekday: 3, openMin: 800, closeMin: 1100 }] })).statusCode).toBe(200);
    expect((await call(adm, 'PUT', '/admin/opening-hours', { hours: [{ weekday: 3, openMin: 700, closeMin: 600 }] })).statusCode).toBe(400);
    const s = await svc.availability(D, ['corte'], 'a', NOW); // 14/10/2026 é quarta
    expect(s.every(x => (x.startMin >= 600 && x.startMin + 40 <= 700) || (x.startMin >= 800 && x.startMin + 40 <= 1100))).toBe(true);
    expect(s.some(x => x.startMin >= 700 && x.startMin < 800)).toBe(false);
  });
});

describe('pontos: ajuste manual pelo HQ', () => {
  beforeEach(async () => { await pool.query("insert into customers(name, phone) values ('Cliente','911')"); });
  it('soma e retira com motivo, dá ID RNR-… ao cliente e guarda histórico', async () => {
    const a = await call(adm, 'POST', '/admin/customers/1/points', { delta: 150, note: 'Oferta de aniversário' });
    expect(a.json()).toEqual({ ok: true, balance: 150 });
    expect((await call(adm, 'POST', '/admin/customers/1/points', { delta: -50, note: 'Correção' })).json().balance).toBe(100);
    const g = (await call(adm, 'GET', '/admin/customers/1/points')).json();
    expect(g.balance).toBe(100); expect(g.memberCode).toMatch(/^RNR-[A-HJ-NP-Z2-9]{6}$/); expect(g.history).toHaveLength(2); expect(g.history[0]).toMatchObject({ delta: -50, kind: 'manual' });
  });
  it('nunca deixa o saldo ficar negativo; motivo obrigatório; barbeiro não pode', async () => {
    expect((await call(adm, 'POST', '/admin/customers/1/points', { delta: -1, note: 'Sem saldo' })).json()).toMatchObject({ ok: false, error: 'saldo_insuficiente' });
    expect((await call(adm, 'POST', '/admin/customers/1/points', { delta: 10, note: '' })).statusCode).toBe(400);
    expect((await call(adm, 'POST', '/admin/customers/1/points', { delta: 0, note: 'nada' })).statusCode).toBe(400);
    expect((await call(bar, 'POST', '/admin/customers/1/points', { delta: 10, note: 'tentativa' })).statusCode).toBe(403);
    expect((await call(adm, 'POST', '/admin/customers/99/points', { delta: 10, note: 'inexistente' })).statusCode).toBe(404);
  });
  it('ajustes ficam no registo de auditoria', async () => {
    await call(adm, 'POST', '/admin/customers/1/points', { delta: 20, note: 'Teste' });
    expect((await pool.query("select actor from audit_log where action='pontos_manual'")).rows[0].actor).toBe('admin');
  });
});
