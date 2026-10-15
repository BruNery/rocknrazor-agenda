import { DEFAULT_RULES, type Block, type Booking, type Conflict, type Employee, type EmployeeService, type Hold, type OnlineRules, type OpeningHours, type Service, type DateStr } from './types';
import { addDays, localToEpochMs, todayLocal, weekday } from './time';

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

export interface Ctx {
  openingHours: OpeningHours;
  services: Service[];
  employeeServices: EmployeeService[];
  employees: Employee[];
  blocks: Block[];
  bookings: Booking[];
  holds?: Hold[];
  nowMs: number;
  rules?: OnlineRules;
}

/** Duração total de uma lista de serviços feitos em sequência pelo mesmo colaborador. */
export function totalDuration(serviceIds: string[], employeeId: string, ctx: Pick<Ctx, 'services' | 'employeeServices'>): number {
  return serviceIds.reduce((sum, id) => {
    const s = ctx.services.find(x => x.id === id);
    if (!s) throw new Error(`Serviço desconhecido: ${id}`);
    const own = ctx.employeeServices.find(x => x.employeeId === employeeId && x.serviceId === id)?.durationMin;
    return sum + (own ?? s.durationMin) + (s.pauseMin ?? 0);
  }, 0);
}

function offers(ctx: Ctx, employeeId: string, serviceIds: string[], online: boolean): boolean {
  return serviceIds.every(id => {
    const es = ctx.employeeServices.find(x => x.employeeId === employeeId && x.serviceId === id);
    return !!es && es.calendarAvailable && (!online || es.onlineAvailable);
  });
}

/** Conflitos de uma marcação candidata. `ignoreBookingId` permite reagendar sem conflitar consigo mesma. */
export function findConflicts(c: { employeeId: string; date: DateStr; startMin: number; endMin: number; serviceIds?: string[]; ignoreBookingId?: string }, ctx: Ctx, opts: { online?: boolean } = {}): Conflict[] {
  const out: Conflict[] = [];
  const hours = ctx.openingHours[weekday(c.date)] ?? [];
  if (!hours.some(h => c.startMin >= h.open && c.endMin <= h.close)) out.push({ kind: 'outside_hours' });
  for (const id of c.serviceIds ?? []) if (!offers(ctx, c.employeeId, [id], !!opts.online)) out.push({ kind: 'service_not_offered', serviceId: id });
  for (const b of ctx.blocks) {
    if (b.employeeId !== c.employeeId || b.date !== c.date) continue;
    const s = b.allDay ? 0 : b.startMin!, e = b.allDay ? 24 * 60 : b.endMin!;
    if (overlaps(c.startMin, c.endMin, s, e)) out.push({ kind: 'blocked', with: b.id });
  }
  for (const b of ctx.bookings) {
    if (b.employeeId !== c.employeeId || b.date !== c.date || b.status === 'cancelled' || b.id === c.ignoreBookingId) continue;
    if (opts.online && (ctx.rules ?? DEFAULT_RULES).allowOnlineOverlap) continue; // regra do negócio: online pode sobrepor marcações (nunca bloqueios nem reservas)
    if (overlaps(c.startMin, c.endMin, b.startMin, b.endMin)) out.push({ kind: 'overlap', with: b.id });
  }
  for (const h of ctx.holds ?? []) {
    if (h.expiresAtMs > ctx.nowMs && h.employeeId === c.employeeId && h.date === c.date && overlaps(c.startMin, c.endMin, h.startMin, h.endMin)) out.push({ kind: 'held' });
  }
  return out;
}

export interface Slot { startMin: number; employeeId: string }

/** Horários livres para reserva ONLINE. Nunca devolve sobreposições. `employeeId` omitido = qualquer colaborador. */
export function computeAvailability(date: DateStr, serviceIds: string[], employeeId: string | undefined, ctx: Ctx): Slot[] {
  const rules = ctx.rules ?? DEFAULT_RULES;
  const today = todayLocal(ctx.nowMs);
  if (date < today || date > addDays(today, rules.maxWeeksAhead * 7)) return [];
  const pool = ctx.employees.filter(e => e.availableOnline && (employeeId ? e.id === employeeId : e.autoAssign));
  const hours = ctx.openingHours[weekday(date)] ?? [];
  const slots: Slot[] = [];
  const seen = new Set<number>();
  for (const emp of pool.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))) {
    if (!offers(ctx, emp.id, serviceIds, true)) continue;
    const dur = totalDuration(serviceIds, emp.id, ctx);
    for (const h of hours) {
      for (let s = Math.ceil(h.open / rules.gridMin) * rules.gridMin; s + dur <= h.close; s += rules.gridMin) {
        if (localToEpochMs(date, s) < ctx.nowMs + rules.lastBookingLeadMin * 60_000) continue;
        if (findConflicts({ employeeId: emp.id, date, startMin: s, endMin: s + dur }, ctx, { online: true }).length) continue;
        if (employeeId) slots.push({ startMin: s, employeeId: emp.id });
        else if (!seen.has(s)) { seen.add(s); slots.push({ startMin: s, employeeId: emp.id }); }
      }
    }
  }
  return slots.sort((a, b) => a.startMin - b.startMin);
}

/**
 * Escolhe colaborador para "qualquer colaborador".
 * PRESSUPOSTO (algoritmo do Noona não verificado): menos marcações nesse dia; desempate por id.
 */
export function assignEmployee(date: DateStr, startMin: number, serviceIds: string[], ctx: Ctx): string | undefined {
  const cands = ctx.employees.filter(e => e.availableOnline && e.autoAssign).filter(e => {
    const end = startMin + totalDuration(serviceIds, e.id, ctx);
    return offers(ctx, e.id, serviceIds, true) && findConflicts({ employeeId: e.id, date, startMin, endMin: end }, ctx, { online: true }).length === 0;
  });
  const load = (id: string) => ctx.bookings.filter(b => b.employeeId === id && b.date === date && b.status !== 'cancelled').length;
  const order = (id: string) => ctx.employees.find(e => e.id === id)?.order ?? 0;
  const byOrder = (a: Employee, b: Employee) => order(a.id) - order(b.id) || a.id.localeCompare(b.id);
  const policy = (ctx.rules ?? DEFAULT_RULES).anyBarberPolicy;
  return cands.sort((a, b) => (policy === 'first_in_order' ? 0 : load(a.id) - load(b.id)) || byOrder(a, b))[0]?.id;
}

/** Cancelar/reagendar online só até `cancelLeadMin` antes do início. */
export function canCancelOrReschedule(b: Pick<Booking, 'date' | 'startMin'>, nowMs: number, rules: OnlineRules = DEFAULT_RULES): boolean {
  return localToEpochMs(b.date, b.startMin) - nowMs >= rules.cancelLeadMin * 60_000;
}

/** Ocorrências semanais (a cada `everyWeeks`), incluindo a primeira. */
export function expandWeekly(start: DateStr, everyWeeks: number, count: number): DateStr[] {
  return Array.from({ length: count }, (_, i) => addDays(start, i * everyWeeks * 7));
}
