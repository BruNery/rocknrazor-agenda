import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../api/src/app';
import { FakeNotifier } from '../../api/src/service';
import { migrate } from '../../api/src/migrate';
import { hashPassword } from '../../api/src/auth';

/** Teste de ponta a ponta com o servidor verdadeiro e uma base de dados verdadeira: o que o Bruno faz no HQ fica mesmo gravado. */
const PW = 'uma-palavra-passe-boa';
let pool: pg.Pool, app: FastifyInstance, base = '', browser: Browser;
const nextWed = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + ((3 - d.getUTCDay() + 7) % 7 || 7) + 7); return d.toISOString().slice(0, 10); })();

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: 'postgres://postgres@/postgres?host=/tmp&port=5544' }); await admin.connect();
  if (!(await admin.query("select 1 from pg_database where datname='rr_live'")).rowCount) await admin.query('create database rr_live'); await admin.end();
  pool = new pg.Pool({ connectionString: 'postgres://postgres@/rr_live?host=/tmp&port=5544', max: 10 });
  await pool.query('drop schema public cascade; create schema public;'); await migrate(pool);
  await pool.query(`insert into employees(id,name,nickname,sort_order) values ('andre','André','Link',1),('marcos','Marcos','Gringo',2);
    insert into services(id,name,duration_min,price_cents) values ('corte','Corte Premium',40,1700),('barba','Barba',20,800);
    insert into employee_services(employee_id,service_id) values ('andre','corte'),('andre','barba'),('marcos','corte'),('marcos','barba');
    insert into opening_hours(weekday,open_min,close_min) select d,540,1140 from generate_series(1,6) d`);
  await pool.query("insert into users(username, password_hash, role) values ('bruno', $1, 'admin')", [await hashPassword(PW)]);
  app = buildApp(pool, new FakeNotifier(), Date.now, { publicDir: fileURLToPath(new URL('../dist/pwa', import.meta.url)) });
  await app.listen({ port: 0, host: '127.0.0.1' }); base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
});
afterAll(async () => { await browser?.close(); await app?.close(); await pool?.end(); });

async function open(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } }); const page = await ctx.newPage();
  await page.addInitScript(() => { (window as any).RR_API = ''; });
  page.on('pageerror', e => { throw e; });
  await page.goto(base + '/'); return page;
}
async function login(page: Page, user: string, pw: string) { await page.fill('#l-user', user); await page.fill('#l-pw', pw); await page.click('#loginf button[type=submit]'); }
/** Espera por um aviso NOVO (apaga primeiro o anterior, que fica 3 s no ecrã). */
const clearToast = (page: Page) => page.evaluate(() => { (window as any).__rr.S.toast = ''; document.querySelector('.toast')?.remove(); });
const toast = (page: Page, text: string) => page.waitForSelector(`.toast:has-text("${text}")`);
const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }); };
const act = async (page: Page, sel: string, text: string) => { await clearToast(page); await page.click(sel); await toast(page, text); };

describe('HQ ligado ao servidor', { timeout: 20000 }, () => {
  let admin: Page;
  it('pede login; palavra-passe errada recusa; a certa abre a agenda com a equipa e as Definições', async () => {
    admin = await open(); await admin.waitForSelector('#loginf');
    await login(admin, 'bruno', 'errada-errada'); await admin.waitForSelector('.err:has-text("errados")');
    await login(admin, 'bruno', PW); await admin.waitForSelector('.agenda');
    expect(await admin.textContent('.head')).toContain('André (Link)'); expect(await admin.textContent('.head')).toContain('Marcos (Gringo)');
    expect(await admin.locator('[data-view=cfg]').count()).toBe(1);
  });
  it('nova marcação grava no servidor e liga o cliente pelo telefone', async () => {
    await admin.click('[data-act=new]'); await admin.fill('#f-name', 'Rui Teste'); await admin.fill('#f-phone', '913357837'); await admin.selectOption('#f-emp', 'andre');
    await admin.fill('#f-date', nextWed); await admin.fill('#f-time', '10:00'); await act(admin, '#newf button[type=submit]', 'Marcação criada');
    const r = await pool.query("select b.start_min, b.employee_id, c.name, c.phone from bookings b join customers c on c.id = b.customer_id"); expect(r.rows).toEqual([{ start_min: 600, employee_id: 'andre', name: 'Rui Teste', phone: '+351 913357837' }]);
  });
  it('marcação sobreposta pede confirmação; ao confirmar grava', async () => {
    await admin.click('[data-act=new]'); await admin.fill('#f-name', 'Outro Cliente'); await admin.fill('#f-phone', '922222222'); await admin.selectOption('#f-emp', 'andre');
    await admin.fill('#f-date', nextWed); await admin.fill('#f-time', '10:10'); await admin.click('#newf button[type=submit]');
    await admin.waitForSelector('.dlg:has-text("Conflito de marcações")'); await act(admin, '[data-act=m-force]', 'Marcação criada');
    expect((await pool.query('select count(*)::int n from bookings')).rows[0].n).toBe(2);
  });
  it('Definições › Serviços: mudar o preço grava e passa a valer logo', async () => {
    await admin.click('[data-view=cfg]'); await admin.click('[data-cfg=tab][data-v=servicos]');
    await admin.fill('form[data-cfg=svc-save][data-id=corte] input[name=price]', '20'); await act(admin, 'form[data-cfg=svc-save][data-id=corte] button[type=submit]', 'Serviço guardado');
    expect((await pool.query("select price_cents from services where id='corte'")).rows[0].price_cents).toBe(2000);
    await admin.fill('form[data-cfg=svc-new] input[name=name]', 'Rockstar Trim'); await admin.fill('form[data-cfg=svc-new] input[name=price]', '25'); await admin.fill('form[data-cfg=svc-new] input[name=dur]', '60');
    await act(admin, 'form[data-cfg=svc-new] button[type=submit]', 'Serviço adicionado');
    expect((await pool.query("select name, duration_min, price_cents from services where id='rockstar-trim'")).rows).toEqual([{ name: 'Rockstar Trim', duration_min: 60, price_cents: 2500 }]);
  });
  it('Definições › Regras: guarda a reserva temporária e o prazo de cancelamento', async () => {
    await admin.click('[data-cfg=tab][data-v=regras]'); await admin.fill('form[data-cfg=rules] input[name=holdMin]', '7'); await admin.fill('form[data-cfg=rules] input[name=cancelH]', '2');
    await admin.selectOption('form[data-cfg=rules] select[name=policy]', 'first_in_order'); await admin.check('form[data-cfg=rules] input[name=overlap]'); await act(admin, 'form[data-cfg=rules] button[type=submit]', 'Regras guardadas');
    expect((await pool.query('select hold_min, cancel_lead_min, any_barber_policy, allow_online_overlap from shop_settings')).rows[0]).toEqual({ hold_min: 7, cancel_lead_min: 120, any_barber_policy: 'first_in_order', allow_online_overlap: true });
  });
  it('Definições › Regras: horários do cliente de 30 em 30 e hora logo a seguir ao fim de outra marcação (ligado por defeito; dá para mudar)', async () => {
    expect((await pool.query('select grid_min, snap_after_end from shop_settings')).rows[0]).toEqual({ grid_min: 30, snap_after_end: true });
    expect(await admin.isChecked('form[data-cfg=rules] input[name=snap]')).toBe(true); expect(await admin.inputValue('form[data-cfg=rules] select[name=grid]')).toBe('30');
    await admin.uncheck('form[data-cfg=rules] input[name=snap]'); await admin.selectOption('form[data-cfg=rules] select[name=grid]', '15'); await act(admin, 'form[data-cfg=rules] button[type=submit]', 'Regras guardadas');
    expect((await pool.query('select grid_min, snap_after_end from shop_settings')).rows[0]).toEqual({ grid_min: 15, snap_after_end: false });
    await admin.check('form[data-cfg=rules] input[name=snap]'); await admin.selectOption('form[data-cfg=rules] select[name=grid]', '30'); await act(admin, 'form[data-cfg=rules] button[type=submit]', 'Regras guardadas');
    expect((await pool.query('select grid_min, snap_after_end from shop_settings')).rows[0]).toEqual({ grid_min: 30, snap_after_end: true });
  });
  it('Definições › Equipa: adicionar barbeiro, criar-lhe o acesso e desativar', async () => {
    await shot(admin, 'regras'); await admin.click('[data-cfg=tab][data-v=equipa]');
    await admin.fill('form[data-cfg=emp-new] input[name=name]', 'Eduardo'); await admin.fill('form[data-cfg=emp-new] input[name=nick]', 'Aquaman'); await act(admin, 'form[data-cfg=emp-new] button[type=submit]', 'Barbeiro adicionado');
    expect((await pool.query("select name, nickname from employees where id='eduardo'")).rows).toEqual([{ name: 'Eduardo', nickname: 'Aquaman' }]);
    await admin.locator('section.card', { hasText: 'Marcos' }).locator('summary:has-text("Acesso")').click();
    await admin.fill('form[data-cfg=user-new][data-id=marcos] input[name=user]', 'marcos'); await admin.fill('form[data-cfg=user-new][data-id=marcos] input[name=pw]', PW); await act(admin, 'form[data-cfg=user-new][data-id=marcos] button[type=submit]', 'Acesso criado');
    expect((await pool.query("select role, employee_id from users where username='marcos'")).rows).toEqual([{ role: 'barber', employee_id: 'marcos' }]);
    await admin.selectOption('form[data-cfg=emp-save][data-id=eduardo] select[name=active]', '0'); await act(admin, 'form[data-cfg=emp-save][data-id=eduardo] button[type=submit]', 'Barbeiro guardado');
    expect((await pool.query("select active from employees where id='eduardo'")).rows[0].active).toBe(false);
  });
  it('Definições › Pontos: procurar o cliente e somar pontos com motivo; retirar mais do que o saldo é recusado', async () => {
    await shot(admin, 'equipa'); await admin.click('[data-cfg=tab][data-v=pontos]'); await admin.fill('form[data-cfg=pts-search] input[name=q]', 'Rui'); await admin.click('form[data-cfg=pts-search] button[type=submit]');
    await admin.click('[data-cfg=pts-pick]'); await admin.fill('form[data-cfg=pts-adjust] input[name=n]', '50'); await admin.fill('form[data-cfg=pts-adjust] input[name=note]', 'Oferta de boas-vindas'); await act(admin, 'form[data-cfg=pts-adjust] button[type=submit]', 'Pontos atualizados');
    await shot(admin, 'pontos'); expect(await admin.textContent('.cfg')).toMatch(/50 pontos/); expect(await admin.textContent('.cfg')).toMatch(/RNR-[A-Z2-9]{6}/);
    await admin.selectOption('form[data-cfg=pts-adjust] select[name=dir]', '-1'); await admin.fill('form[data-cfg=pts-adjust] input[name=n]', '80'); await admin.fill('form[data-cfg=pts-adjust] input[name=note]', 'Correção'); await act(admin, 'form[data-cfg=pts-adjust] button[type=submit]', 'não pode ficar negativo');
    expect((await pool.query('select coalesce(sum(delta),0)::int n from points_ledger')).rows[0].n).toBe(50);
  });
  it('registar o atendimento grava a venda', async () => {
    await admin.evaluate(n => { (window as any).__rr.S.view = 'day'; (window as any).__rr.S.date = n; }, nextWed); await admin.click('[data-view=day]');
    await admin.click('.blk >> text=Rui Teste'); await admin.click('[data-act=d-sale]'); await act(admin, '#salef button[type=submit]', 'Atendimento registado');
    expect((await pool.query('select count(*)::int n from sales')).rows[0].n).toBe(1);
  });

  let marcos: Page;
  it('o barbeiro entra: só vê a sua coluna, sem Definições, e a marcação do colega não aparece', async () => {
    await admin.keyboard.press('Escape'); await admin.click('[data-act=logout]'); await admin.waitForSelector('#loginf'); await admin.context().close();
    marcos = await open(); await login(marcos, 'marcos', PW); await marcos.waitForSelector('.agenda, .err', { timeout: 8000 });
    const head = await marcos.textContent('.head'); expect(head).toContain('Marcos'); expect(head).not.toContain('André');
    expect(await marcos.locator('[data-view=cfg]').count()).toBe(0); expect(await marcos.locator('[data-view=mine]').count()).toBe(1);
    expect(await marcos.evaluate(() => (window as any).__rr.store.bookings.length)).toBe(0);
  });
  it('o barbeiro define a sua pausa de almoço e fecha um dia; o servidor recusa-lhe as áreas de admin', async () => {
    await marcos.click('[data-view=mine]'); await marcos.waitForSelector('form[data-cfg=pause-add]');
    await act(marcos, 'form[data-cfg=pause-add] button[type=submit]', 'Pausa adicionada');
    expect((await pool.query("select count(*)::int n from employee_pauses where employee_id='marcos'")).rows[0].n).toBe(6);
    await act(marcos, 'form[data-cfg=block-add] button[type=submit]', 'Horário fechado');
    expect((await pool.query("select all_day from blocks where employee_id='marcos'")).rows).toEqual([{ all_day: true }]);
    const st = await marcos.evaluate(async () => [(await fetch('/admin/settings')).status, (await fetch('/admin/customers?q=a')).status, (await fetch('/admin/users')).status]);
    expect(st).toEqual([403, 403, 403]);
  });
  it('a pausa do barbeiro tira esses horários do Booking público', async () => {
    const d = (await pool.query("select to_char(date_trunc('week', now()) + interval '9 days','YYYY-MM-DD') d")).rows[0].d; // uma 3.ª-feira futura
    const slots = (await (await fetch(`${base}/public/availability?date=${d}&services=corte&employeeId=marcos`)).json()).slots as { startMin: number }[];
    expect(slots.some(s => s.startMin >= 780 && s.startMin < 840)).toBe(false);
  });
  it('tempo real: uma marcação feita noutro aparelho aparece sozinha (sem recarregar) e não estraga o que se está a escrever', async () => {
    const other = await open(); await other.waitForSelector('#loginf'); await login(other, 'bruno', PW); await other.waitForSelector('.agenda');
    await other.evaluate(d => { (window as any).__rr.S.date = d; }, nextWed); await other.click('[data-zoom="2"]'); await other.click('[data-zoom="-2"]');
    expect(await other.locator('.blk:has-text("Online Ana")').count()).toBe(0);
    const mk = (name: string, startMin: number, phone: string) => fetch(`${base}/public/bookings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customer: { name, phone }, date: nextWed, startMin, serviceIds: ['corte'], employeeId: 'marcos' }) }).then(r => r.json());
    expect((await mk('Online Ana', 840, '911000121')).ok).toBe(true); // outro aparelho (o cliente a marcar online)
    await other.waitForSelector('.blk:has-text("Online Ana")', { timeout: 4000 });
    // a escrever numa nova marcação: chega outra marcação e o formulário mantém o que estava escrito
    await other.click('[data-act=new]'); await other.fill('#f-name', 'A escrever…');
    expect((await mk('Online Beto', 900, '911000122')).ok).toBe(true);
    await other.waitForSelector('.blk:has-text("Online Beto")', { timeout: 4000 });
    expect(await other.inputValue('#f-name')).toBe('A escrever…');
    await other.context().close();
  });
  it('A minha conta: o administrador muda a própria palavra-passe (a atual errada é recusada)', async () => {
    const admin = await open(); await admin.waitForSelector('#loginf'); await login(admin, 'bruno', PW); await admin.waitForSelector('.agenda');
    await admin.click('[data-view=mine]'); await admin.waitForSelector('form[data-cfg=mypw]');
    const fill = async (cur: string, a: string, b: string) => { await admin.fill('form[data-cfg=mypw] [name=cur]', cur); await admin.fill('form[data-cfg=mypw] [name=pw]', a); await admin.fill('form[data-cfg=mypw] [name=pw2]', b); };
    await fill('errada-errada', 'a-nova-palavra-longa', 'a-nova-palavra-longa'); await act(admin, 'form[data-cfg=mypw] button[type=submit]', 'não está certa');
    await fill(PW, 'a-nova-palavra-longa', 'diferente-diferente'); await act(admin, 'form[data-cfg=mypw] button[type=submit]', 'não são iguais');
    await fill(PW, 'a-nova-palavra-longa', 'a-nova-palavra-longa'); await act(admin, 'form[data-cfg=mypw] button[type=submit]', 'Palavra-passe mudada');
    const tryLogin = async (pw: string) => (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'bruno', password: pw }) })).status;
    expect(await tryLogin(PW)).toBe(401); expect(await tryLogin('a-nova-palavra-longa')).toBe(200);
  });
  it('Nova marcação / Mover: ao escolher o dia aparecem os horários livres (ocupados e pausas ficam de fora)', async () => {
    const p = await open(); await p.waitForSelector('#loginf'); await login(p, 'bruno', 'a-nova-palavra-longa'); await p.waitForSelector('.agenda');
    await p.click('[data-act=new]'); await p.selectOption('#f-emp', 'andre'); await p.fill('#f-date', nextWed); await p.dispatchEvent('#f-date', 'change');
    await p.waitForSelector('#slots-m .slot');
    expect(await p.locator('#slots-m .slot:text-is("10:00")').count()).toBe(0); // o André tem o Rui Teste às 10:00
    expect(await p.locator('#slots-m .slot:text-is("11:00")').count()).toBe(1);
    const later = new Date(nextWed + 'T00:00:00Z'); later.setUTCDate(later.getUTCDate() + 21); const d2 = later.toISOString().slice(0, 10);
    await p.selectOption('#f-emp', 'marcos'); await p.fill('#f-date', d2); await p.dispatchEvent('#f-date', 'change');
    await p.waitForFunction(() => document.querySelector('#slots-m .slotsh')?.textContent?.includes('Marcos'));
    expect(await p.locator('#slots-m .slot:text-is("13:00")').count()).toBe(0); // pausa de almoço do Marcos
    expect(await p.locator('#slots-m .slot:text-is("12:00")').count()).toBe(1);
    await p.click('#slots-m .slot:text-is("11:00")');
    expect(await p.inputValue('#f-time')).toBe('11:00'); expect(await p.locator('#slots-m .slot.on').textContent()).toBe('11:00');
    await shot(p, 'horarios-livres');
    await p.selectOption('#f-emp', 'andre'); await p.fill('#f-date', '2000-01-03'); await p.dispatchEvent('#f-date', 'change');
    expect(await p.textContent('#slots-m')).toContain('já passou');
  });
});
