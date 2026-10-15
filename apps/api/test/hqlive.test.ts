import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { localToEpochMs } from '@rr/domain';
import { buildApp } from '../src/app';
import { FakeNotifier } from '../src/service';
import { hashPassword } from '../src/auth';
import { freshDb } from './helpers';

const D = '2026-10-14'; const NOW = localToEpochMs(D, 8 * 60); const PW = 'uma-palavra-passe-boa';
let pool: Awaited<ReturnType<typeof freshDb>>, app: ReturnType<typeof buildApp>, adm: string, andre: string, marcos: string;
const login = async (username: string) => ((await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password: PW } })).headers['set-cookie'] as string).split(';')[0];
const call = (cookie: string, method: any, url: string, payload?: any) => app.inject({ method, url, payload, headers: { cookie } });

beforeEach(async () => {
  pool = await freshDb(); app = buildApp(pool, new FakeNotifier(), () => NOW);
  for (const [u, role, e] of [['admin', 'admin', null], ['andre', 'barber', 'a'], ['marcos', 'barber', 'b']] as const) await pool.query('insert into users(username, password_hash, role, employee_id) values ($1,$2,$3,$4)', [u, await hashPassword(PW), role, e]);
  adm = await login('admin'); andre = await login('andre'); marcos = await login('marcos');
});
afterAll(async () => { await pool?.end(); });

const mk = (cookie: string, extra: object = {}) => call(cookie, 'POST', '/hq/bookings', { employeeId: 'a', date: D, startMin: 600, endMin: 640, serviceIds: ['corte'], notify: false, customer: { name: 'Rui', phone: '+351 910 000 103' }, ...extra });

describe('ecrã do HQ ligado ao servidor', () => {
  it('catálogo: qualquer utilizador com sessão vê barbeiros, serviços, produtos, horário e regras; sem sessão não', async () => {
    expect((await app.inject({ url: '/hq/catalog' })).statusCode).toBe(401);
    const c = (await call(andre, 'GET', '/hq/catalog')).json();
    expect(c.me).toMatchObject({ role: 'barber', employeeId: 'a' }); expect(c.employees).toHaveLength(2); expect(c.services.map((s: any) => s.id)).toContain('corte');
    expect(c.rules.holdMin).toBe(5); expect(c.hours.length).toBeGreaterThan(0);
  });
  it('criar marcação com cliente novo, ou ligar ao que já existe pelo telefone (pontos e histórico ficam juntos)', async () => {
    const a = (await mk(adm)).json(); expect(a.ok).toBe(true);
    const b = (await mk(adm, { employeeId: 'b', customer: { name: 'Rui Silva', phone: '910000103' } })).json(); expect(b.ok).toBe(true);
    expect((await pool.query('select count(*)::int n from customers')).rows[0].n).toBe(1);
    const l = (await call(adm, 'GET', `/hq/bookings?from=${D}&to=${D}`)).json().bookings;
    expect(l).toHaveLength(2); expect(l[0].customer).toMatchObject({ name: 'Rui', phone: '+351 910 000 103' });
  });
  it('lista por intervalo; barbeiro só vê as suas; intervalo absurdo é recusado', async () => {
    await mk(adm); await mk(adm, { employeeId: 'b', startMin: 700, endMin: 740, customer: { name: 'Outro', phone: '922222222' } });
    expect((await call(andre, 'GET', `/hq/bookings?from=${D}&to=2026-10-20`)).json().bookings).toHaveLength(1);
    expect((await call(adm, 'GET', `/hq/bookings?from=${D}&to=2026-10-20`)).json().bookings).toHaveLength(2);
    expect((await call(adm, 'GET', `/hq/bookings?from=2024-01-01&to=2026-10-20`)).statusCode).toBe(400);
  });
  it('editar a ficha: estado (não compareceu), notas e serviços recalculam a duração; barbeiro não troca de barbeiro', async () => {
    const id = (await mk(adm)).json().bookingId;
    expect((await call(andre, 'PATCH', `/hq/bookings/${id}`, { status: 'noshow', notes: 'Chegou tarde', notify: false })).statusCode).toBe(200);
    expect((await call(andre, 'PATCH', `/hq/bookings/${id}`, { status: 'confirmed', serviceIds: ['corte', 'barba'], notify: false })).statusCode).toBe(200);
    const b = (await call(adm, 'GET', `/hq/bookings?date=${D}`)).json().bookings[0]; expect(b).toMatchObject({ status: 'confirmed', notes: 'Chegou tarde', endMin: 660 });
    expect((await call(andre, 'PATCH', `/hq/bookings/${id}`, { employeeId: 'b', notify: false })).statusCode).toBe(403);
    expect((await call(adm, 'PATCH', `/hq/bookings/${id}`, { employeeId: 'b', notify: false })).statusCode).toBe(200);
    expect((await call(adm, 'GET', `/hq/bookings?date=${D}&employeeId=b`)).json().bookings).toHaveLength(1);
  });
  it('conflito ao editar pede confirmação; barbeiro de fora recebe 404', async () => {
    await mk(adm); const id = (await mk(adm, { startMin: 700, endMin: 740, customer: { name: 'Tiago', phone: '933333333' } })).json().bookingId;
    const r = await call(andre, 'PATCH', `/hq/bookings/${id}`, { startMin: 620, notify: false });
    expect(r.statusCode).toBe(409); expect(r.json()).toMatchObject({ error: 'conflito' });
    expect((await call(andre, 'PATCH', `/hq/bookings/${id}`, { startMin: 620, confirmConflicts: true, notify: false })).statusCode).toBe(200);
    expect((await call(marcos, 'PATCH', `/hq/bookings/${id}`, { notes: 'x', notify: false })).statusCode).toBe(404);
  });
  it('cancelar pela ficha avisa o barbeiro e fica na auditoria; apagar é só do admin e não apaga atendimentos registados', async () => {
    const id = (await mk(adm)).json().bookingId;
    await call(adm, 'PATCH', `/hq/bookings/${id}`, { status: 'cancelled', notify: false });
    expect((await pool.query("select count(*)::int n from audit_log where action = 'cancelar'")).rows[0].n).toBe(1);
    expect((await call(andre, 'DELETE', `/hq/bookings/${id}`)).statusCode).toBe(403);
    const id2 = (await mk(adm, { startMin: 800, endMin: 840 })).json().bookingId;
    await call(adm, 'POST', `/hq/bookings/${id2}/sale`, { payment: 'cartao', items: [{ kind: 'service', refId: 'corte', name: 'Corte', qty: 1, unitCents: 1700 }] });
    expect((await call(adm, 'DELETE', `/hq/bookings/${id2}`)).statusCode).toBe(409);
    expect((await call(adm, 'DELETE', `/hq/bookings/${id}`)).statusCode).toBe(200);
  });
  it('clientes: barbeiro só edita quem já atendeu (404 para os outros); admin edita qualquer um', async () => {
    await mk(adm); const cid = (await call(adm, 'GET', `/hq/bookings?date=${D}`)).json().bookings[0].customer.id;
    expect((await call(andre, 'PATCH', `/hq/customers/${cid}`, { notes: 'Prefere máquina 2', email: 'rui@exemplo.pt' })).statusCode).toBe(200);
    expect((await call(marcos, 'PATCH', `/hq/customers/${cid}`, { notes: 'intruso' })).statusCode).toBe(404);
    expect((await call(adm, 'GET', `/hq/bookings?date=${D}`)).json().bookings[0].customer).toMatchObject({ notes: 'Prefere máquina 2', email: 'rui@exemplo.pt' });
  });
  it('vendas e bloqueios por intervalo, com âmbito do barbeiro', async () => {
    const id = (await mk(adm)).json().bookingId; const id2 = (await mk(adm, { employeeId: 'b', startMin: 700, endMin: 740, customer: { name: 'Z', phone: '944444444' } })).json().bookingId;
    for (const i of [id, id2]) await call(adm, 'POST', `/hq/bookings/${i}/sale`, { payment: 'cartao', items: [{ kind: 'service', refId: 'corte', name: 'Corte', qty: 1, unitCents: 1700 }] });
    expect((await call(andre, 'GET', `/hq/sales?from=${D}&to=${D}`)).json().sales).toHaveLength(1);
    expect((await call(adm, 'GET', `/hq/sales?from=${D}&to=${D}`)).json().sales).toHaveLength(2);
    await call(adm, 'POST', '/hq/blocks', { employeeId: 'b', date: D, allDay: true });
    expect((await call(andre, 'GET', `/hq/blocks?from=${D}&to=${D}`)).json().blocks).toHaveLength(0);
    expect((await call(adm, 'GET', `/hq/blocks?from=${D}&to=${D}`)).json().blocks).toHaveLength(1);
  });
});

describe('migrações, contas e clientes (admin)', () => {
  it('migrar duas vezes não repete nada', async () => { const { migrate } = await import('../src/migrate'); expect(await migrate(pool)).toEqual([]); });
  it('lista de contas, reativar; só admin', async () => {
    expect((await call(andre, 'GET', '/admin/users')).statusCode).toBe(403);
    const us = (await call(adm, 'GET', '/admin/users')).json().users; expect(us.map((u: any) => u.username).sort()).toEqual(['admin', 'andre', 'marcos']);
    const id = us.find((u: any) => u.username === 'andre').id;
    await call(adm, 'POST', `/admin/users/${id}/deactivate`); expect((await call(adm, 'GET', '/admin/users')).json().users.find((u: any) => u.id === id).active).toBe(false);
    await call(adm, 'POST', `/admin/users/${id}/activate`); expect((await call(adm, 'GET', '/admin/users')).json().users.find((u: any) => u.id === id).active).toBe(true);
  });
  it('procurar clientes por nome, telefone ou ID RNR; mostra pontos; barbeiro não acede', async () => {
    await mk(adm); const cid = (await call(adm, 'GET', `/hq/bookings?date=${D}`)).json().bookings[0].customer.id;
    await call(adm, 'POST', `/admin/customers/${cid}/points`, { delta: 40, note: 'Boas-vindas' });
    for (const q of ['rui', '910000103', '910 000']) expect((await call(adm, 'GET', `/admin/customers?q=${encodeURIComponent(q)}`)).json().customers[0]).toMatchObject({ name: 'Rui', points: 40 });
    const code = (await call(adm, 'GET', `/admin/customers/${cid}/points`)).json().memberCode;
    expect((await call(adm, 'GET', `/admin/customers?q=${code}`)).json().customers).toHaveLength(1);
    expect((await call(adm, 'GET', '/admin/customers?q=zzzz')).json().customers).toHaveLength(0);
    expect((await call(andre, 'GET', '/admin/customers?q=rui')).statusCode).toBe(403);
  });
});

describe('servir a app', () => {
  it('serve index e ficheiros, nunca sai da pasta, e a API continua a responder JSON', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'rr-')); writeFileSync(join(dir, 'index.html'), '<title>RR</title>'); writeFileSync(join(dir, 'sw.js'), '//sw');
    const a2 = buildApp(pool, new FakeNotifier(), () => NOW, { publicDir: dir });
    expect((await a2.inject({ url: '/' })).body).toContain('<title>RR</title>');
    const sw = await a2.inject({ url: '/sw.js' }); expect(sw.headers['content-type']).toContain('javascript'); expect(sw.headers['cache-control']).toBe('no-cache');
    expect((await a2.inject({ url: '/nao-existe.png' })).statusCode).toBe(404);
    expect((await a2.inject({ url: '/%2e%2e/%2e%2e/etc/passwd' })).body).not.toContain('root:'); // cai na página principal, nunca no ficheiro do sistema
    expect((await a2.inject({ url: '/hq/nao-existe' })).headers['content-type']).toContain('json');
    expect((await a2.inject({ url: '/public/catalog' })).json().ok).toBe(true);
  });
});
