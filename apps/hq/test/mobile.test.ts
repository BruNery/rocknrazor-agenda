import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../api/src/app';
import { FakeNotifier } from '../../api/src/service';
import { migrate } from '../../api/src/migrate';
import { hashPassword } from '../../api/src/auth';

/** Telemóvel: nenhuma vista pode obrigar a deslizar para os lados (a página tem de caber nos 390 px do ecrã). */
const PW = 'uma-palavra-passe-boa';
let pool: pg.Pool, app: FastifyInstance, base = '', browser: Browser;
const nextWed = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + ((3 - d.getUTCDay() + 7) % 7 || 7) + 7); return d.toISOString().slice(0, 10); })();

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: 'postgres://postgres@/postgres?host=/tmp&port=5544' }); await admin.connect();
  if (!(await admin.query("select 1 from pg_database where datname='rr_mobile'")).rowCount) await admin.query('create database rr_mobile'); await admin.end();
  pool = new pg.Pool({ connectionString: 'postgres://postgres@/rr_mobile?host=/tmp&port=5544', max: 10 });
  await pool.query('drop schema public cascade; create schema public;'); await migrate(pool);
  await pool.query(`insert into employees(id,name,nickname,sort_order) values ('andre','André','Link',1),('marcos','Marcos','Gringo',2),('margarida','Margarida','Maggie',3),('emanuel','Emanuel','Tito',4),('eduardo','Eduardo','Aquaman',5);
    insert into services(id,name,duration_min,price_cents) values ('corte','Corte Premium',40,1700),('barba','Barba',20,800);
    insert into employee_services(employee_id,service_id) select e.id, s.id from employees e, services s;
    insert into opening_hours(weekday,open_min,close_min) select d,540,1140 from generate_series(1,6) d`);
  await pool.query("insert into users(username, password_hash, role) values ('bruno', $1, 'admin')", [await hashPassword(PW)]);
  app = buildApp(pool, new FakeNotifier(), Date.now, { publicDir: fileURLToPath(new URL('../dist/pwa', import.meta.url)) });
  await app.listen({ port: 0, host: '127.0.0.1' }); base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
});
afterAll(async () => { await browser?.close(); await app?.close(); await pool?.end(); });

const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }); };
/** Largura da página (o que se vê ao deslizar) vs. largura do ecrã; e quem sai do ecrã fora de um contentor que já desliza por dentro. */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement, vw = doc.clientWidth;
    const scrollers = (el: Element | null): boolean => { while (el && el !== document.body) { const o = getComputedStyle(el).overflowX; if (o === 'auto' || o === 'scroll') return true; el = el.parentElement; } return false; };
    const out: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 1 && !scrollers(el.parentElement)) out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String((el as HTMLElement).className).split(' ').join('.')} right=${Math.round(r.right)}`);
    }
    return { vw, scrollWidth: doc.scrollWidth, bodyScroll: document.body.scrollWidth, out: out.slice(0, 12) };
  });
}
async function open(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage(); await page.addInitScript(() => { (window as any).RR_API = ''; });
  page.on('pageerror', e => { throw e; }); await page.goto(base + '/'); return page;
}

describe('HQ no telemóvel (390 px)', { timeout: 30000 }, () => {
  let p: Page;
  it('login cabe no ecrã', async () => {
    p = await open(); await p.waitForSelector('#loginf'); await shot(p, 'm-login');
    const o = await overflow(p); expect(o.scrollWidth, JSON.stringify(o)).toBeLessThanOrEqual(o.vw);
  });
  it('agenda cabe no ecrã', async () => {
    await p.fill('#l-user', 'bruno'); await p.fill('#l-pw', PW); await p.click('#loginf button[type=submit]'); await p.waitForSelector('.agenda');
    await shot(p, 'm-agenda'); const o = await overflow(p); expect(o.scrollWidth, JSON.stringify(o)).toBeLessThanOrEqual(o.vw); expect(o.out, JSON.stringify(o)).toEqual([]);
  });
  it('nova marcação e lista cabem no ecrã', async () => {
    await p.click('[data-act=new]'); await p.waitForSelector('#newf'); await shot(p, 'm-nova');
    let o = await overflow(p); expect(o.scrollWidth, JSON.stringify(o)).toBeLessThanOrEqual(o.vw); expect(o.out, JSON.stringify(o)).toEqual([]);
    await p.fill('#f-name', 'Rui Teste'); await p.fill('#f-phone', '913357837'); await p.selectOption('#f-emp', 'andre'); await p.fill('#f-date', nextWed); await p.fill('#f-time', '10:00');
    await p.click('#newf button[type=submit]'); await p.waitForSelector('.toast');
    await p.waitForSelector('.blk'); await shot(p, 'm-agenda-marcacao');
    await p.click('.blk'); await p.waitForSelector('.drawer'); await shot(p, 'm-ficha');
    o = await overflow(p); expect(o.scrollWidth, JSON.stringify(o)).toBeLessThanOrEqual(o.vw); expect(o.out, JSON.stringify(o)).toEqual([]);
  });
  it('toque abre; deslizar na agenda faz scroll sem abrir nada (livre ou em cima de uma marcação)', async () => {
    await p.keyboard.press('Escape'); await p.waitForSelector('.agenda'); await p.waitForSelector('.drawer', { state: 'detached' });
    const cdp = await p.context().newCDPSession(p);
    const touch = async (type: string, x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const swipe = async (x: number, y0: number, y1: number) => { await touch('touchStart', x, y0); for (let i = 1; i <= 8; i++) { await touch('touchMove', x, y0 + ((y1 - y0) * i) / 8); await p.waitForTimeout(16); } await touch('touchEnd', 0, 0); await p.waitForTimeout(250); };
    const top = () => p.evaluate(() => document.getElementById('agenda')!.scrollTop);
    const t0 = await top();
    await swipe(300, 600, 300); // por cima de uma coluna vazia (Marcos/Margarida)
    expect(await top(), 'a agenda tem de deslizar').toBeGreaterThan(t0 + 100);
    expect(await p.locator('#newf').count(), 'deslizar não pode abrir a nova marcação').toBe(0);
    await p.evaluate(() => { document.getElementById('agenda')!.scrollTop = 0; });
    const b = await p.locator('.blk').first().boundingBox(); const bx = b!.x + b!.width / 2, by = b!.y + b!.height / 2;
    const t1 = await top(); await swipe(bx, by + 40, by - 200);
    expect(await top(), 'deslizar a partir de uma marcação também faz scroll').toBeGreaterThan(t1 + 50);
    expect(await p.locator('.drawer').count(), 'e não abre a ficha').toBe(0);
    await p.evaluate(() => { document.getElementById('agenda')!.scrollTop = 0; });
    const b2 = await p.locator('.blk').first().boundingBox(); await touch('touchStart', b2!.x + 20, b2!.y + 10); await touch('touchEnd', 0, 0); await p.waitForSelector('.drawer'); // toque curto abre a ficha
    await p.keyboard.press('Escape'); await p.waitForSelector('.drawer', { state: 'detached' });
    const free = await p.locator('.col').nth(2).boundingBox(); await touch('touchStart', free!.x + 20, free!.y + 300); await touch('touchEnd', 0, 0); await p.waitForSelector('#newf'); // toque numa hora livre abre a nova marcação
    await p.keyboard.press('Escape');
  });
  it('definições cabem no ecrã', async () => {
    await p.reload(); await p.waitForSelector('.agenda'); await p.click('[data-view=cfg]'); await p.waitForTimeout(400); await shot(p, 'm-cfg');
    const o = await overflow(p); expect(o.scrollWidth, JSON.stringify(o)).toBeLessThanOrEqual(o.vw); expect(o.out, JSON.stringify(o)).toEqual([]);
  });
});
