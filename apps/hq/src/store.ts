import { findConflicts, totalDuration, addDays, todayLocal, type Booking, type Block, type Ctx, type Conflict, type DateStr } from '@rr/domain';

export interface Customer { id: string; name: string; cc: string; phone: string; email: string; notes: string }
export interface B extends Booking { customerId: string; notes: string; serviceIds: string[]; source: 'online' | 'hq'; createdAt: number; log: { at: number; text: string }[] }
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
export const STATUSES = [{ id: 'confirmed', name: 'Confirmada' }, { id: 'noshow', name: 'Não compareceu' }, { id: 'cancelled', name: 'Cancelada' }] as const;
export const COUNTRY_CODES = ['+351', '+55', '+34', '+33', '+44', '+49'];
const hours = Object.fromEntries([1, 2, 3, 4, 5, 6].map(d => [d, [{ open: 540, close: 1140 }]]));

export class Store {
  bookings: B[] = []; blocks: Block[] = []; customers: Customer[] = []; private n = 100; private c = 1;
  constructor(public nowMs: () => number = Date.now) { this.seed(); }
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
    this.bookings.push(b); return b;
  }
  /** Aplica as alterações da ficha. `notify` só conta quando muda dia/hora/colaborador ou o estado passa a cancelada. */
  update(id: string, p: { employeeId: string; date: DateStr; startMin: number; serviceIds: string[]; notes: string; status: B['status']; customerChanged: boolean }, notify: boolean | null) {
    const b = this.bookings.find(x => x.id === id)!; const log = (t: string) => b.log.push({ at: this.nowMs(), text: t });
    const nt = notify === null ? '' : `. Cliente ${notify ? 'notificado' : 'não notificado'}`;
    if (p.customerChanged) log('Dados do cliente alterados');
    if (p.notes !== b.notes) log('Notas da marcação alteradas');
    if (p.status !== b.status) log(`Estado: ${STATUSES.find(s => s.id === b.status)!.name} → ${STATUSES.find(s => s.id === p.status)!.name}${nt}`);
    const moved = p.employeeId !== b.employeeId || p.date !== b.date || p.startMin !== b.startMin;
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
