import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { fmtWhen, type StaffNotifier } from './push';
import { DEFAULT_RULES, canCancelOrReschedule, computeAvailability, findConflicts, assignEmployee, totalDuration, type Conflict, type Ctx, type DateStr } from '@rr/domain';

export interface Notifier { send(kind: 'created' | 'cancelled' | 'rescheduled', bookingId: string): Promise<void> }
export class FakeNotifier implements Notifier { sent: { kind: string; bookingId: string }[] = []; async send(kind: any, bookingId: string) { this.sent.push({ kind, bookingId }); } }

export const HOLD_MS = 5 * 60_000;
export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; conflicts?: Conflict[] };

async function loadCtx(db: PoolClient, date: DateStr, nowMs: number): Promise<Ctx> {
  // Um cliente pg só executa uma consulta de cada vez: sequencial.
  const emp = await db.query('select id, available_online, auto_assign from employees');
  const svc = await db.query('select id, duration_min, pause_min from services');
  const es = await db.query('select employee_id, service_id, online_available, calendar_available, duration_min from employee_services');
  const oh = await db.query('select weekday, open_min, close_min from opening_hours');
  const bl = await db.query("select id, employee_id, to_char(date,'YYYY-MM-DD') d, all_day, start_min, end_min from blocks where date = $1", [date]);
  const bk = await db.query("select id, employee_id, to_char(date,'YYYY-MM-DD') d, start_min, end_min, status from bookings where date = $1", [date]);
  const ho = await db.query("select employee_id, to_char(date,'YYYY-MM-DD') d, start_min, end_min, extract(epoch from expires_at)*1000 ms from holds where date = $1", [date]);
  const openingHours: Ctx['openingHours'] = {};
  for (const r of oh.rows) (openingHours[r.weekday] ??= []).push({ open: r.open_min, close: r.close_min });
  return {
    nowMs, openingHours, rules: DEFAULT_RULES,
    employees: emp.rows.map(r => ({ id: r.id, availableOnline: r.available_online, autoAssign: r.auto_assign })),
    services: svc.rows.map(r => ({ id: r.id, durationMin: r.duration_min, pauseMin: r.pause_min })),
    employeeServices: es.rows.map(r => ({ employeeId: r.employee_id, serviceId: r.service_id, onlineAvailable: r.online_available, calendarAvailable: r.calendar_available, durationMin: r.duration_min ?? undefined })),
    blocks: bl.rows.map(r => ({ id: r.id, employeeId: r.employee_id, date: r.d, allDay: r.all_day, startMin: r.start_min ?? undefined, endMin: r.end_min ?? undefined })),
    bookings: bk.rows.map(r => ({ id: r.id, employeeId: r.employee_id, date: r.d, startMin: r.start_min, endMin: r.end_min, status: r.status })),
    holds: ho.rows.map(r => ({ employeeId: r.employee_id, date: r.d, startMin: r.start_min, endMin: r.end_min, expiresAtMs: Number(r.ms) })),
  };
}

async function tx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; }
  catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}

/** Bloqueia as linhas dos colaboradores em ordem de id (evita deadlocks): serializa reservas concorrentes. */
async function lockEmployees(c: PoolClient, ids?: string[]) {
  await c.query(ids ? 'select id from employees where id = any($1) order by id for update' : 'select id from employees order by id for update', ids ? [ids] : []);
}

const audit = (c: PoolClient, actor: string, action: string, bookingId: string, before: unknown, after: unknown, notified: boolean | null) =>
  c.query('insert into audit_log(actor, action, booking_id, before, after, notified) values ($1,$2,$3,$4,$5,$6)', [actor, action, bookingId, before ?? null, after ?? null, notified]);

export class BookingService {
  constructor(private pool: Pool, private notifier: Notifier, private staff?: StaffNotifier) {}

  /** Avisa o barbeiro no telemóvel. `by` = quem fez a alteração: o próprio barbeiro não é avisado das suas ações. Nunca lança. */
  private async tellBarber(kind: 'created' | 'cancelled' | 'rescheduled', bookingId: string, by?: { employeeId?: string | null }) {
    if (!this.staff) return;
    try {
      const r = await this.pool.query(`select b.employee_id, to_char(b.date,'YYYY-MM-DD') d, b.start_min, b.service_ids, c.name cname,
        (select string_agg(s.name, ' + ' order by s.name) from services s where s.id = any(b.service_ids)) svc from bookings b left join customers c on c.id = b.customer_id where b.id = $1`, [bookingId]);
      const x = r.rows[0]; if (!x || (by?.employeeId && by.employeeId === x.employee_id)) return;
      const title = { created: 'Nova marcação', cancelled: 'Marcação cancelada', rescheduled: 'Marcação reagendada' }[kind];
      await this.staff.notify(x.employee_id, { title, body: `${x.cname ?? 'Cliente'} · ${fmtWhen(x.d, x.start_min)} · ${x.svc ?? ''}`.trim(), url: `/?dia=${x.d}`, tag: `booking-${bookingId}` });
    } catch { /* aviso é best-effort */ }
  }

  availability(date: DateStr, serviceIds: string[], employeeId: string | undefined, nowMs: number) {
    return tx(this.pool, async c => computeAvailability(date, serviceIds, employeeId, await loadCtx(c, date, nowMs)));
  }

  /** Reserva temporária de 5 min para o horário escolhido no Booking. */
  hold(a: { date: DateStr; startMin: number; serviceIds: string[]; employeeId?: string; nowMs: number }): Promise<Result<{ holdId: string; employeeId: string; expiresAtMs: number }>> {
    return tx(this.pool, async c => {
      await lockEmployees(c);
      const ctx = await loadCtx(c, a.date, a.nowMs);
      const emp = a.employeeId ?? assignEmployee(a.date, a.startMin, a.serviceIds, ctx);
      if (!emp) return { ok: false as const, error: 'sem_disponibilidade' };
      if (!computeAvailability(a.date, a.serviceIds, emp, ctx).some(s => s.startMin === a.startMin)) return { ok: false as const, error: 'indisponivel' };
      const id = randomUUID(), end = a.startMin + totalDuration(a.serviceIds, emp, ctx), exp = a.nowMs + HOLD_MS;
      await c.query('insert into holds(id, employee_id, date, start_min, end_min, expires_at) values ($1,$2,$3,$4,$5,to_timestamp($6/1000.0))', [id, emp, a.date, a.startMin, end, exp]);
      return { ok: true as const, holdId: id, employeeId: emp, expiresAtMs: exp };
    });
  }

  /** Reserva online. Nunca sobrepõe. Se houver `holdId` próprio, é libertada e substituída pela marcação. */
  async createOnline(a: { customer: { name: string; phone: string }; date: DateStr; startMin: number; serviceIds: string[]; employeeId?: string; holdId?: string; nowMs: number }): Promise<Result<{ bookingId: string; employeeId: string }>> {
    if (!a.customer.name?.trim() || !a.customer.phone?.trim()) return { ok: false, error: 'nome_e_telefone_obrigatorios' };
    const res = await tx(this.pool, async c => {
      await lockEmployees(c); // simples e seguro com poucos colaboradores; refinar se crescer
      if (a.holdId) await c.query('delete from holds where id = $1', [a.holdId]);
      const ctx = await loadCtx(c, a.date, a.nowMs);
      const emp = a.employeeId ?? assignEmployee(a.date, a.startMin, a.serviceIds, ctx);
      if (!emp || !computeAvailability(a.date, a.serviceIds, emp, ctx).some(s => s.startMin === a.startMin)) return { ok: false as const, error: 'indisponivel' };
      const cust = await c.query('insert into customers(name, phone) values ($1,$2) returning id', [a.customer.name.trim(), a.customer.phone.trim()]);
      const id = randomUUID(), end = a.startMin + totalDuration(a.serviceIds, emp, ctx);
      await c.query("insert into bookings(id, employee_id, customer_id, date, start_min, end_min, service_ids, source) values ($1,$2,$3,$4,$5,$6,$7,'online')", [id, emp, cust.rows[0].id, a.date, a.startMin, end, a.serviceIds]);
      await audit(c, `cliente:${a.customer.name.trim()}`, 'criar', id, null, { employeeId: emp, date: a.date, startMin: a.startMin, endMin: end }, true);
      return { ok: true as const, bookingId: id, employeeId: emp };
    });
    if (res.ok) { await this.notifier.send('created', res.bookingId); await this.tellBarber('created', res.bookingId); }
    return res;
  }

  /** Marcação no HQ: com conflitos pede confirmação explícita (`confirmConflicts`), como o diálogo "Conflito de marcações". */
  async createHq(a: { actor: string; actorEmployeeId?: string | null; customerId?: number; employeeId: string; date: DateStr; startMin: number; endMin: number; serviceIds: string[]; confirmConflicts?: boolean; notify: boolean; nowMs: number }): Promise<Result<{ bookingId: string }>> {
    const res = await tx(this.pool, async c => {
      await lockEmployees(c, [a.employeeId]);
      const ctx = await loadCtx(c, a.date, a.nowMs);
      const conflicts = findConflicts({ employeeId: a.employeeId, date: a.date, startMin: a.startMin, endMin: a.endMin, serviceIds: a.serviceIds }, ctx);
      if (conflicts.length && !a.confirmConflicts) return { ok: false as const, error: 'conflito', conflicts };
      const id = randomUUID();
      await c.query("insert into bookings(id, employee_id, customer_id, date, start_min, end_min, service_ids, source) values ($1,$2,$3,$4,$5,$6,$7,'hq')", [id, a.employeeId, a.customerId ?? null, a.date, a.startMin, a.endMin, a.serviceIds]);
      await audit(c, a.actor, conflicts.length ? 'criar_com_conflito' : 'criar', id, null, { employeeId: a.employeeId, date: a.date, startMin: a.startMin, endMin: a.endMin }, a.notify);
      return { ok: true as const, bookingId: id };
    });
    if (res.ok) { if (a.notify) await this.notifier.send('created', res.bookingId); await this.tellBarber('created', res.bookingId, { employeeId: a.actorEmployeeId }); }
    return res;
  }

  /** Cancelar. Cliente online: até 3 h antes. Staff: sempre; pergunta sempre `notify`. */
  async cancel(a: { bookingId: string; by: 'customer' | 'staff'; actor: string; actorEmployeeId?: string | null; notify: boolean; nowMs: number }): Promise<Result<{}>> {
    const res = await tx(this.pool, async c => {
      const r = await c.query("select employee_id, to_char(date,'YYYY-MM-DD') d, start_min, end_min, status from bookings where id = $1 for update", [a.bookingId]);
      const b = r.rows[0];
      if (!b) return { ok: false as const, error: 'nao_encontrada' };
      if (b.status === 'cancelled') return { ok: false as const, error: 'ja_cancelada' };
      if (a.by === 'customer' && !canCancelOrReschedule({ date: b.d, startMin: b.start_min }, a.nowMs)) return { ok: false as const, error: 'fora_do_prazo' };
      await c.query("update bookings set status = 'cancelled' where id = $1", [a.bookingId]);
      await audit(c, a.actor, 'cancelar', a.bookingId, { status: b.status }, { status: 'cancelled' }, a.notify);
      return { ok: true as const };
    });
    if (res.ok) { if (a.notify) await this.notifier.send('cancelled', a.bookingId); await this.tellBarber('cancelled', a.bookingId, { employeeId: a.actorEmployeeId }); }
    return res;
  }

  /** Reagendar (mesmo colaborador). Cliente online: respeita prazo e nunca sobrepõe. */
  async reschedule(a: { bookingId: string; by: 'customer' | 'staff'; actor: string; actorEmployeeId?: string | null; date: DateStr; startMin: number; notify: boolean; confirmConflicts?: boolean; nowMs: number }): Promise<Result<{}>> {
    const res = await tx(this.pool, async c => {
      await lockEmployees(c);
      const r = await c.query("select employee_id, to_char(date,'YYYY-MM-DD') d, start_min, end_min, service_ids, status from bookings where id = $1 for update", [a.bookingId]);
      const b = r.rows[0];
      if (!b || b.status === 'cancelled') return { ok: false as const, error: 'nao_encontrada' };
      if (a.by === 'customer' && !canCancelOrReschedule({ date: b.d, startMin: b.start_min }, a.nowMs)) return { ok: false as const, error: 'fora_do_prazo' };
      const ctx = await loadCtx(c, a.date, a.nowMs);
      const end = a.startMin + (b.end_min - b.start_min);
      const conflicts = findConflicts({ employeeId: b.employee_id, date: a.date, startMin: a.startMin, endMin: end, ignoreBookingId: a.bookingId }, ctx, { online: a.by === 'customer' });
      if (conflicts.length && (a.by === 'customer' || !a.confirmConflicts)) return { ok: false as const, error: 'conflito', conflicts };
      if (a.by === 'customer') {
        const own = { ...ctx, bookings: ctx.bookings.filter(x => x.id !== a.bookingId) };
        if (!computeAvailability(a.date, b.service_ids, b.employee_id, own).some(x => x.startMin === a.startMin)) return { ok: false as const, error: 'indisponivel' };
      }
      await c.query('update bookings set date = $2, start_min = $3, end_min = $4 where id = $1', [a.bookingId, a.date, a.startMin, end]);
      await audit(c, a.actor, 'reagendar', a.bookingId, { date: b.d, startMin: b.start_min }, { date: a.date, startMin: a.startMin }, a.notify);
      return { ok: true as const };
    });
    if (res.ok) { if (a.notify) await this.notifier.send('rescheduled', a.bookingId); await this.tellBarber('rescheduled', a.bookingId, { employeeId: a.actorEmployeeId }); }
    return res;
  }
}
