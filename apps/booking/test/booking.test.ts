import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../api/src/app';
import { FakeNotifier } from '../../api/src/service';
import { migrate } from '../../api/src/migrate';

/** Cliente no telemóvel (390 px): marcar, minhas marcações, mudar a hora, cancelar, corrida de dois clientes. */
let pool: pg.Pool, app: FastifyInstance, base = '', browser: Browser;
const dayAt = (weekday: number, weeksAhead: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + ((weekday - d.getUTCDay() + 7) % 7 || 7) + 7 * weeksAhead); return d.toISOString().slice(0, 10); };
const wed = dayAt(3, 1), thu = dayAt(4, 1);

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

describe('Booking do cliente no telemóvel (390 px)', { timeout: 60000 }, () => {
  let p: Page, bookingUrl = '';
  it('fluxo completo: barbeiro, serviços, hora, dados, confirmação com ID de membro', async () => {
    p = await open(); await shot(p, 'c-barbeiro'); await noOverflow(p);
    expect(await p.locator('.bk-card').count()).toBe(3); // qualquer + 2 barbeiros
    await p.check('input[value=andre]'); await p.click('[data-act=to-services]');
    await p.check('input[value=corte]'); await p.waitForSelector('.bk-bar b:has-text("40 min")'); await shot(p, 'c-servicos'); await noOverflow(p);
    await p.click('[data-act=to-time]'); await pickDay(p, wed); await shot(p, 'c-hora'); await noOverflow(p);
    const s = await slots(p); expect(s[0]).toBe('09:00'); expect(s.every(x => /^\d\d:(00|30)$/.test(x))).toBe(true); // grelha de 30 min
    await p.click('.bk-slot:has-text("10:00")'); await p.waitForSelector('#bkf'); await shot(p, 'c-dados'); await noOverflow(p);
    await p.fill('[name=name]', 'Rui Cliente'); await p.fill('[name=phone]', '913 357 837');
    await p.click('#bkf button[type=submit]'); await p.waitForSelector('.bk-err'); expect(await p.textContent('.bk-err')).toContain('autoriza'); // sem consentimento não marca
    await p.check('[name=consent]'); await p.click('#bkf button[type=submit]'); await p.waitForSelector('.bk-ok');
    await shot(p, 'c-confirmada'); await noOverflow(p);
    expect(await p.textContent('.bk-member b')).toMatch(/^RNR-[A-Z0-9]{6}$/);
    const r = await pool.query("select b.start_min, b.employee_id, c.name from bookings b join customers c on c.id=b.customer_id"); expect(r.rows).toEqual([{ start_min: 600, employee_id: 'andre', name: 'Rui Cliente' }]);
    bookingUrl = await p.getAttribute('a:has-text("Ver ou alterar")', 'href') ?? '';
  });
  it('a hora marcada já não aparece; a pausa e o fim do corte respeitam a grelha', async () => {
    await p.click('[data-act=again]'); await p.check('input[value=andre]'); await p.click('[data-act=to-services]'); await p.check('input[value=corte]'); await p.click('[data-act=to-time]');
    await pickDay(p, wed); const s = await slots(p); expect(s).not.toContain('10:00'); expect(s).not.toContain('10:30'); expect(s).toContain('11:00'); // 10:00–10:40 ocupado, 10:40 arredonda para 11:00
  });
  it('minhas marcações lista a marcação e permite abrir', async () => {
    await p.goto(base + '/marcar/#/minhas'); await p.waitForSelector('.bk-item'); await shot(p, 'c-minhas'); await noOverflow(p);
    expect(await p.locator('.bk-item').count()).toBe(1); expect(await p.textContent('.bk-item')).toContain('Corte Premium');
    expect(await p.textContent('.bk-member b')).toMatch(/^RNR-/);
  });
  it('mudar a hora e cancelar (com confirmação)', async () => {
    await p.click('.bk-item'); await p.waitForSelector('[data-act=m-resched]'); await shot(p, 'c-gerir'); await noOverflow(p);
    await p.click('[data-act=m-resched]'); await pickDay(p, thu); const s = await slots(p); expect(s).toContain('09:00');
    await p.click('.bk-slot:has-text("15:00")'); await p.click('[data-act=m-confirm]'); await p.waitForSelector('h1:has-text("Hora alterada")');
    expect(await pool.query("select to_char(date,'YYYY-MM-DD') d, start_min from bookings")).toMatchObject({ rows: [{ d: thu, start_min: 900 }] });
    await p.click('[data-act=m-ask]'); await p.waitForSelector('.bk-warn'); await p.click('[data-act=m-keep]'); await p.waitForSelector('[data-act=m-ask]');
    await p.click('[data-act=m-ask]'); await p.click('[data-act=m-cancel]'); await p.waitForSelector('h1:has-text("Marcação cancelada")');
    expect((await pool.query('select status from bookings')).rows[0].status).toBe('cancelled');
  });
  it('dois clientes na mesma hora: só um fica; o outro vê aviso e escolhe outra', async () => {
    const fill = async (pg: Page, name: string, phone: string) => { await pg.fill('[name=name]', name); await pg.fill('[name=phone]', phone); await pg.check('[name=consent]'); };
    const go = async (pg: Page) => { await pg.check('input[value=marcos]'); await pg.click('[data-act=to-services]'); await pg.check('input[value=barba]'); await pg.click('[data-act=to-time]'); await pickDay(pg, wed); };
    const a = await open(), b = await open(); await go(a); await go(b);
    await a.click('.bk-slot:has-text("12:00")'); await a.waitForSelector('#bkf');
    await b.click('.bk-slot:has-text("12:00")'); await b.waitForSelector('.bk-err'); // reservada pelo A
    expect(await b.textContent('.bk-err')).toContain('ocupado');
    await fill(a, 'Ana', '912000111'); await a.click('#bkf button[type=submit]'); await a.waitForSelector('.bk-ok');
    await b.click('.bk-slot:has-text("12:30")'); await b.waitForSelector('#bkf'); await fill(b, 'Beto', '912000222'); await b.click('#bkf button[type=submit]'); await b.waitForSelector('.bk-ok');
    expect((await pool.query("select start_min from bookings where employee_id='marcos' order by start_min")).rows.map(r => r.start_min)).toEqual([720, 750]);
  });
  it('link de marcação inexistente e catálogo: mensagens claras, sem horizontal scroll', async () => {
    await p.goto(base + '/marcar/#/marcacao/00000000-0000-0000-0000-000000000000'); await p.waitForSelector('h1:has-text("não encontrada")'); await noOverflow(p);
    const m = await p.evaluate(async () => (await (await fetch('manifest.webmanifest')).json()).name); expect(m).toMatch(/Rock/);
  });
});
