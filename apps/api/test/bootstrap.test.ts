import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app';
import { FakeNotifier } from '../src/service';
import { createAdmin, firstRun, vapidKeys } from '../src/bootstrap';
import { freshDb } from './helpers';

let pool: pg.Pool;
beforeAll(async () => { pool = await freshDb(); await pool.query('delete from employee_services; delete from employees'); });
afterAll(async () => { await pool.end(); });

describe('primeiro arranque', () => {
  it('cria administrador e equipa só uma vez', async () => {
    const env = { BOOTSTRAP_ADMIN_USER: 'Bruno', BOOTSTRAP_ADMIN_PASSWORD: 'uma-palavra-longa', SEED_RR: '1' };
    expect(await firstRun(pool, env)).toEqual(['administrador', 'equipa']);
    expect(await firstRun(pool, { ...env, BOOTSTRAP_ADMIN_PASSWORD: 'outra-palavra-longa' })).toEqual([]);
    expect((await pool.query('select username, role from users')).rows).toEqual([{ username: 'bruno', role: 'admin' }]);
    expect((await pool.query('select count(*)::int n from employees')).rows[0].n).toBe(5);
  });
  it('sem variáveis não cria nada; palavra-passe curta é recusada', async () => {
    const p2 = await freshDb(); await p2.query('delete from employee_services; delete from employees');
    expect(await firstRun(p2, {})).toEqual([]);
    await expect(firstRun(p2, { BOOTSTRAP_ADMIN_USER: 'x', BOOTSTRAP_ADMIN_PASSWORD: 'curta' })).rejects.toThrow();
    await p2.end();
  });
  it('as chaves VAPID geram-se uma vez e mantêm-se', async () => {
    const a = await vapidKeys(pool, {}), b = await vapidKeys(pool, {});
    expect(a.publicKey).toBeTruthy(); expect(b).toEqual(a);
    expect(await vapidKeys(pool, { VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'q' })).toEqual({ publicKey: 'p', privateKey: 'q' });
  });
  it('/healthz responde e confirma a base de dados', async () => {
    const app = buildApp(pool, new FakeNotifier());
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ ok: true });
  });
});

describe('mudar a própria palavra-passe', () => {
  it('exige a atual, aplica a nova, fecha as outras sessões e mantém a atual', async () => {
    await createAdmin(pool, 'bruno', 'uma-palavra-longa');
    const app = buildApp(pool, new FakeNotifier());
    const login = async (pw: string) => app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'bruno', password: pw } });
    const cookie = (r: any) => String(r.headers['set-cookie']).split(';')[0];
    const a = await login('uma-palavra-longa'), b = await login('uma-palavra-longa');
    expect(a.statusCode).toBe(200);
    const bad = await app.inject({ method: 'POST', url: '/auth/password', headers: { cookie: cookie(a) }, payload: { current: 'errada-errada', password: 'nova-palavra-longa' } });
    expect(bad.statusCode).toBe(403); expect(bad.json().error).toBe('palavra_passe_atual_errada');
    expect((await app.inject({ method: 'POST', url: '/auth/password', headers: { cookie: cookie(a) }, payload: { current: 'uma-palavra-longa', password: 'curta' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/auth/password', payload: { current: 'x', password: 'nova-palavra-longa' } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/auth/password', headers: { cookie: cookie(a) }, payload: { current: 'uma-palavra-longa', password: 'nova-palavra-longa' } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookie(a) } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookie(b) } })).statusCode).toBe(401);
    expect((await login('uma-palavra-longa')).statusCode).toBe(401);
    expect((await login('nova-palavra-longa')).statusCode).toBe(200);
  });
});

describe('regra: horários de 30 em 30 + hora quebrada (configurável no HQ)', () => {
  it('o admin liga/desliga; a base nova traz 30 min com hora quebrada; o Booking só oferece esses horários', async () => {
    const p3 = await freshDb(); await p3.query('update shop_settings set grid_min = 30, snap_after_end = true');
    await createAdmin(p3, 'bruno', 'uma-palavra-longa'); const app = buildApp(p3, new FakeNotifier(), () => Date.UTC(2026, 9, 14, 7, 0)); // quarta, 08:00 locais
    const cookie = String((await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'bruno', password: 'uma-palavra-longa' } })).headers['set-cookie']).split(';')[0];
    const day = '2026-10-21'; // quarta seguinte
    await p3.query("insert into customers(name, phone) values ('Rui', '913357837')");
    await p3.query("insert into bookings(id, employee_id, date, start_min, end_min, status, customer_id, service_ids, source) select 'x','a',$1,720,760,'confirmed', id, array['corte'],'hq' from customers limit 1", [day]);
    const slots = async () => ((await app.inject({ method: 'GET', url: `/public/availability?date=${day}&services=corte&employeeId=a` })).json().slots as { startMin: number }[]).map(s => s.startMin);
    let s = await slots(); expect(s).toContain(760); expect(s).toContain(780); expect(s).not.toContain(770); expect(s).not.toContain(550);
    const put = (snap: boolean) => app.inject({ method: 'PUT', url: '/admin/settings', headers: { cookie }, payload: { gridMin: 30, maxWeeksAhead: 8, lastBookingLeadMin: 60, cancelLeadMin: 180, holdMin: 5, maxOpenOnline: 3, allowOnlineOverlap: false, anyBarberPolicy: 'fewest_bookings', snapAfterEnd: snap } });
    expect((await put(false)).statusCode).toBe(200); s = await slots(); expect(s).not.toContain(760); expect(s).toContain(780);
    expect((await put(true)).statusCode).toBe(200); expect(await slots()).toContain(760);
    // sem enviar snapAfterEnd mantém o valor
    await app.inject({ method: 'PUT', url: '/admin/settings', headers: { cookie }, payload: { gridMin: 30, maxWeeksAhead: 8, lastBookingLeadMin: 60, cancelLeadMin: 180, holdMin: 5, maxOpenOnline: 3, allowOnlineOverlap: false, anyBarberPolicy: 'fewest_bookings' } });
    expect(await slots()).toContain(760);
    // reservar uma hora fora da grelha é recusado (a validação usa a mesma regra)
    const bad = await app.inject({ method: 'POST', url: '/public/holds', payload: { date: day, startMin: 770, serviceIds: ['corte'], employeeId: 'a' } }); expect(bad.statusCode).toBe(409);
    const ok = await app.inject({ method: 'POST', url: '/public/holds', payload: { date: day, startMin: 760, serviceIds: ['corte'], employeeId: 'a' } }); expect(ok.statusCode).toBe(200);
    await p3.end();
  });
});
