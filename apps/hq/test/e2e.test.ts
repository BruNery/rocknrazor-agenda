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
  it('arrastar para outro colaborador e outra hora pergunta se notifica', async () => {
    const blk = page.locator('.blk', { hasText: 'Rui (exemplo)' }); const b = (await blk.boundingBox())!; const to = await colBox(3);
    await page.mouse.move(b.x + 20, b.y + 10); await page.mouse.down(); await page.mouse.move(to.x + 40, b.y + 10 + 16 * 6, { steps: 8 }); await page.mouse.up();
    await page.waitForSelector('text=Mover marcação');
    await page.click('[data-act=m-silent]');
    await page.waitForSelector('.toast');
    expect(await page.locator('.col').nth(3).locator('.blk', { hasText: 'Rui' }).count()).toBe(1);
  });
});

describe('HQ: ficha da marcação (cliente e dados editáveis)', () => {
  const open = async (who: string) => { await page.locator('.blk', { hasText: who }).first().click(); await page.waitForSelector('#df'); };
  it('abre com os dados do cliente, serviço, colaborador e visitas anteriores', async () => {
    await open('Gonçalo');
    expect(await page.inputValue('#d-name')).toBe('Gonçalo (exemplo)');
    expect(await page.inputValue('#d-phone')).toBe('913 357 837');
    expect(await page.inputValue('#d-email')).toBe('goncalo@exemplo.pt');
    expect(await page.inputValue('#d-cc')).toBe('+351');
    expect(await page.locator('.visit').count()).toBe(2);
  });
  it('edita nome, telefone, e-mail e notas do cliente e guarda (valem para todas as marcações dele)', async () => {
    await page.fill('#d-name', 'Gonçalo Silva'); await page.selectOption('#d-cc', '+55'); await page.fill('#d-phone', '11 98888 7777');
    await page.fill('#d-email', 'g.silva@exemplo.pt'); await page.fill('#d-cnotes', 'Alérgico a lâminas novas');
    await page.fill('#d-notes', 'Chega 5 min mais cedo');
    await page.click('#df button[type=submit]'); await page.waitForSelector('text=Marcação guardada');
    expect(await page.locator('#df').count()).toBe(0); // sem mudar hora não pergunta notificação
    await open('Gonçalo Silva');
    expect(await page.inputValue('#d-cc')).toBe('+55'); expect(await page.inputValue('#d-phone')).toBe('11 98888 7777');
    expect(await page.inputValue('#d-cnotes')).toBe('Alérgico a lâminas novas'); expect(await page.inputValue('#d-notes')).toBe('Chega 5 min mais cedo');
    const nome = await page.evaluate(() => (window as any).__rr.store.bookings.filter((b: any) => b.customerId === (window as any).__rr.store.customers[0].id).length);
    expect(nome).toBe(3); // as 3 marcações do cliente apontam para o mesmo registo
    await page.click('[data-act=d-log]'); expect(await page.locator('.log li', { hasText: 'Dados do cliente alterados' }).count()).toBe(1);
  });
  it('acrescenta um serviço, muda a hora com + e guarda: recalcula a duração e pergunta se notifica', async () => {
    await page.click('[data-act=d-add]'); await page.click('[data-act=d-addsvc][data-v=barba]');
    expect(await page.locator('#df', { hasText: 'Total: 60 minutos' }).count()).toBe(1);
    await page.click('[data-act=d-t][data-v="10"]'); expect(await page.inputValue('#d-time')).toBe('14:10');
    await page.click('#df button[type=submit]'); await page.waitForSelector('text=Queres notificar o cliente');
    await page.click('[data-act=m-silent]'); await page.waitForSelector('text=Marcação guardada');
    await open('Gonçalo Silva'); expect(await page.locator('#df', { hasText: 'termina às 15:10' }).count()).toBe(1);
    await page.click('[data-act=d-log]'); expect(await page.locator('.log li', { hasText: 'não notificado' }).count()).toBe(1);
  });
  it('mudar para um horário ocupado mostra o conflito e voltar mantém a ficha aberta', async () => {
    await page.selectOption('#d-emp', 'andre'); await page.fill('#d-time', '13:10'); // almoço do André (a ficha continua aberta do teste anterior)
    await page.click('#df button[type=submit]'); await page.waitForSelector('text=período indisponível');
    await page.click('[data-act=m-no]'); expect(await page.locator('#df').count()).toBe(1);
    await page.click('[data-act=d-close]');
  });
  it('Copiar abre nova marcação com o cliente e serviços; Estado "Cancelada" pergunta notificação', async () => {
    await open('Gonçalo Silva'); await page.click('[data-act=d-copy]'); await page.waitForSelector('#newf');
    expect(await page.inputValue('#f-name')).toBe('Gonçalo Silva'); await page.click('[data-act=m-no]');
    await open('Gonçalo Silva'); await page.selectOption('#d-status', 'cancelled'); await page.click('#df button[type=submit]');
    await page.waitForSelector('text=Cancelar marcação'); await page.click('[data-act=m-notify]'); await page.waitForSelector('text=Marcação guardada');
    expect(await page.locator('.blk', { hasText: 'Gonçalo Silva' }).count()).toBe(0);
  });
  it('Apagar pede confirmação e remove a marcação', async () => {
    await open('Tiago'); await page.click('[data-act=d-del]'); await page.waitForSelector('text=Não se pode desfazer');
    await page.click('[data-act=m-del]'); await page.waitForSelector('text=Marcação apagada');
    expect(await page.locator('.blk', { hasText: 'Tiago' }).count()).toBe(0);
  });
});

describe('HQ: vistas e tema', () => {
  it('vista semana, lista e domingo fechado', async () => {
    await page.click('[data-view=week]'); expect(await page.locator('.col').count()).toBe(6);
    await page.click('[data-view=list]'); expect(await page.locator('.list tbody tr').count()).toBeGreaterThan(3);
    await page.locator('.list tbody tr').first().click(); await page.waitForSelector('#df'); await page.click('[data-act=d-close]');
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
