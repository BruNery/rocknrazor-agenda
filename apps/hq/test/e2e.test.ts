import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const url = 'file://' + fileURLToPath(new URL('../dist/index.html', import.meta.url));
let browser: Browser, page: Page; const errors: string[] = [];
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', e => errors.push(e.message));
  // data de teste: quarta-feira fixa, 08:00 em Lisboa
  await page.clock.install({ time: new Date('2026-10-14T07:00:00Z') });
  await page.goto(url);
});
afterAll(async () => { await browser.close(); });

const colBox = async (i: number) => (await page.locator('.col').nth(i).boundingBox())!;
const clickSlot = async (col: number, minutes: number) => { const b = await colBox(col); await page.mouse.click(b.x + b.width * 0.5, b.y + ((minutes - 540) / 10) * 16 + 3); };

describe('HQ: agenda', () => {
  it('mostra os 4 colaboradores, marcações e bloqueios do dia', async () => {
    expect(await page.locator('.head div').allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining('André'), expect.stringContaining('Mags')]));
    expect(await page.locator('.col').count()).toBe(4);
    expect(await page.locator('.blk').count()).toBeGreaterThanOrEqual(4);
    expect(await page.locator('.blocked').count()).toBeGreaterThanOrEqual(2);
  });
  it('clicar numa hora livre abre a nova marcação com a hora certa e cria sem conflito', async () => {
    await clickSlot(1, 660); // Marcos, 11:00
    await page.waitForSelector('#newf');
    expect(await page.inputValue('#f-time')).toBe('11:00');
    await page.fill('#f-name', 'EL TESTE'); await page.click('#newf button[type=submit]');
    await page.waitForSelector('.toast');
    expect(await page.locator('.blk', { hasText: 'EL TESTE' }).count()).toBe(1);
  });
  it('conflito pede confirmação; "Voltar" não cria, "Marcar mesmo assim" cria sobreposto', async () => {
    await clickSlot(2, 960); await page.selectOption('#f-emp', 'marcos'); await page.fill('#f-time', '11:10'); await page.fill('#f-name', 'SOBRE'); await page.click('#newf button[type=submit]');
    await page.waitForSelector('text=Conflito de marcações');
    await page.click('[data-act=m-no]');
    expect(await page.inputValue('#f-name')).toBe('SOBRE'); // voltou ao formulário com os dados
    expect(await page.locator('.blk', { hasText: 'SOBRE' }).count()).toBe(0);
    await page.click('#newf button[type=submit]'); await page.click('[data-act=m-force]');
    await page.waitForSelector('.toast', { state: 'attached' });
    expect(await page.locator('.blk', { hasText: 'SOBRE' }).count()).toBe(1);
  });
  it('arrastar para outro colaborador e outra hora pergunta se notifica e regista no histórico', async () => {
    const blk = page.locator('.blk', { hasText: 'Rui (exemplo)' }); const b = (await blk.boundingBox())!; const to = await colBox(3);
    await page.mouse.move(b.x + 20, b.y + 10); await page.mouse.down(); await page.mouse.move(to.x + 40, b.y + 10 + 16 * 6, { steps: 8 }); await page.mouse.up();
    await page.waitForSelector('text=Mover marcação');
    await page.click('[data-act=m-silent]');
    await page.waitForSelector('.panel .log li >> text=não notificado');
    expect(await page.locator('.panel dd', { hasText: 'Emanuel' }).count()).toBe(1);
  });
  it('cancelar pergunta sempre se notifica', async () => {
    await page.locator('.blk', { hasText: 'Gonçalo' }).click();
    await page.click('[data-act=cancel]');
    await page.waitForSelector('text=Queres notificar o cliente');
    await page.click('[data-act=m-notify]');
    await page.waitForSelector('.panel .pill.bad');
  });
  it('vista semana, lista e domingo fechado', async () => {
    await page.click('[data-view=week]'); expect(await page.locator('.col').count()).toBe(6);
    await page.click('[data-view=list]'); expect(await page.locator('.list tbody tr').count()).toBeGreaterThan(3);
    await page.click('[data-view=day]'); await page.click('[data-step="1"]'); await page.click('[data-step="1"]'); await page.click('[data-step="1"]'); await page.click('[data-step="1"]'); // quarta+4 = domingo
    expect(await page.locator('.col.closed').count()).toBe(4);
  });
  it('tema escuro e claro aplicam tokens e não há erros na consola', async () => {
    await page.click('[data-act=theme]'); // sistema -> claro
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.click('[data-act=theme]'); // -> escuro
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(light).toBe('rgb(251, 248, 242)'); expect(dark).toBe('rgb(10, 6, 5)');
    expect(errors).toEqual([]);
  });
});
