import { findConflicts, totalDuration, addDays, todayLocal, weekday, type Booking, type Block, type Ctx, type Conflict, type DateStr, type Sale, type SaleItem } from '@rr/domain';

export interface Customer { id: string; name: string; cc: string; phone: string; email: string; notes: string }
export interface B extends Booking { saleId?: string; customerId: string; notes: string; serviceIds: string[]; source: 'online' | 'hq'; createdAt: number; log: { at: number; text: string }[] }
export const EMPLOYEES = [
  { id: 'andre', name: 'André', nick: 'Link' }, { id: 'marcos', name: 'Marcos', nick: 'Gringo' },
  { id: 'margarida', name: 'Margarida', nick: 'Mags' }, { id: 'emanuel', name: 'Emanuel', nick: 'Tito' },
];
/** Preços de exemplo (só o do Corte Premium foi visto no Noona). */
export const SERVICES = [
  { id: 'corte', name: 'Corte Premium', durationMin: 40, price: 17, cls: 's-corte' },
  { id: 'trim', name: "Rockstar Trim n' Shave", durationMin: 60, price: 25, cls: 's-trim' },
  { id: 'barba', name: 'Barba', durationMin: 20, price: 8, cls: 's-barba' },
];
/** Preços de exemplo. */
export const PRODUCTS = [{ id: 'pomada', name: 'Pomada modeladora', price: 15 }, { id: 'oleo', name: 'Óleo de barba', price: 12 }, { id: 'shampoo', name: 'Shampoo', price: 10 }];
export const PAYMENTS = [{ id: 'cartao', name: 'Cartão' }, { id: 'dinheiro', name: 'Dinheiro' }, { id: 'mbway', name: 'MB WAY' }, { id: 'outro', name: 'Outro' }] as const;
export interface Note { at: number; employeeId: string; text: string; read: boolean }
export const STATUSES = [{ id: 'confirmed', name: 'Confirmada' }, { id: 'noshow', name: 'Não compareceu' }, { id: 'cancelled', name: 'Cancelada' }] as const;
export const COUNTRY_CODES = ['+351', '+55', '+34', '+33', '+44', '+49'];
const hours = Object.fromEntries([1, 2, 3, 4, 5, 6].map(d => [d, [{ open: 540, close: 1140 }]]));

export class Store {
  bookings: B[] = []; blocks: Block[] = []; customers: Customer[] = []; sales: Sale[] = []; notes: Note[] = []; private n = 100; private c = 1;
  constructor(public nowMs: () => number = Date.now) { this.seed(); this.seedHistory(); }
  private notify(employeeId: string, text: string) { this.notes.unshift({ at: this.nowMs(), employeeId, text, read: false }); }
  today(): DateStr { return todayLocal(this.nowMs()); }
  private seed() {
    const t = this.today();
    const cust = (name: string, phone: string, email = '', notes = '') => { const c: Customer = { id: 'c' + this.c++, name, cc: '+351', phone, email, notes }; this.customers.push(c); return c; };
    const g = cust('Gonçalo (exemplo)', '913 357 837', 'goncalo@exemplo.pt'), h = cust('Haroldo (exemplo)', '912 000 111'), r = cust('Rui (exemplo)', '910 000 103', '', 'Prefere máquina 2'), ti = cust('Tiago (exemplo)', '916 222 333'), nu = cust('Nuno (exemplo)', '917 444 555'), pe = cust('Pedro (exemplo)', '918 666 777');
    const add = (e: string, d: DateStr, s: number, ids: string[], c: Customer, notes = '') => this.bookings.push({ id: 'b' + this.n++, employeeId: e, date: d, startMin: s, endMin: s + this.dur(ids, e), status: 'confirmed', customerId: c.id, notes, serviceIds: ids, source: 'hq', createdAt: this.nowMs(), log: [{ at: this.nowMs(), text: 'Criada (exemplo)' }] });
    add('marcos', t, 840, ['corte'], g); add('emanuel', t, 820, ['trim'], h); add('andre', t, 600, ['corte', 'barba'], r, 'Cliente habitual'); add('margarida', t, 660, ['barba'], ti);
    add('marcos', addDays(t, 1), 600, ['corte'], nu); add('andre', addDays(t, 2), 960, ['trim'], pe);
    for (const [c, e, back] of [[g, 'marcos', 36], [g, 'marcos', 83], [r, 'andre', 21], [r, 'andre', 49]] as const) add(e, addDays(t, -back), 840, ['corte'], c);
    this.blocks.push({ id: 'k1', employeeId: 'margarida', date: t, startMin: 780, endMin: 840 });
    for (let i = 0; i < 7; i++) this.blocks.push({ id: 'k2' + i, employeeId: 'andre', date: addDays(t, i), startMin: 780, endMin: 840 });
  }

  /** Histórico fictício dos últimos 190 dias para os dashboards (clientes anónimos de exemplo). */
  private seedHistory() {
    let a = 12345; const rnd = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pool: Customer[] = Array.from({ length: 1200 }, (_, i) => ({ id: 'h' + (i + 1), name: `Cliente ${i + 1} (exemplo)`, cc: '+351', phone: '', email: '', notes: '' }));
    this.customers.push(...pool);
    const attach: Record<string, number> = { andre: 0.45, marcos: 0.3, margarida: 0.2, emanuel: 0.35 }, busy: Record<string, number> = { andre: 5, marcos: 4, margarida: 4, emanuel: 5 };
    const t = this.today();
    for (let back = 190; back >= 1; back--) {
      const date = addDays(t, -back); if (weekday(date) === 0) continue;
      EMPLOYEES.forEach((e, ei) => {
        const n = Math.max(2, busy[e.id] - 1 + Math.floor(rnd() * 3)); let start = 540;
        for (let k = 0; k < n; k++) {
          if (start >= 780 && start < 840) start = 840;
          const r = rnd(); const ids = r < 0.6 ? ['corte'] : r < 0.8 ? ['corte', 'barba'] : ['trim'];
          const cust = rnd() < 0.22 ? pool[rnd() < 0.8 ? ei + 4 * Math.floor(rnd() * 15) : Math.floor(rnd() * 60)] : pool[60 + Math.floor(rnd() * 1140)]; // 60 clientes habituais, 80% com o seu barbeiro
          const end = start + this.dur(ids, e.id), x = rnd();
          const b: B = { id: 'h' + this.n++, employeeId: e.id, date, startMin: start, endMin: end, status: x < 0.08 ? 'noshow' : x < 0.15 ? 'cancelled' : 'confirmed', customerId: cust.id, notes: '', serviceIds: ids, source: rnd() < 0.4 ? 'online' : 'hq', createdAt: this.nowMs(), log: [] };
          if (b.status === 'confirmed') {
            const items: SaleItem[] = ids.map(id => { const sv = SERVICES.find(z => z.id === id)!; return { kind: 'service', refId: id, name: sv.name, qty: 1, unitCents: sv.price * 100 }; });
            if (rnd() < attach[e.id]) { const pr = PRODUCTS[Math.floor(rnd() * PRODUCTS.length)]; items.push({ kind: 'product', refId: pr.id, name: pr.name, qty: rnd() < 0.15 ? 2 : 1, unitCents: pr.price * 100 }); }
            const sale: Sale = { id: 's' + this.n++, bookingId: b.id, employeeId: e.id, customerId: cust.id, date, items, payment: rnd() < 0.6 ? 'cartao' : rnd() < 0.5 ? 'dinheiro' : 'mbway' };
            this.sales.push(sale); b.saleId = sale.id;
          }
          this.bookings.push(b); start = end + 10 + Math.floor(rnd() * 3) * 10;
        }
      });
    }
  }
  /** Regista o atendimento (serviços e produtos realmente cobrados). Não processa pagamentos. */
  completeSale(bookingId: string, items: SaleItem[], payment: Sale['payment']): Sale {
    const b = this.bookings.find(x => x.id === bookingId)!;
    const sale: Sale = { id: 's' + this.n++, bookingId, employeeId: b.employeeId, customerId: b.customerId, date: b.date, items, payment };
    this.sales.push(sale); b.saleId = sale.id;
    b.log.push({ at: this.nowMs(), text: `Atendimento registado: € ${(items.reduce((t, i) => t + i.qty * i.unitCents, 0) / 100).toFixed(2).replace('.', ',')}` });
    return sale;
  }
  customer(id: string) { return this.customers.find(c => c.id === id)!; }
  customerByName(name: string) { const n = name.trim().toLowerCase(); return this.customers.find(c => c.name.toLowerCase() === n); }
  previousVisits(b: B) { return this.bookings.filter(x => x.customerId === b.customerId && x.id !== b.id && x.status !== 'cancelled' && (x.date < b.date || (x.date === b.date && x.startMin < b.startMin))).sort((a, c) => (c.date + fmt(c.startMin)).localeCompare(a.date + fmt(a.startMin))); }
  dur(ids: string[], emp: string) { return totalDuration(ids, emp, this.ctx()); }
  ctx(): Ctx {
    return { openingHours: hours, nowMs: this.nowMs(), blocks: this.blocks, bookings: this.bookings, holds: [],
      services: SERVICES.map(s => ({ id: s.id, durationMin: s.durationMin })),
      employees: EMPLOYEES.map(e => ({ id: e.id, availableOnline: true, autoAssign: true })),
      employeeServices: EMPLOYEES.flatMap(e => SERVICES.map(s => ({ employeeId: e.id, serviceId: s.id, onlineAvailable: true, calendarAvailable: true }))) };
  }
  conflicts(c: { employeeId: string; date: DateStr; startMin: number; endMin: number; serviceIds?: string[]; ignoreBookingId?: string }): Conflict[] { return findConflicts(c, this.ctx()); }
  /** Cria ou atualiza o cliente (por nome). Devolve o cliente. */
  saveCustomer(d: { id?: string; name: string; cc: string; phone: string; email: string; notes?: string }): Customer {
    const c = (d.id && this.customer(d.id)) || this.customerByName(d.name) || (() => { const n: Customer = { id: 'c' + this.c++, name: d.name, cc: d.cc, phone: d.phone, email: d.email, notes: '' }; this.customers.push(n); return n; })();
    Object.assign(c, { name: d.name, cc: d.cc, phone: d.phone, email: d.email }); if (d.notes !== undefined) c.notes = d.notes; return c;
  }
  create(a: { employeeId: string; date: DateStr; startMin: number; serviceIds: string[]; customerId: string; notes?: string; withConflicts: boolean }): B {
    const b: B = { id: 'b' + this.n++, employeeId: a.employeeId, date: a.date, startMin: a.startMin, endMin: a.startMin + this.dur(a.serviceIds, a.employeeId), status: 'confirmed', customerId: a.customerId, notes: a.notes ?? '', serviceIds: a.serviceIds, source: 'hq', createdAt: this.nowMs(), log: [{ at: this.nowMs(), text: a.withConflicts ? 'Criada com conflito confirmado' : 'Criada' }] };
    this.bookings.push(b); this.notify(a.employeeId, `Nova marcação: ${this.customer(a.customerId).name}, ${a.date.split('-').reverse().slice(0, 2).join('/')} às ${fmt(b.startMin)}`); return b;
  }
  /** Aplica as alterações da ficha. `notify` só conta quando muda dia/hora/colaborador ou o estado passa a cancelada. */
  update(id: string, p: { employeeId: string; date: DateStr; startMin: number; serviceIds: string[]; notes: string; status: B['status']; customerChanged: boolean }, notify: boolean | null) {
    const b = this.bookings.find(x => x.id === id)!; const log = (t: string) => b.log.push({ at: this.nowMs(), text: t });
    const nt = notify === null ? '' : `. Cliente ${notify ? 'notificado' : 'não notificado'}`;
    if (p.customerChanged) log('Dados do cliente alterados');
    if (p.notes !== b.notes) log('Notas da marcação alteradas');
    if (p.status !== b.status) log(`Estado: ${STATUSES.find(s => s.id === b.status)!.name} → ${STATUSES.find(s => s.id === p.status)!.name}${nt}`);
    const moved = p.employeeId !== b.employeeId || p.date !== b.date || p.startMin !== b.startMin;
    if (moved) { const nm = this.customer(b.customerId).name; this.notify(p.employeeId, `Marcação reagendada: ${nm}, ${p.date.split('-').reverse().slice(0, 2).join('/')} às ${fmt(p.startMin)}`); if (p.employeeId !== b.employeeId) this.notify(b.employeeId, `Marcação passou para outro barbeiro: ${nm}`); }
    if (p.status === 'cancelled' && b.status !== 'cancelled') this.notify(b.employeeId, `Marcação cancelada: ${this.customer(b.customerId).name}, ${b.date.split('-').reverse().slice(0, 2).join('/')} às ${fmt(b.startMin)}`);
    if (moved) log(`Reagendada de ${b.date} ${fmt(b.startMin)} (${b.employeeId}) para ${p.date} ${fmt(p.startMin)} (${p.employeeId})${nt}`);
    if (p.serviceIds.join() !== b.serviceIds.join()) log('Serviços alterados');
    Object.assign(b, { employeeId: p.employeeId, date: p.date, startMin: p.startMin, endMin: p.startMin + this.dur(p.serviceIds, p.employeeId), serviceIds: p.serviceIds, notes: p.notes, status: p.status });
  }
  remove(id: string) { this.bookings = this.bookings.filter(b => b.id !== id); }
  move(id: string, emp: string, date: DateStr, start: number, notify: boolean) {
    const b = this.bookings.find(x => x.id === id)!;
    this.update(id, { employeeId: emp, date, startMin: start, serviceIds: b.serviceIds, notes: b.notes, status: b.status, customerChanged: false }, notify);
  }
}
export const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
