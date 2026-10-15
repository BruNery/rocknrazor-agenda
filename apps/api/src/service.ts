import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { fmtWhen, type StaffNotifier } from './push';
import { canCancelOrReschedule, todayLocal, type OnlineRules, computeAvailability, findConflicts, assignEmployee, totalDuration, type Conflict, type Ctx, type DateStr } from '@rr/domain';

export interface Notifier { send(kind: 'created' | 'cancelled' | 'rescheduled', bookingId: string): Promise<void> }
export class FakeNotifier implements Notifier { sent: { kind: string; bookingId: string }[] = []; async send(kind: any, bookingId: string) { this.sent.push({ kind, bookingId }); } }

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; conflicts?: Conflict[] };

export function rulesFromRow(r: any): OnlineRules {
  return { gridMin: r.grid_min, maxWeeksAhead: r.max_weeks_ahead, lastBookingLeadMin: r.last_booking_lead_min, cancelLeadMin: r.cancel_lead_min, holdMin: r.hold_min, maxOpenOnline: r.max_open_online, allowOnlineOverlap: r.allow_online_overlap, anyBarberPolicy: r.any_barber_policy };
}
export async function loadRules(db: Pick<Pool, 'query'>): Promise<OnlineRules> { return rulesFromRow((await db.query('select * from shop_settings where id = 1')).rows[0]); }

async function loadCtx(db: PoolClient, date: DateStr, nowMs: number): Promise<Ctx> {
  // Um cliente pg só executa uma consulta de cada vez: sequencial.
  const st = (await db.query('select * from shop_settings where id = 1')).rows[0];
  const rules = rulesFromRow(st);
  const emp = await db.query('select id, available_online, auto_assign, sort_order from employees where active');
  const svc = await db.query('select id, duration_min, pause_min from services');  // inclui inativos: marcações antigas continuam a calcular
  const es = await db.query('select employee_id, service_id, online_available, calendar_available, duration_min from employee_services');
  const oh = await db.query('select weekday, open_min, close_min from opening_hours');
  const bl = await db.query("select id, employee_id, to_char(date,'YYYY-MM-DD') d, all_day, start_min, end_min from blocks where date = $1", [date]);
  const pa = await db.query('select id, employee_id, start_min, end_min from employee_pauses where weekday = extract(dow from $1::date)', [date]);
  const bk = await db.query("select id, employee_id, to_char(date,'YYYY-MM-DD') d, start_min, end_min, status from bookings where date = $1", [date]);
  const ho = await db.query("select employee_id, to_char(date,'YYYY-MM-DD') d, start_min, end_min, extract(epoch from expires_at)*1000 ms from holds where date = $1", [date]);
  const openingHours: Ctx['openingHours'] = {};
  for (const r of oh.rows) (openingHours[r.weekday] ??= []).push({ open: r.open_min, close: r.close_min });
  return {
    nowMs, openingHours, rules,
    employees: emp.rows.map(r => ({ id: r.id, availableOnline: r.available_online, autoAssign: r.auto_assign, order: r.sort_order })),
    services: svc.rows.map(r => ({ id: r.id, durationMin: r.duration_min, pauseMin: r.pause_min })),
    employeeServices: es.rows.map(r => ({ employeeId: r.employee_id, serviceId: r.service_id, onlineAvailable: r.online_available, calendarAvailable: r.calendar_available, durationMin: r.duration_min ?? undefined })),
    blocks: [...bl.rows.map(r => ({ id: r.id, employeeId: r.employee_id, date: r.d, allDay: r.all_day, startMin: r.start_min ?? undefined, endMin: r.end_min ?? undefined })),
      ...pa.rows.map(r => ({ id: `pausa-${r.id}`, employeeId: r.employee_id, date, startMin: r.start_min, endMin: r.end_min }))],
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

const digitsOf = (s: string) => s.replace(/\D/g, '');
/** Cliente por telefone (compara os últimos 9 dígitos, ignorando o indicativo): reutiliza o existente (pontos e histórico ficam juntos) ou cria. */
export async function upsertCustomer(c: PoolClient | Pool, d: { name: string; phone: string; email?: string }): Promise<number> {
  const dg = digitsOf(d.phone).slice(-9);
  if (dg.length >= 9) { const r = await c.query("select id from customers where right(regexp_replace(phone, '\\D', '', 'g'), 9) = $1 order by id limit 1", [dg]); if (r.rowCount) return Number(r.rows[0].id); }
  const r = await c.query('insert into customers(name, phone, email) values ($1,$2,$3) returning id', [d.name.trim(), d.phone.trim(), d.email?.trim() || null]);
  return Number(r.rows[0].id);
}

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

  /** Serviços desativados no HQ deixam de poder ser marcados online. */
  private async allActive(serviceIds: string[]) {
    const r = await this.pool.query('select count(*)::int n from services where id = any($1) and active', [serviceIds]); return r.rows[0].n === new Set(serviceIds).size;
  }

  async availability(date: DateStr, serviceIds: string[], employeeId: string | undefined, nowMs: number) {
    if (!(await this.allActive(serviceIds))) return [];
    return tx(this.pool, async c => computeAvailability(date, serviceIds, employeeId, await loadCtx(c, date, nowMs)));
  }

  /** Reserva temporária (duração definida no HQ) para o horário escolhido no Booking. */
  async hold(a: { date: DateStr; startMin: number; serviceIds: string[]; employeeId?: string; nowMs: number }): Promise<Result<{ holdId: string; employeeId: string; expiresAtMs: number }>> {
    if (!(await this.allActive(a.serviceIds))) return { ok: false, error: 'indisponivel' };
    return tx(this.pool, async c => {
      await lockEmployees(c);
      const ctx = await loadCtx(c, a.date, a.nowMs);
      const emp = a.employeeId ?? assignEmployee(a.date, a.startMin, a.serviceIds, ctx);
      if (!emp) return { ok: false as const, error: 'sem_disponibilidade' };
      if (!computeAvailability(a.date, a.serviceIds, emp, ctx).some(s => s.startMin === a.startMin)) return { ok: false as const, error: 'indisponivel' };
      const id = randomUUID(), end = a.startMin + totalDuration(a.serviceIds, emp, ctx), exp = a.nowMs + ctx.rules!.holdMin * 60_000;
      await c.query('insert into holds(id, employee_id, date, start_min, end_min, expires_at) values ($1,$2,$3,$4,$5,to_timestamp($6/1000.0))', [id, emp, a.date, a.startMin, end, exp]);
      return { ok: true as const, holdId: id, employeeId: emp, expiresAtMs: exp };
    });
  }

  /** Reserva online. Nunca sobrepõe. Se houver `holdId` próprio, é libertada e substituída pela marcação. */
  async createOnline(a: { customer: { name: string; phone: string }; date: DateStr; startMin: number; serviceIds: string[]; employeeId?: string; holdId?: string; nowMs: number }): Promise<Result<{ bookingId: string; employeeId: string }>> {
    if (!a.customer.name?.trim() || !a.customer.phone?.trim()) return { ok: false, error: 'nome_e_telefone_obrigatorios' };
    if (!(await this.allActive(a.serviceIds))) return { ok: false, error: 'indisponivel' };
    const res = await tx(this.pool, async c => {
      await lockEmployees(c); // simples e seguro com poucos colaboradores; refinar se crescer
      if (a.holdId) await c.query('delete from holds where id = $1', [a.holdId]);
      const ctx = await loadCtx(c, a.date, a.nowMs);
      const emp = a.employeeId ?? assignEmployee(a.date, a.startMin, a.serviceIds, ctx);
      if (!emp || !computeAvailability(a.date, a.serviceIds, emp, ctx).some(s => s.startMin === a.startMin)) return { ok: false as const, error: 'indisponivel' };
      const customerId = await upsertCustomer(c, a.customer);
      const cap = ctx.rules!.maxOpenOnline;
      if (cap > 0) {
        const open = await c.query("select count(*)::int n from bookings where customer_id = $1 and source = 'online' and status = 'confirmed' and date >= $2", [customerId, todayLocal(a.nowMs)]);
        if (open.rows[0].n >= cap) return { ok: false as const, error: 'limite_marcacoes_abertas' };
      }
      const id = randomUUID(), end = a.startMin + totalDuration(a.serviceIds, emp, ctx);
      await c.query("insert into bookings(id, employee_id, customer_id, date, start_min, end_min, service_ids, source) values ($1,$2,$3,$4,$5,$6,$7,'online')", [id, emp, customerId, a.date, a.startMin, end, a.serviceIds]);
      await audit(c, `cliente:${a.customer.name.trim()}`, 'criar', id, null, { employeeId: emp, date: a.date, startMin: a.startMin, endMin: end }, true);
      return { ok: true as const, bookingId: id, employeeId: emp };
    });
    if (res.ok) { await this.notifier.send('created', res.bookingId); await this.tellBarber('created', res.bookingId); }
    return res;
  }

  /** Marcação no HQ: com conflitos pede confirmação explícita (`confirmConflicts`), como o diálogo "Conflito de marcações". */
  async createHq(a: { actor: string; actorEmployeeId?: string | null; customerId?: number; customer?: { name: string; phone: string; email?: string }; notes?: string; employeeId: string; date: DateStr; startMin: number; endMin: number; serviceIds: string[]; confirmConflicts?: boolean; notify: boolean; nowMs: number }): Promise<Result<{ bookingId: string }>> {
    const res = await tx(this.pool, async c => {
      await lockEmployees(c, [a.employeeId]);
      const ctx = await loadCtx(c, a.date, a.nowMs);
      const conflicts = findConflicts({ employeeId: a.employeeId, date: a.date, startMin: a.startMin, endMin: a.endMin, serviceIds: a.serviceIds }, ctx);
      if (conflicts.length && !a.confirmConflicts) return { ok: false as const, error: 'conflito', conflicts };
      const id = randomUUID();
      const customerId = a.customerId ?? (a.customer ? await upsertCustomer(c, a.customer) : null);
      await c.query("insert into bookings(id, employee_id, customer_id, date, start_min, end_min, service_ids, source, notes) values ($1,$2,$3,$4,$5,$6,$7,'hq',$8)", [id, a.employeeId, customerId, a.date, a.startMin, a.endMin, a.serviceIds, a.notes ?? '']);
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
      if (a.by === 'customer' && !canCancelOrReschedule({ date: b.d, startMin: b.start_min }, a.nowMs, await loadRules(c))) return { ok: false as const, error: 'fora_do_prazo' };
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
      if (a.by === 'customer' && !canCancelOrReschedule({ date: b.d, startMin: b.start_min }, a.nowMs, await loadRules(c))) return { ok: false as const, error: 'fora_do_prazo' };
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

  /** Edição completa da ficha pelo HQ: estado, notas, serviços, dia/hora e (só admin) barbeiro. Pede confirmação se houver conflito. */
  async updateHq(a: { bookingId: string; actor: string; actorEmployeeId?: string | null; isAdmin: boolean; patch: { employeeId?: string; date?: DateStr; startMin?: number; serviceIds?: string[]; notes?: string; status?: 'confirmed' | 'cancelled' | 'noshow' }; confirmConflicts?: boolean; notify: boolean; nowMs: number }): Promise<Result<{}>> {
    let kind: 'cancelled' | 'rescheduled' | null = null;
    const res = await tx(this.pool, async c => {
      await lockEmployees(c);
      const r = await c.query("select employee_id, to_char(date,'YYYY-MM-DD') d, start_min, end_min, service_ids, status, notes from bookings where id = $1 for update", [a.bookingId]);
      const b = r.rows[0]; if (!b) return { ok: false as const, error: 'nao_encontrada' };
      const p = a.patch;
      if (p.employeeId && p.employeeId !== b.employee_id && !a.isAdmin) return { ok: false as const, error: 'sem_permissao' };
      const emp = p.employeeId ?? b.employee_id, date = p.date ?? b.d, start = p.startMin ?? b.start_min, svcIds: string[] = p.serviceIds ?? b.service_ids, status = p.status ?? b.status;
      const ctx = await loadCtx(c, date, a.nowMs);
      const changedSvc = p.serviceIds !== undefined && p.serviceIds.join() !== b.service_ids.join();
      const moved = emp !== b.employee_id || date !== b.d || start !== b.start_min;
      const end = changedSvc || emp !== b.employee_id ? start + totalDuration(svcIds, emp, ctx) : start + (b.end_min - b.start_min);
      if (status !== 'cancelled' && (moved || changedSvc)) {
        const cs = findConflicts({ employeeId: emp, date, startMin: start, endMin: end, serviceIds: svcIds, ignoreBookingId: a.bookingId }, ctx);
        if (cs.length && !a.confirmConflicts) return { ok: false as const, error: 'conflito', conflicts: cs };
      }
      await c.query('update bookings set employee_id=$2, date=$3, start_min=$4, end_min=$5, service_ids=$6, status=$7, notes=$8 where id=$1', [a.bookingId, emp, date, start, end, svcIds, status, p.notes ?? b.notes]);
      await audit(c, a.actor, status === 'cancelled' && b.status !== 'cancelled' ? 'cancelar' : moved ? 'reagendar' : 'editar', a.bookingId, { employeeId: b.employee_id, date: b.d, startMin: b.start_min, status: b.status }, { employeeId: emp, date, startMin: start, status }, a.notify);
      if (status === 'cancelled' && b.status !== 'cancelled') kind = 'cancelled'; else if (moved) kind = 'rescheduled';
      return { ok: true as const };
    });
    if (res.ok && kind) { if (a.notify) await this.notifier.send(kind, a.bookingId); await this.tellBarber(kind, a.bookingId, { employeeId: a.actorEmployeeId }); }
    return res;
  }
}
