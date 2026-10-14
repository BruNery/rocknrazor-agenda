import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../dist/pwa', import.meta.url));
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let server: Server, base = '', browser: Browser;
beforeAll(async () => {
  server = createServer((req, res) => { const p = join(root, req.url === '/' ? 'index.html' : decodeURIComponent((req.url ?? '').split('?')[0])); if (!p.startsWith(root) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' }); res.end(readFileSync(p)); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${(server.address() as any).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
});
afterAll(async () => { await browser.close(); server.close(); });

const png = (f: string) => { const b = readFileSync(join(root, f)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

describe('App instalável: manifesto e ícones', () => {
  const m = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
  it('manifesto completo para instalar (nome, standalone, cores da marca, pt-PT)', () => {
    expect(m).toMatchObject({ short_name: 'RR Agenda', display: 'standalone', lang: 'pt-PT', start_url: './', background_color: '#0A0605', theme_color: '#0A0605' });
    expect(m.name.length).toBeGreaterThan(5);
  });
  it('ícones 192 e 512 existem com o tamanho declarado, e há um maskable', () => {
    for (const i of m.icons) expect(png(i.src)).toEqual(i.sizes.split('x').map(Number));
    expect(m.icons.some((i: any) => i.sizes === '192x192' && i.purpose === 'any')).toBe(true);
    expect(m.icons.some((i: any) => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
    expect(m.icons.some((i: any) => i.purpose === 'maskable')).toBe(true);
    expect(png('icons/badge.png')).toEqual([96, 96]); expect(png('icons/apple-touch-icon.png')).toEqual([180, 180]);
  });
  it('a página liga o manifesto, o ícone da Apple e a cor do tema', () => {
    const h = readFileSync(join(root, 'index.html'), 'utf8');
    expect(h).toContain('rel="manifest" href="manifest.webmanifest"'); expect(h).toContain('apple-touch-icon'); expect(h).toContain('name="theme-color"'); expect(h).toContain('viewport-fit=cover');
  });
});

describe('Service worker', () => {
  let ctx: BrowserContext;
  beforeAll(async () => { ctx = await browser.newContext({ permissions: ['notifications'], viewport: { width: 420, height: 860 } }); });
  afterAll(async () => { await ctx.close(); });

  it('recebe um aviso do servidor e mostra a notificação com texto, etiqueta e ligação', async () => {
    const page = await ctx.newPage(); const cdp = await ctx.newCDPSession(page);
    let regId = ''; cdp.on('ServiceWorker.workerRegistrationUpdated', (e: any) => { regId = e.registrations.at(-1)?.registrationId ?? regId; });
    await cdp.send('ServiceWorker.enable');
    await page.goto(base + '/'); await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(() => regId).not.toBe('');
    await cdp.send('ServiceWorker.deliverPushMessage', { origin: base, registrationId: regId, data: JSON.stringify({ title: 'Nova marcação', body: 'Rui Teste · qui 15/10 às 11:00 · Corte', url: '/?dia=2026-10-15', tag: 'booking-1' }) });
    await expect.poll(async () => (await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(n => ({ t: n.title, b: n.body, tag: n.tag, d: n.data })))).length).toBe(1);
    const n = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(n => ({ t: n.title, b: n.body, tag: n.tag, d: n.data })));
    expect(n[0]).toEqual({ t: 'Nova marcação', b: 'Rui Teste · qui 15/10 às 11:00 · Corte', tag: 'booking-1', d: { url: '/?dia=2026-10-15' } });
    // a mesma marcação com a mesma etiqueta substitui o aviso (não acumula)
    await cdp.send('ServiceWorker.deliverPushMessage', { origin: base, registrationId: regId, data: JSON.stringify({ title: 'Marcação cancelada', body: 'Rui Teste', tag: 'booking-1' }) });
    await expect.poll(async () => (await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(n => n.title)))).toEqual(['Marcação cancelada']);
    await page.close();
  });

  it('ao tocar no aviso abre a página da app; endereços de outros sites são ignorados', async () => {
    const calls: string[] = []; const handlers: Record<string, (e: any) => void> = {};
    const win = { url: base + '/', navigate: (u: string) => calls.push('navigate ' + u), focus: () => calls.push('focus') };
    const self: any = { location: new URL(base + '/sw.js'), registration: { scope: base + '/', showNotification: async () => {} }, skipWaiting() {}, addEventListener: (t: string, f: (e: any) => void) => (handlers[t] = f),
      clients: { claim: async () => {}, matchAll: async () => [win], openWindow: async (u: string) => { calls.push('open ' + u); } } };
    vm.runInNewContext(readFileSync(join(root, 'sw.js'), 'utf8'), { self, URL, Promise });
    const click = async (url: string) => { let p: Promise<unknown> = Promise.resolve(); await handlers.notificationclick({ notification: { close() {}, data: { url } }, waitUntil: (x: Promise<unknown>) => (p = x) }); await p; };
    await click('/?dia=2026-10-15'); expect(calls).toEqual([`navigate ${base}/?dia=2026-10-15`, 'focus']); calls.length = 0;
    await click('https://site-malicioso.exemplo/phishing'); expect(calls).toEqual([]);
  });

  it('uma mensagem sem título nem formato JSON não rebenta: mostra o nome da barbearia', async () => {
    const shown: any[] = []; const handlers: Record<string, (e: any) => void> = {};
    const self: any = { location: new URL(base + '/sw.js'), registration: { scope: base + '/', showNotification: async (t: string, o: any) => { shown.push([t, o.body]); } }, skipWaiting() {}, addEventListener: (t: string, f: (e: any) => void) => (handlers[t] = f), clients: {} };
    vm.runInNewContext(readFileSync(join(root, 'sw.js'), 'utf8'), { self });
    let p: Promise<unknown> = Promise.resolve(); handlers.push({ data: { json: () => { throw new Error('x'); }, text: () => 'texto simples' }, waitUntil: (x: Promise<unknown>) => (p = x) }); await p;
    expect(shown).toEqual([["Rock n' Razor", 'texto simples']]);
  });
});

describe('Botão "Ativar avisos neste telemóvel"', () => {
  async function open(opts: { api?: string; ua?: string } = {}) {
    const ctx = await browser.newContext({ permissions: ['notifications'], viewport: { width: 1200, height: 800 }, userAgent: opts.ua });
    const page = await ctx.newPage(); const calls: { url: string; body: any }[] = [];
    await page.addInitScript(({ api }) => {
      if (api !== undefined) (window as any).RR_API = api;
      let current: any = null; const fake = { endpoint: 'https://push.exemplo.test/e2e', toJSON: () => ({ endpoint: 'https://push.exemplo.test/e2e', keys: { p256dh: 'p256dh-chave-de-teste', auth: 'auth-chave' } }), unsubscribe: async () => { current = null; return true; } };
      PushManager.prototype.subscribe = async function (o: any) { (window as any).__key = Array.from(new Uint8Array(o.applicationServerKey)).length; current = fake; return fake as any; };
      PushManager.prototype.getSubscription = async () => current;
    }, { api: opts.api });
    await page.route('**/push/**', r => { const u = new URL(r.request().url()); calls.push({ url: u.pathname, body: r.request().postDataJSON?.() }); r.fulfill({ contentType: 'application/json', body: u.pathname === '/push/key' ? JSON.stringify({ ok: true, key: 'BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A' }) : '{"ok":true}' }); });
    await page.goto(base + '/'); await page.click('[data-act=bell]'); return { ctx, page, calls };
  }
  it('na demonstração (sem servidor) só explica que os avisos são simulados', async () => {
    const { ctx, page } = await open(); expect(await page.textContent('.bellp')).toContain('só mostra a simulação'); expect(await page.locator('[data-act=push-on]').count()).toBe(0); await ctx.close();
  });
  it('com servidor: pede permissão, vai buscar a chave, regista o telemóvel e mostra "ativos"; depois desativa', async () => {
    const { ctx, page, calls } = await open({ api: '' });
    await page.click('[data-act=push-on]'); await page.waitForSelector('.pill:has-text("Avisos ativos")');
    expect(calls.map(c => c.url)).toEqual(['/push/key', '/push/subscribe']);
    expect(calls[1].body).toEqual({ endpoint: 'https://push.exemplo.test/e2e', keys: { p256dh: 'p256dh-chave-de-teste', auth: 'auth-chave' } });
    expect(await page.evaluate(() => (window as any).__key)).toBe(65); // chave VAPID (65 bytes) descodificada de base64url
    await page.click('[data-act=push-off]'); await page.waitForSelector('[data-act=push-on]');
    expect(calls.at(-1)).toMatchObject({ url: '/push/unsubscribe', body: { endpoint: 'https://push.exemplo.test/e2e' } }); await ctx.close();
  });
  it('no iPhone fora da app instalada explica como instalar primeiro', async () => {
    const { ctx, page } = await open({ api: '', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' });
    expect(await page.textContent('.bellp')).toContain('Adicionar ao ecrã principal'); expect(await page.locator('[data-act=push-on]').count()).toBe(0); await ctx.close();
  });
  it('permissão recusada: mostra como desbloquear, sem insistir', async () => {
    const ctx = await browser.newContext({ permissions: [], viewport: { width: 1200, height: 800 } }); const page = await ctx.newPage();
    await page.addInitScript(() => { (window as any).RR_API = ''; Object.defineProperty(Notification, 'permission', { get: () => 'denied' }); });
    await page.goto(base + '/'); await page.click('[data-act=bell]'); await page.waitForSelector('.bellp:has-text("bloqueados")'); await ctx.close();
  });
});
