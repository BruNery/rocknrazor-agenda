import { addDays, type DateStr, type Block, type Sale } from '@rr/domain';
import { Store, EMPLOYEES, SERVICES, PRODUCTS, ARCHIVED_EMPLOYEES, ARCHIVED_SERVICES, COUNTRY_CODES, type B, type Customer } from './store';

export interface Me { username: string; role: 'admin' | 'barber'; employeeId: string | null }
export interface Catalog {
  rules: { gridMin: number; maxWeeksAhead: number; lastBookingLeadMin: number; cancelLeadMin: number; holdMin: number; maxOpenOnline: number; allowOnlineOverlap: boolean; anyBarberPolicy: 'fewest_bookings' | 'first_in_order' };
  employees: { id: string; name: string; nickname: string | null; specialties: string; active: boolean; availableOnline: boolean; autoAssign: boolean; order: number }[];
  services: { id: string; name: string; durationMin: number; pauseMin: number; priceCents: number; active: boolean; pointsPrice: number | null }[];
  products: { id: string; name: string; priceCents: number; stock: number | null; active: boolean; pointsPrice: number | null }[];
  hours: { weekday: number; openMin: number; closeMin: number }[];
  offers: { employeeId: string; serviceId: string; onlineAvailable: boolean; calendarAvailable: boolean; durationMin: number | null }[];
  pauses: { employeeId: string; weekday: number; startMin: number; endMin: number; label: string }[];
}
const CLS = ['s-corte', 's-trim', 's-barba', 's-outro'];
const WINDOW_BACK = 190, WINDOW_FWD = 190;

/** Ligação ao servidor: sessão por cookie, leitura de tudo o que o ecrã precisa e escritas que voltam a ler. */
export class Live {
  me: Me | null = null; cat!: Catalog;
  constructor(public base: string, public store: Store) {}
  async req<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; json: T }> {
    const r = await fetch(this.base + url, { method, credentials: 'include', headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json: any = null; try { json = await r.json(); } catch {}
    return { status: r.status, json };
  }
  async login(username: string, password: string): Promise<'ok' | 'credenciais' | 'bloqueado' | 'erro'> {
    const r = await this.req('POST', '/auth/login', { username, password });
    return r.status === 200 ? 'ok' : r.status === 401 ? 'credenciais' : r.status === 429 ? 'bloqueado' : 'erro';
  }
  async logout() { await this.req('POST', '/auth/logout', {}); this.me = null; }
  /** Há sessão? Se sim, carrega tudo. */
  async start(): Promise<boolean> { const c = await this.req('GET', '/hq/catalog'); if (c.status !== 200) { this.me = null; return false; } await this.hydrate(c.json); return true; }

  async hydrate(pre?: any) {
    const today = this.store.today(), from = addDays(today, -WINDOW_BACK), to = addDays(today, WINDOW_FWD);
    const [c, bk, bl, sl] = await Promise.all([pre ? { status: 200, json: pre } : this.req('GET', '/hq/catalog'), this.req('GET', `/hq/bookings?from=${from}&to=${to}`), this.req('GET', `/hq/blocks?from=${from}&to=${to}`), this.req('GET', `/hq/sales?from=${from}&to=${to}`)]);
    if (c.status !== 200 || bk.status !== 200) throw new Error('sessao');
    const cat = c.json as Catalog & { me: Me }; this.me = cat.me; this.cat = cat;
    const s = this.store;
    // catálogo (listas vivas partilhadas com o Booking)
    const act = cat.employees.filter(e => e.active);
    EMPLOYEES.splice(0, EMPLOYEES.length, ...act.map(e => ({ id: e.id, name: e.name, nick: e.nickname ?? '', specialties: e.specialties, availableOnline: e.availableOnline, autoAssign: e.autoAssign })));
    SERVICES.splice(0, SERVICES.length, ...cat.services.filter(x => x.active).map((x, i) => ({ id: x.id, name: x.name, durationMin: x.durationMin, price: x.priceCents / 100, cls: CLS[i % CLS.length], pauseMin: x.pauseMin, pointsPrice: x.pointsPrice })));
    ARCHIVED_EMPLOYEES.splice(0, ARCHIVED_EMPLOYEES.length, ...cat.employees.filter(e => !e.active).map(e => ({ id: e.id, name: e.name, nick: e.nickname ?? '' })));
    ARCHIVED_SERVICES.splice(0, ARCHIVED_SERVICES.length, ...cat.services.filter(x => !x.active).map(x => ({ id: x.id, name: x.name, durationMin: x.durationMin, price: x.priceCents / 100, cls: 's-outro', pauseMin: x.pauseMin })));
    PRODUCTS.splice(0, PRODUCTS.length, ...cat.products.filter(x => x.active).map(x => ({ id: x.id, name: x.name, price: x.priceCents / 100, stock: x.stock })));
    const hrs: Store['hours'] = {}; for (const h of cat.hours) (hrs[h.weekday] ??= []).push({ open: h.openMin, close: h.closeMin }); s.hours = hrs;
    s.rules = cat.rules; s.offers = cat.offers.map(o => ({ employeeId: o.employeeId, serviceId: o.serviceId, onlineAvailable: o.onlineAvailable, calendarAvailable: o.calendarAvailable, durationMin: o.durationMin ?? undefined }));
    // marcações e clientes
    const custs = new Map<string, Customer>(); const bookings: B[] = [];
    for (const x of bk.json.bookings) {
      const cu = x.customer; let cid = 'anon';
      if (cu) { cid = String(cu.id); if (!custs.has(cid)) { const [cc, phone] = splitPhone(cu.phone); custs.set(cid, { id: cid, name: cu.name, cc, phone, email: cu.email ?? '', notes: cu.notes ?? '' }); } }
      else if (!custs.has('anon')) custs.set('anon', { id: 'anon', name: 'Sem cliente', cc: '+351', phone: '', email: '', notes: '' });
      bookings.push({ id: x.id, employeeId: x.employeeId, date: x.date, startMin: x.startMin, endMin: x.endMin, status: x.status, customerId: cid, notes: x.notes ?? '', serviceIds: x.serviceIds, source: x.source, createdAt: x.createdAt, saleId: x.saleId != null ? String(x.saleId) : undefined, log: [] });
    }
    s.customers = [...custs.values()]; s.bookings = bookings; s.sales = sl.json.sales as Sale[];
    // bloqueios pontuais + pausas semanais expandidas para as datas da janela
    const blocks: Block[] = bl.json.blocks.map((b: any) => ({ id: b.id, employeeId: b.employeeId, date: b.date, allDay: b.allDay, startMin: b.startMin ?? undefined, endMin: b.endMin ?? undefined }));
    cat.pauses.forEach((p, i) => { for (let d = from; d <= to; d = addDays(d, 1)) if (new Date(d + 'T00:00:00Z').getUTCDay() === p.weekday) blocks.push({ id: `p${i}:${d}`, employeeId: p.employeeId, date: d, startMin: p.startMin, endMin: p.endMin }); });
    s.blocks = blocks;
  }
}
/** "+351 913 357 837" → ["+351", "913 357 837"] */
export function splitPhone(full: string): [string, string] {
  const t = (full ?? '').trim(); const cc = [...COUNTRY_CODES].sort((a, b) => b.length - a.length).find(c => t.startsWith(c));
  return cc ? [cc, t.slice(cc.length).trim()] : ['+351', t];
}
export const joinPhone = (cc: string, phone: string) => `${cc} ${phone.trim()}`.trim();
export const dayOf = (d: DateStr) => d;
