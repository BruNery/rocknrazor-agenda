import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localToEpochMs } from '@rr/domain';
import { buildApp } from '../src/app';
import { FakeNotifier } from '../src/service';
import { freshDb } from './helpers';

const D = '2026-10-14'; const NOW = localToEpochMs(D, 8 * 60); // quarta-feira, 08:00
let pool: Awaited<ReturnType<typeof freshDb>>, app: ReturnType<typeof buildApp>;
beforeEach(async () => { pool = await freshDb(); app = buildApp(pool, new FakeNotifier(), () => NOW); });
afterAll(async () => { await pool?.end(); });
const book = (name: string, phone: string, startMin: number, extra: object = {}) => app.inject({ method: 'POST', url: '/public/bookings', payload: { customer: { name, phone }, date: D, startMin, serviceIds: ['corte'], employeeId: 'a', ...extra } });

describe('Booking público: rotas novas', () => {
  it('dias com horas: o domingo vem a 0 e um dia cheio também', async () => {
    const r = (await app.inject({ url: `/public/availability/days?from=2026-10-17&days=5&services=corte&employeeId=a` })).json();
    expect(Object.keys(r.days)).toEqual(['2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21']);
    expect(r.days['2026-10-18']).toBe(0); // domingo fechado
    expect(r.days['2026-10-19']).toBeGreaterThan(0);
    await pool.query("insert into blocks(id, employee_id, date, all_day) values ('x','a',$1,true)", [D]);
    expect((await app.inject({ url: `/public/availability/days?from=${D}&days=1&services=corte&employeeId=a` })).json().days[D]).toBe(0);
    expect((await app.inject({ url: `/public/availability/days?from=${D}&days=99&services=corte` })).statusCode).toBe(400); // máx. 31
  });

  it('ID de membro só aparece a quem acabou de ser registado; um número já conhecido não o recebe', async () => {
    const a = (await book('Rui Novo', '913357837', 600)).json();
    expect(a.ok).toBe(true); expect(a.memberCode).toMatch(/^RNR-[A-Z2-9]{6}$/);
    const saved = (await pool.query('select member_code from customers')).rows; expect(saved).toEqual([{ member_code: a.memberCode }]);
    const b = (await book('Outra Pessoa', '+351 913 357 837', 660)).json(); // mesmo telefone (últimos 9 dígitos)
    expect(b.ok).toBe(true); expect(b.memberCode).toBeUndefined();
    expect((await pool.query('select count(*)::int n from customers')).rows[0].n).toBe(1);
  });

  it('detalhe da marcação: só com o ID, sem telefone nem ID de membro; pode alterar até ao prazo', async () => {
    const id = (await book('Rui Novo', '913357837', 840)).json().bookingId;
    const r = await app.inject({ url: `/public/bookings/${id}` }); const b = r.json().booking;
    expect(r.statusCode).toBe(200); expect(r.headers['cache-control']).toBe('no-store');
    expect(b).toMatchObject({ id, date: D, startMin: 840, endMin: 880, status: 'confirmed', customerName: 'Rui Novo', canChange: true, employee: { id: 'a', name: 'Andre' }, services: [{ id: 'corte', name: 'Corte', durationMin: 40 }] });
    expect(JSON.stringify(b)).not.toMatch(/913357837|RNR-|phone|memberCode/);
    expect((await app.inject({ url: '/public/bookings/nao-existe' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/public/bookings/00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
    // faltam menos de 3 h: já não dá para alterar online
    const late = buildApp(pool, new FakeNotifier(), () => localToEpochMs(D, 11 * 60 + 2)); // 11:02
    expect((await late.inject({ url: `/public/bookings/${id}` })).json().booking.canChange).toBe(false);
    await app.inject({ method: 'POST', url: `/public/bookings/${id}/cancel` });
    expect((await app.inject({ url: `/public/bookings/${id}` })).json().booking).toMatchObject({ status: 'cancelled', canChange: false });
  });

  it('libertar a reserva devolve a hora a toda a gente', async () => {
    const h = (await app.inject({ method: 'POST', url: '/public/holds', payload: { date: D, startMin: 840, serviceIds: ['corte'], employeeId: 'a' } })).json();
    const slots = async () => (await app.inject({ url: `/public/availability?date=${D}&services=corte&employeeId=a` })).json().slots.map((s: any) => s.startMin);
    expect(await slots()).not.toContain(840);
    expect((await app.inject({ method: 'DELETE', url: `/public/holds/${h.holdId}` })).statusCode).toBe(200);
    expect(await slots()).toContain(840);
  });

  it('dois clientes ao mesmo tempo na mesma hora: um fica com ela, o outro é recusado', async () => {
    const [x, y] = await Promise.all([book('Ana', '911111111', 780), book('Beto', '922222222', 780)]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    expect((await pool.query("select count(*)::int n from bookings where start_min = 780 and status = 'confirmed'")).rows[0].n).toBe(1);
  });

  it('área do cliente: marcar.* e /marcar mostram a app do cliente; o resto continua a ser o HQ', async () => {
    const hq = mkdtempSync(join(tmpdir(), 'hq-')), cl = mkdtempSync(join(tmpdir(), 'cl-'));
    writeFileSync(join(hq, 'index.html'), '<title>HQ</title>'); writeFileSync(join(cl, 'index.html'), '<title>CLIENTE</title>'); writeFileSync(join(cl, 'app.js'), 'x');
    const a2 = buildApp(pool, new FakeNotifier(), () => NOW, { publicDir: hq, clientDir: cl });
    const get = async (url: string, host?: string) => a2.inject({ url, headers: host ? { host } : undefined });
    expect((await get('/', 'agenda.rockandrazor.com')).body).toContain('HQ');
    expect((await get('/', 'marcar.rockandrazor.com')).body).toContain('CLIENTE');
    expect((await get('/app.js', 'marcar.rockandrazor.com')).statusCode).toBe(200);
    expect((await get('/', 'rocknrazor-agenda.onrender.com')).body).toContain('HQ');
    expect((await get('/marcar/', 'rocknrazor-agenda.onrender.com')).body).toContain('CLIENTE');
    expect((await get('/marcar/app.js', 'rocknrazor-agenda.onrender.com')).statusCode).toBe(200);
    expect((await get('/marcar', 'rocknrazor-agenda.onrender.com')).statusCode).toBe(301);
    expect((await get('/app.js', 'agenda.rockandrazor.com')).statusCode).toBe(404); // o ficheiro do cliente não aparece no HQ
    expect((await get('/public/catalog', 'marcar.rockandrazor.com')).json().ok).toBe(true); // a API responde nos dois endereços
  });
});
