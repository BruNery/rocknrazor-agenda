import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const url = 'file://' + fileURLToPath(new URL('../dist/index.html', import.meta.url));
let browser: Browser; let page: Page; const errors: string[] = [];
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox'] }); });
afterAll(async () => { await browser.close(); });
afterEach(async () => { await page?.close(); });

// quarta-feira 14/10/2026, 08:00 em Lisboa (cada teste começa com uma página nova e dados de exemplo novos)
async function open(hash = '#/reservar', viewport = { width: 420, height: 860 }) {
  page = await browser.newPage({ viewport }); page.on('pageerror', e => errors.push(e.message));
  await page.clock.install({ time: new Date('2026-10-14T06:59:00Z') });
  await page.goto(url + hash);
  await page.clock.pauseAt(new Date('2026-10-14T07:00:00Z')); // relógio parado: 08:00 em Lisboa, nada depende da velocidade do teste
}
const TOMORROW = '2026-10-15';
async function chooseService(ids = ['corte']) { for (const id of ids) await page.check(`input[name=svc][value=${id}]`); await page.click('[data-act=to-barber]'); }
async function toTime(emp = 'any', svcs = ['corte']) { await chooseService(svcs); await page.check(`input[name=emp][value=${emp}]`); await page.click('[data-act=to-time]'); }
const slotTimes = () => page.locator('.bk-slot').allTextContents();
async function fillAndConfirm(name = 'EL TESTE ONLINE', phone = '911 222 333') {
  await page.fill('input[name=name]', name); await page.fill('input[name=phone]', phone); await page.check('input[name=consent]'); await page.click('#bkf button[type=submit]');
}
async function book(date = TOMORROW, name?: string, phone?: string, emp = 'any', time?: string) {
  await toTime(emp); await page.click(`[data-act=day][data-v="${date}"]`);
  await page.click(time ? `.bk-slot:text-is("${time}")` : '.bk-slot >> nth=0'); await fillAndConfirm(name, phone);
  await page.waitForSelector('.bk-ok');
}

describe('Booking: fluxo do cliente', { timeout: 20000 }, () => {
  it('serviço → barbeiro → dia → hora → dados → confirmação, e a marcação aparece na agenda com aviso ao barbeiro', async () => {
    await open();
    expect(await page.locator('.bk-btn[data-act=to-barber]').isDisabled()).toBe(true); // sem serviço não avança
    await book(TOMORROW, 'EL TESTE ONLINE', '911 222 333', 'any', '10:00');
    expect(await page.textContent('.bk-ok h1')).toContain('Marcação confirmada');
    const b = await page.evaluate(() => { const s = (window as any).__rr.store; const x = s.bookings.find((y: any) => y.source === 'online' && y.date === '2026-10-15' && y.startMin === 600); return { emp: x.employeeId, src: x.source, end: x.endMin, notes: s.notes[0].text, cust: s.customer(x.customerId).name }; });
    expect(b.src).toBe('online'); expect(b.end).toBe(640); expect(b.cust).toBe('EL TESTE ONLINE'); expect(b.notes).toContain('Nova marcação online');
    await page.goto(url + '#/'); // volta ao HQ
    await page.waitForSelector('#agenda'); await page.click('[data-step="1"]');
    expect(await page.locator('.blk', { hasText: 'EL TESTE ONLINE' }).count()).toBe(1);
  });
  it('sem autorização de dados não marca; com telefone inválido também não', async () => {
    await open(); await toTime(); await page.click(`[data-act=day][data-v="${TOMORROW}"]`); await page.click('.bk-slot >> nth=0');
    await page.fill('input[name=name]', 'Ana'); await page.fill('input[name=phone]', '911222333'); await page.click('#bkf button[type=submit]');
    expect(await page.textContent('.bk-err')).toContain('autorização');
    await page.fill('input[name=phone]', '123'); await page.check('input[name=consent]'); await page.click('#bkf button[type=submit]');
    expect(await page.textContent('.bk-err')).toContain('telefone');
    expect(await page.evaluate(() => (window as any).__rr.store.bookings.filter((b: any) => b.token).length)).toBe(0);
  });
  it('só oferece horas realmente livres: sem sobreposição, 1 h de antecedência, domingo fechado, máximo 8 semanas', async () => {
    await open(); await toTime('marcos');
    await page.click('[data-act=day][data-v="2026-10-14"]'); // hoje: agora são 08:00; Marcos tem corte às 14:00 (40 min)
    const t = await slotTimes();
    expect(t[0]).toBe('09:00'); // 1 h depois de agora
    for (const x of ['13:30', '13:40', '14:00', '14:30']) expect(t).not.toContain(x); // 13:30 sobreporia as 14:00; 14:30 ainda está ocupado
    expect(t).toContain('13:20'); expect(t).toContain('14:40'); // termina às 14:00 / começa depois das 14:40
    expect(await page.locator('[data-act=day][data-v="2026-10-18"]').isDisabled()).toBe(true); // domingo
    expect(await page.locator('[data-act=day][data-v="2026-12-09"]').count()).toBe(0); // passa das 8 semanas (só aparece com "Mais dias", e mesmo assim não existe)
    for (let i = 0; i < 4; i++) { const m = page.locator('[data-act=more]'); if (await m.count()) await m.click(); }
    expect(await page.locator('.bk-day').count()).toBe(57);
    expect(await page.locator('[data-act=day][data-v="2026-12-09"]').count()).toBe(1); // hoje + 56 dias (inclusive)
    expect(await page.locator('[data-act=day][data-v="2026-12-10"]').count()).toBe(0);
  });
  it('"qualquer barbeiro" atribui um barbeiro livre; reserva temporária bloqueia a hora para os outros', async () => {
    await open(); await toTime(); await page.click(`[data-act=day][data-v="${TOMORROW}"]`); await page.click('.bk-slot:text-is("11:00")');
    await page.waitForSelector('#bkf');
    const holdEmp = await page.evaluate(() => (window as any).__rr.store.holds[0].employeeId);
    expect(holdEmp).toBeTruthy();
    // outro cliente a ver as mesmas horas: o barbeiro com a hora presa não a oferece
    const other = await page.evaluate((e) => (window as any).__rr.store.availability('2026-10-15', ['corte'], e).some((s: any) => s.startMin === 660), holdEmp);
    expect(other).toBe(false);
  });
  it('a reserva temporária expira ao fim de 5 minutos e liberta a hora', async () => {
    await open(); await toTime(); await page.click(`[data-act=day][data-v="${TOMORROW}"]`); await page.click('.bk-slot:text-is("11:00")'); await page.waitForSelector('#bkf');
    expect(await page.textContent('#hold-left')).toBe('5:00');
    await page.clock.fastForward(5 * 60_000 + 1500);
    await page.waitForSelector('.bk-err');
    expect(await page.textContent('.bk-err')).toContain('tempo da reserva');
    expect(await page.locator('.bk-slot').count()).toBeGreaterThan(0);
  });
  it('o link do WhatsApp pode trazer o telefone; não revela dados de clientes existentes', async () => {
    await open('#/reservar?tel=913357837&barbeiro=andre');
    await chooseService(); // barbeiro pré-escolhido
    expect(await page.isChecked('input[name=emp][value=andre]')).toBe(true);
    await page.click('[data-act=to-time]'); await page.click(`[data-act=day][data-v="${TOMORROW}"]`); await page.click('.bk-slot >> nth=0');
    expect(await page.inputValue('input[name=phone]')).toBe('913357837');
    expect(await page.inputValue('input[name=name]')).toBe(''); // o nome do cliente "Gonçalo" não é preenchido por um link adivinhável
  });
  it('limite de marcações em aberto por telefone', async () => {
    await open();
    for (const d of ['2026-10-15', '2026-10-16', '2026-10-17']) { await book(d, 'Abusador', '900 111 222'); await page.click('[data-act=again]'); }
    await toTime(); await page.click('[data-act=day][data-v="2026-10-19"]'); await page.click('.bk-slot >> nth=0'); await fillAndConfirm('Abusador', '900 111 222');
    expect(await page.textContent('.bk-err')).toContain('3 marcações em aberto');
  });
  it('mobile 390 px sem rolagem horizontal; foco no título ao mudar de passo', async () => {
    await open('#/reservar', { width: 390, height: 780 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await toTime(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H1');
  });
  it('modo claro e escuro: texto e botões com contraste suficiente', async () => {
    await open();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const c = await page.evaluate(() => {
        const px = (el: Element, p: 'color' | 'backgroundColor') => getComputedStyle(el)[p].match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
        const L = (r: number[]) => { const [R, G, B] = r.map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * R + .7152 * G + .0722 * B; };
        const ratio = (a: number[], b: number[]) => { const x = L(a), y = L(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
        const btn = document.querySelector('.bk-bar .bk-btn')!, muted = document.querySelector('.bk-card small')!, card = document.querySelector('.bk-card')!;
        return { text: ratio(px(document.querySelector('.bk-h1')!, 'color'), px(document.body, 'backgroundColor')), btn: ratio(px(btn, 'color'), px(btn, 'backgroundColor')), muted: ratio(px(muted, 'color'), px(card, 'backgroundColor')) };
      });
      expect(c.text).toBeGreaterThan(7); expect(c.btn).toBeGreaterThan(4.5); expect(c.muted).toBeGreaterThan(4.5);
    }
  });
});

describe('Booking: gerir a marcação (cancelar e reagendar)', { timeout: 20000 }, () => {
  const token = () => page.evaluate(() => (window as any).__rr.store.bookings.find((b: any) => b.token).token);
  it('cancelar libertando a hora e avisando o barbeiro (pede confirmação)', async () => {
    await open(); await book(TOMORROW, 'Cancelador', '922 000 111', 'marcos', '11:00');
    await page.click('a[href^="#/marcacao/"]'); await page.waitForSelector('[data-act=m-ask]');
    await page.click('[data-act=m-ask]'); await page.click('[data-act=m-keep]'); // "Manter" não cancela
    expect(await page.evaluate(() => (window as any).__rr.store.bookings.find((b: any) => b.token).status)).toBe('confirmed');
    await page.click('[data-act=m-ask]'); await page.click('[data-act=m-cancel]');
    expect(await page.textContent('.bk-h1')).toContain('cancelada');
    const r = await page.evaluate(() => { const s = (window as any).__rr.store; return { st: s.bookings.find((b: any) => b.token).status, free: s.availability('2026-10-15', ['corte'], 'marcos').some((x: any) => x.startMin === 660), note: s.notes[0].text }; });
    expect(r.st).toBe('cancelled'); expect(r.free).toBe(true); expect(r.note).toContain('cancelada pelo cliente');
  });
  it('reagendar para outra hora livre; a hora antiga fica livre e a nova ocupada', async () => {
    await open(); await book(TOMORROW, 'Mudador', '933 000 111', 'marcos', '11:00');
    await page.click('a[href^="#/marcacao/"]'); await page.click('[data-act=m-resched]');
    await page.click('[data-act=day][data-v="2026-10-16"]'); await page.click('.bk-slot:text-is("15:00")'); await page.click('[data-act=m-confirm]');
    expect(await page.textContent('.bk-h1')).toContain('Hora alterada');
    const r = await page.evaluate(() => { const s = (window as any).__rr.store; const b = s.bookings.find((x: any) => x.token); return { date: b.date, start: b.startMin, oldFree: s.availability('2026-10-15', ['corte'], 'marcos').some((x: any) => x.startMin === 660), newFree: s.availability('2026-10-16', ['corte'], 'marcos').some((x: any) => x.startMin === 900) }; });
    expect(r).toEqual({ date: '2026-10-16', start: 900, oldFree: true, newFree: false });
  });
  it('a menos de 3 h da marcação já não se pode cancelar nem mudar online', async () => {
    await open(); await book('2026-10-14', 'Em cima da hora', '944 000 111', 'marcos', '09:00'); // agora 08:00: faltam 1 h
    await page.click('a[href^="#/marcacao/"]'); await page.waitForSelector('.bk-sum');
    expect(await page.locator('[data-act=m-ask], [data-act=m-resched]').count()).toBe(0);
    expect(await page.textContent('main')).toContain('menos de 3 horas');
    expect(await page.evaluate(() => (window as any).__rr.store.cancelOnline((window as any).__rr.store.bookings.find((b: any) => b.token).token))).toEqual({ ok: false, error: 'fora_do_prazo' });
  });
  it('link inválido não mostra nada de ninguém', async () => {
    await open('#/marcacao/abc123'); expect(await page.textContent('.bk-h1')).toContain('não encontrada');
  });
});

describe('sem erros de script', () => { it('nenhum erro na consola', () => { expect(errors).toEqual([]); }); });
