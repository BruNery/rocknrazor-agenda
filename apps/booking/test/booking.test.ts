import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../api/src/app';
import { FakeNotifier } from '../../api/src/service';
import { migrate } from '../../api/src/migrate';

/** Área do cliente no telemóvel (390 px): conta, marcar, marcações, mudar hora, cancelar, prémios, perfil, corrida de dois clientes. */
let pool: pg.Pool, app: FastifyInstance, base = '', browser: Browser;
const dayAt = (weekday: number, weeksAhead: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + ((weekday - d.getUTCDay() + 7) % 7 || 7) + 7 * weeksAhead); return d.toISOString().slice(0, 10); };
const wed = dayAt(3, 1), thu = dayAt(4, 1);
const PW = 'segredo-bom-1';

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: 'postgres://postgres@/postgres?host=/tmp&port=5544' }); await admin.connect();
  if (!(await admin.query("select 1 from pg_database where datname='rr_booking'")).rowCount) await admin.query('create database rr_booking'); await admin.end();
  pool = new pg.Pool({ connectionString: 'postgres://postgres@/rr_booking?host=/tmp&port=5544', max: 10 });
  await pool.query('drop schema public cascade; create schema public;'); await migrate(pool);
  await pool.query(`insert into employees(id,name,nickname,sort_order) values ('andre','André','Link',1),('marcos','Marcos','Gringo',2);
    insert into services(id,name,duration_min,price_cents) values ('corte','Corte Premium',40,1700),('barba','Barba',20,800);
    insert into employee_services(employee_id,service_id) select e.id, s.id from employees e, services s;
    insert into opening_hours(weekday,open_min,close_min) select d,540,1140 from generate_series(1,6) d`);
  app = buildApp(pool, new FakeNotifier(), Date.now, { publicDir: fileURLToPath(new URL('../../hq/dist/pwa', import.meta.url)), clientDir: fileURLToPath(new URL('../dist', import.meta.url)) });
  await app.listen({ port: 0, host: '127.0.0.1' }); base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
});
afterAll(async () => { await browser?.close(); await app?.close(); await pool?.end(); });

const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }); };
async function overflow(page: Page) { return page.evaluate(() => { const d = document.documentElement; return { vw: d.clientWidth, sw: d.scrollWidth }; }); }
async function open(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage(); page.on('pageerror', e => { throw e; }); await page.goto(base + '/marcar/'); await page.waitForSelector('.bk-h1'); return page;
}
const noOverflow = async (p: Page) => { const o = await overflow(p); expect(o.sw, JSON.stringify(o)).toBeLessThanOrEqual(o.vw); };
const pickDay = async (p: Page, d: string) => { await p.waitForSelector(`[data-act=day][data-v="${d}"]:not([disabled])`); await p.click(`[data-act=day][data-v="${d}"]`); await p.waitForSelector('.bk-slot'); };
const slots = (p: Page) => p.$$eval('.bk-slot', els => els.map(e => e.textContent!));
/** Cria a conta pelo ecrã (como um cliente novo). */
async function register(p: Page, name: string, phone: string) {
  await p.click('[data-act=auth-mode]'); await p.fill('[name=name]', name); await p.fill('[name=phone]', phone); await p.fill('[name=password]', PW); await p.check('[name=consent]');
  await p.click('#authf button[type=submit]'); await p.waitForSelector('.bk-tabs');
}
const tab = (p: Page, label: string) => p.click(`.bk-tab:has-text("${label}")`);

describe('Área do cliente no telemóvel (390 px)', { timeout: 60000 }, () => {
  let p: Page;
  it('sem conta só vê a entrada; cria a conta e fica na página principal com os 5 separadores', async () => {
    p = await open(); await shot(p, 'c-entrar'); await noOverflow(p);
    expect(await p.locator('.bk-tabs').count()).toBe(0); expect(await p.textContent('h1')).toContain('Entra');
    await p.click('[data-act=auth-mode]'); await p.fill('[name=name]', 'Rui Cliente'); await p.fill('[name=phone]', '913 357 837'); await p.fill('[name=password]', 'curta');
    await p.click('#authf button[type=submit]'); await p.waitForSelector('.bk-err'); expect(await p.textContent('.bk-err')).toContain('8 caracteres');
    await p.fill('[name=password]', PW); await p.click('#authf button[type=submit]'); await p.waitForSelector('.bk-err'); expect(await p.textContent('.bk-err')).toContain('autoriza');
    await p.check('[name=consent]'); await p.click('#authf button[type=submit]'); await p.waitForSelector('.bk-tabs'); await shot(p, 'c-home'); await noOverflow(p);
    expect(await p.textContent('h1')).toContain('Rui'); expect(await p.locator('.bk-tab').allTextContents()).toEqual(['Marcar', 'Marcações', 'Prémios', 'Sorteios', 'Perfil']);
    expect((await pool.query('select c.name, c.member_code from customers c join client_accounts a on a.customer_id = c.id')).rows[0]).toMatchObject({ name: 'Rui Cliente' });
  });
  it('fluxo de marcação: barbeiro, serviços, hora (grelha de 30), confirmar com os dados da conta', async () => {
    await p.click('[data-act=start]'); await p.check('input[value=andre]'); await shot(p, 'c-barbeiro'); await noOverflow(p); await p.click('[data-act=to-services]');
    await p.check('input[value=corte]'); await p.waitForSelector('.bk-bar b:has-text("40 min")'); await noOverflow(p);
    await p.click('[data-act=to-time]'); await pickDay(p, wed); await shot(p, 'c-hora'); await noOverflow(p);
    const s = await slots(p); expect(s[0]).toBe('09:00'); expect(s.every(x => /^\d\d:(00|30)$/.test(x))).toBe(true);
    await p.click('.bk-slot:has-text("10:00")'); await p.waitForSelector('[data-act=confirm]'); await shot(p, 'c-confirmar'); await noOverflow(p);
    expect(await p.textContent('.bk-main')).toContain('Rui Cliente');
    await p.click('[data-act=confirm]'); await p.waitForSelector('.bk-ok'); await shot(p, 'c-confirmada'); await noOverflow(p);
    expect((await pool.query("select b.start_min, b.employee_id, c.name from bookings b join customers c on c.id=b.customer_id")).rows).toEqual([{ start_min: 600, employee_id: 'andre', name: 'Rui Cliente' }]);
  });
  it('a hora marcada já não aparece; 10:40 arredonda para 11:00', async () => {
    await p.click('[data-act=again]'); await p.click('[data-act=start]'); await p.check('input[value=andre]'); await p.click('[data-act=to-services]'); await p.check('input[value=corte]'); await p.click('[data-act=to-time]');
    await pickDay(p, wed); const s = await slots(p); expect(s).not.toContain('10:00'); expect(s).not.toContain('10:30'); expect(s).toContain('11:00');
  });
  it('Marcações lista a marcação; mudar a hora e cancelar (com confirmação)', async () => {
    await tab(p, 'Marcações'); await p.waitForSelector('.bk-item'); await shot(p, 'c-marcacoes'); await noOverflow(p);
    expect(await p.locator('.bk-item').count()).toBe(1); expect(await p.textContent('.bk-item')).toContain('Corte Premium');
    await p.click('.bk-item'); await p.waitForSelector('[data-act=m-resched]'); await shot(p, 'c-gerir'); await noOverflow(p);
    await p.click('[data-act=m-resched]'); await pickDay(p, thu); expect(await slots(p)).toContain('09:00');
    await p.click('.bk-slot:has-text("15:00")'); await p.click('[data-act=m-confirm]'); await p.waitForSelector('h1:has-text("Hora alterada")');
    expect(await pool.query("select to_char(date,'YYYY-MM-DD') d, start_min from bookings")).toMatchObject({ rows: [{ d: thu, start_min: 900 }] });
    await p.click('[data-act=m-ask]'); await p.waitForSelector('.bk-warn'); await p.click('[data-act=m-keep]'); await p.waitForSelector('[data-act=m-ask]');
    await p.click('[data-act=m-ask]'); await p.click('[data-act=m-cancel]'); await p.waitForSelector('h1:has-text("Marcação cancelada")');
    expect((await pool.query('select status from bookings')).rows[0].status).toBe('cancelled');
  });
  it('Prémios mostra a carteira com os pontos e a atividade; Sorteios está em breve', async () => {
    const id = (await pool.query("select customer_id from client_accounts")).rows[0].customer_id;
    await pool.query("insert into points_ledger(customer_id, delta, kind, note) values ($1, 75, 'manual', 'Bónus de boas-vindas')", [id]);
    await tab(p, 'Prémios'); await p.waitForSelector('.bk-act'); await shot(p, 'c-premios'); await noOverflow(p);
    expect(await p.textContent('.bk-points')).toBe('75'); expect(await p.textContent('.bk-wallet')).toMatch(/RNR-[A-Z0-9]{6}/); expect(await p.textContent('.bk-act')).toContain('Bónus de boas-vindas');
    await tab(p, 'Sorteios'); await p.waitForSelector('.bk-soon'); await shot(p, 'c-sorteios'); await noOverflow(p);
  });
  it('Perfil: guarda dados, muda palavra-passe, sai e volta a entrar', async () => {
    await tab(p, 'Perfil'); await p.waitForSelector('#pff'); await shot(p, 'c-perfil'); await noOverflow(p);
    await p.fill('#pff [name=name]', 'Rui S. Cliente'); await p.fill('#pff [name=email]', 'rui@exemplo.pt'); await p.click('#pff button'); await p.waitForSelector('.bk-okmsg');
    expect((await pool.query("select name, email from customers")).rows[0]).toEqual({ name: 'Rui S. Cliente', email: 'rui@exemplo.pt' });
    await p.fill('#pwf [name=current]', 'errada-errada'); await p.fill('#pwf [name=next]', 'nova-palavra-1'); await p.click('#pwf button'); await p.waitForSelector('.bk-err'); expect(await p.textContent('.bk-err')).toContain('atual');
    await p.fill('#pwf [name=current]', PW); await p.fill('#pwf [name=next]', 'nova-palavra-1'); await p.click('#pwf button'); await p.waitForSelector('.bk-okmsg');
    await p.click('[data-act=logout]'); await p.waitForSelector('#authf'); expect(await p.locator('.bk-tabs').count()).toBe(0);
    await p.fill('[name=phone]', '913357837'); await p.fill('[name=password]', PW); await p.click('#authf button[type=submit]'); await p.waitForSelector('.bk-err'); expect(await p.textContent('.bk-err')).toContain('errados'); // palavra-passe antiga já não serve
    await p.fill('[name=password]', 'nova-palavra-1'); await p.click('#authf button[type=submit]'); await p.waitForSelector('.bk-tabs');
    await p.reload(); await p.waitForSelector('.bk-tabs'); // a sessão sobrevive a recarregar
  });
  it('cliente que já existe no HQ precisa do ID de membro para reclamar a conta', async () => {
    await pool.query("insert into customers(name, phone, member_code) values ('Joana Antiga','+351 912 345 678','RNR-JOANA1')");
    const j = await open(); await j.click('[data-act=auth-mode]'); await j.fill('[name=name]', 'Joana'); await j.fill('[name=phone]', '912345678'); await j.fill('[name=password]', PW); await j.check('[name=consent]');
    await j.click('#authf button[type=submit]'); await j.waitForSelector('[name=memberCode]'); expect(await j.textContent('.bk-err')).toContain('ID de membro');
    await j.fill('[name=memberCode]', 'RNR-ERRADO'); await j.click('#authf button[type=submit]'); await j.waitForSelector('.bk-err:has-text("não corresponde")');
    await j.fill('[name=memberCode]', 'rnr-joana1'); await j.click('#authf button[type=submit]'); await j.waitForSelector('.bk-tabs');
    expect((await pool.query("select count(*)::int n from customers where phone like '%912 345 678'")).rows[0].n).toBe(1);
  });
  it('dois clientes na mesma hora: só um fica; o outro vê aviso e escolhe outra', async () => {
    const go = async (pg: Page) => { await pg.click('[data-act=start]'); await pg.check('input[value=marcos]'); await pg.click('[data-act=to-services]'); await pg.check('input[value=barba]'); await pg.click('[data-act=to-time]'); await pickDay(pg, wed); };
    const a = await open(), b = await open(); await register(a, 'Ana', '912000111'); await register(b, 'Beto', '912000222'); await go(a); await go(b);
    await a.click('.bk-slot:has-text("12:00")'); await a.waitForSelector('[data-act=confirm]');
    await b.click('.bk-slot:has-text("12:00")'); await b.waitForSelector('.bk-err'); expect(await b.textContent('.bk-err')).toContain('ocupado');
    await a.click('[data-act=confirm]'); await a.waitForSelector('.bk-ok');
    await b.click('.bk-slot:has-text("12:30")'); await b.waitForSelector('[data-act=confirm]'); await b.click('[data-act=confirm]'); await b.waitForSelector('.bk-ok');
    expect((await pool.query("select start_min from bookings where employee_id='marcos' order by start_min")).rows.map(r => r.start_min)).toEqual([720, 750]);
  });
  it('marcação de outro cliente não abre; manifesto da app existe', async () => {
    const c = await open(); await register(c, 'Carla', '912000333'); await c.goto(base + '/marcar/#/marcacao/' + (await pool.query("select id from bookings limit 1")).rows[0].id); await c.waitForSelector('h1:has-text("não encontrada")'); await noOverflow(c);
    const m = await c.evaluate(async () => (await (await fetch('manifest.webmanifest')).json()).name); expect(m).toMatch(/Rock/);
  });
});
