import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app';
import { FakeNotifier } from '../src/service';
import { firstRun, vapidKeys } from '../src/bootstrap';
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
