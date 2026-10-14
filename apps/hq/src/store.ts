import { findConflicts, totalDuration, addDays, todayLocal, type Booking, type Block, type Ctx, type Conflict, type DateStr } from '@rr/domain';

export interface B extends Booking { customer: string; phone: string; serviceIds: string[]; source: 'online' | 'hq'; log: { at: number; text: string }[] }
export const EMPLOYEES = [
  { id: 'andre', name: 'André', nick: 'Link' }, { id: 'marcos', name: 'Marcos', nick: 'Gringo' },
  { id: 'margarida', name: 'Margarida', nick: 'Mags' }, { id: 'emanuel', name: 'Emanuel', nick: 'Tito' },
];
export const SERVICES = [
  { id: 'corte', name: 'Corte Premium', durationMin: 40, cls: 's-corte' },
  { id: 'trim', name: "Rockstar Trim n' Shave", durationMin: 60, cls: 's-trim' },
  { id: 'barba', name: 'Barba', durationMin: 20, cls: 's-barba' },
];
const hours = Object.fromEntries([1, 2, 3, 4, 5, 6].map(d => [d, [{ open: 540, close: 1140 }]]));

export class Store {
  bookings: B[] = []; blocks: Block[] = []; private n = 100;
  constructor(public nowMs: () => number = Date.now) { this.seed(); }
  today(): DateStr { return todayLocal(this.nowMs()); }
  private seed() {
    const t = this.today();
    const add = (e: string, d: DateStr, s: number, ids: string[], who: string) => this.bookings.push({ id: 'b' + this.n++, employeeId: e, date: d, startMin: s, endMin: s + this.dur(ids, e), status: 'confirmed', customer: who, phone: '9' + (10000000 + this.n), serviceIds: ids, source: 'hq', log: [{ at: this.nowMs(), text: 'Criada (exemplo)' }] });
    add('marcos', t, 840, ['corte'], 'Gonçalo (exemplo)'); add('emanuel', t, 820, ['trim'], 'Haroldo (exemplo)');
    add('andre', t, 600, ['corte', 'barba'], 'Rui (exemplo)'); add('margarida', t, 660, ['barba'], 'Tiago (exemplo)');
    add('marcos', addDays(t, 1), 600, ['corte'], 'Nuno (exemplo)'); add('andre', addDays(t, 2), 960, ['trim'], 'Pedro (exemplo)');
    this.blocks.push({ id: 'k1', employeeId: 'margarida', date: t, startMin: 780, endMin: 840 });
    for (let i = 0; i < 7; i++) this.blocks.push({ id: 'k2' + i, employeeId: 'andre', date: addDays(t, i), startMin: 780, endMin: 840 });
  }
  dur(ids: string[], emp: string) { return totalDuration(ids, emp, this.ctx()); }
  ctx(): Ctx {
    return { openingHours: hours, nowMs: this.nowMs(), blocks: this.blocks, bookings: this.bookings, holds: [],
      services: SERVICES.map(s => ({ id: s.id, durationMin: s.durationMin })),
      employees: EMPLOYEES.map(e => ({ id: e.id, availableOnline: true, autoAssign: true })),
      employeeServices: EMPLOYEES.flatMap(e => SERVICES.map(s => ({ employeeId: e.id, serviceId: s.id, onlineAvailable: true, calendarAvailable: true }))) };
  }
  conflicts(c: { employeeId: string; date: DateStr; startMin: number; endMin: number; serviceIds?: string[]; ignoreBookingId?: string }): Conflict[] { return findConflicts(c, this.ctx()); }
  create(a: { employeeId: string; date: DateStr; startMin: number; serviceIds: string[]; customer: string; phone: string; withConflicts: boolean }): B {
    const b: B = { id: 'b' + this.n++, employeeId: a.employeeId, date: a.date, startMin: a.startMin, endMin: a.startMin + this.dur(a.serviceIds, a.employeeId), status: 'confirmed', customer: a.customer, phone: a.phone, serviceIds: a.serviceIds, source: 'hq', log: [{ at: this.nowMs(), text: a.withConflicts ? 'Criada com conflito confirmado' : 'Criada' }] };
    this.bookings.push(b); return b;
  }
  move(id: string, emp: string, date: DateStr, start: number, notify: boolean) {
    const b = this.bookings.find(x => x.id === id)!; const len = b.endMin - b.startMin;
    b.log.push({ at: this.nowMs(), text: `Reagendada de ${b.date} ${fmt(b.startMin)} (${b.employeeId}) para ${date} ${fmt(start)} (${emp}). Cliente ${notify ? 'notificado' : 'não notificado'}` });
    Object.assign(b, { employeeId: emp, date, startMin: start, endMin: start + len });
  }
  cancel(id: string, notify: boolean) { const b = this.bookings.find(x => x.id === id)!; b.status = 'cancelled'; b.log.push({ at: this.nowMs(), text: `Cancelada. Cliente ${notify ? 'notificado' : 'não notificado'}` }); }
}
export const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
