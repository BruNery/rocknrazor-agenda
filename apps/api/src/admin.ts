import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { newMemberCode } from './member';
import { randomInt } from 'node:crypto';
import { loadRules } from './service';
import type { User } from './auth';
import { hashPassword } from './auth';

const id = z.string().regex(/^[a-z0-9_-]{1,40}$/);
const cents = z.number().int().min(0).max(1_000_000);
export { newMemberCode };

const rulesBody = z.object({
  gridMin: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(60)]),
  maxWeeksAhead: z.number().int().min(1).max(52),
  lastBookingLeadMin: z.number().int().min(0).max(1440),
  cancelLeadMin: z.number().int().min(0).max(10080),
  holdMin: z.number().int().min(1).max(30),
  maxOpenOnline: z.number().int().min(0).max(20),
  snapAfterEnd: z.boolean().optional(),
  allowOnlineOverlap: z.boolean(),
  anyBarberPolicy: z.enum(['fewest_bookings', 'first_in_order']),
}).strict();

/** Tudo o que o HQ gere: regras, barbeiros, serviços, produtos, horário e pontos. Só o administrador. */
export function registerAdmin(app: FastifyInstance, pool: Pool, needAdmin: (req: any, reply: any) => Promise<User | null>) {
  const audit = (actor: string, action: string, after: unknown) => pool.query('insert into audit_log(actor, action, after) values ($1,$2,$3)', [actor, action, after]);
  const dup = (e: any, reply: any) => { if (e.code === '23505') return reply.code(409).send({ ok: false, error: 'ja_existe' }); if (e.code === '23503') return reply.code(422).send({ ok: false, error: 'referencia_invalida' }); throw e; };

  // --- Regras de marcação ---
  app.get('/admin/settings', async (req, reply) => { if (!(await needAdmin(req, reply))) return; return { ok: true, rules: await loadRules(pool) }; });
  app.put('/admin/settings', async (req, reply) => {
    const u = await needAdmin(req, reply); if (!u) return;
    const b = rulesBody.parse(req.body);
    await pool.query(`update shop_settings set grid_min=$1, max_weeks_ahead=$2, last_booking_lead_min=$3, cancel_lead_min=$4, hold_min=$5, max_open_online=$6, allow_online_overlap=$7, any_barber_policy=$8, snap_after_end=coalesce($9, snap_after_end), updated_at=now() where id=1`,
      [b.gridMin, b.maxWeeksAhead, b.lastBookingLeadMin, b.cancelLeadMin, b.holdMin, b.maxOpenOnline, b.allowOnlineOverlap, b.anyBarberPolicy, b.snapAfterEnd ?? null]);
    await audit(u.username, 'definicoes', b); return { ok: true, rules: await loadRules(pool) };
  });

  // --- Barbeiros (nunca se apagam: desativam-se, para o histórico ficar intacto) ---
  app.get('/admin/employees', async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    const r = await pool.query('select id, name, nickname, specialties, active, available_online, auto_assign, sort_order from employees order by sort_order, id');
    return { ok: true, employees: r.rows.map(x => ({ id: x.id, name: x.name, nickname: x.nickname, specialties: x.specialties, active: x.active, availableOnline: x.available_online, autoAssign: x.auto_assign, order: x.sort_order })) };
  });
  const empBody = z.object({ name: z.string().min(1).max(80), nickname: z.string().max(40).nullable().optional(), specialties: z.string().max(160).optional(), availableOnline: z.boolean().optional(), autoAssign: z.boolean().optional(), order: z.number().int().min(0).max(999).optional() });
  app.post('/admin/employees', async (req, reply) => {
    const u = await needAdmin(req, reply); if (!u) return;
    const b = empBody.extend({ id }).parse(req.body);
    try { await pool.query('insert into employees(id, name, nickname, specialties, available_online, auto_assign, sort_order) values ($1,$2,$3,$4,$5,$6,$7)', [b.id, b.name, b.nickname ?? null, b.specialties ?? '', b.availableOnline ?? true, b.autoAssign ?? true, b.order ?? 0]); }
    catch (e) { return dup(e, reply); }
    await audit(u.username, 'barbeiro_criar', b); return { ok: true };
  });
  app.patch('/admin/employees/:id', async (req, reply) => {
    const u = await needAdmin(req, reply); if (!u) return;
    const b = empBody.partial().extend({ active: z.boolean().optional() }).parse(req.body); const eid = (req.params as any).id;
    const r = await pool.query(`update employees set name=coalesce($2,name), nickname=case when $3::boolean then $4 else nickname end, specialties=coalesce($5,specialties), available_online=coalesce($6,available_online), auto_assign=coalesce($7,auto_assign), sort_order=coalesce($8,sort_order), active=coalesce($9,active) where id=$1`,
      [eid, b.name ?? null, b.nickname !== undefined, b.nickname ?? null, b.specialties ?? null, b.availableOnline ?? null, b.autoAssign ?? null, b.order ?? null, b.active ?? null]);
    if (!r.rowCount) return reply.code(404).send({ ok: false, error: 'nao_encontrado' });
    if (b.active === false) { // barbeiro desativado: fecha os acessos e avisos dele
      await pool.query('update users set active=false where employee_id=$1', [eid]);
      await pool.query('delete from sessions where user_id in (select id from users where employee_id=$1)', [eid]);
    }
    await audit(u.username, 'barbeiro_editar', { id: eid, ...b }); return { ok: true };
  });
  /** Que serviços cada barbeiro faz, com duração própria opcional. */
  app.put('/admin/employees/:id/services', async (req, reply) => {
    const u = await needAdmin(req, reply); if (!u) return; const eid = (req.params as any).id;
    const b = z.object({ services: z.array(z.object({ serviceId: id, onlineAvailable: z.boolean().default(true), calendarAvailable: z.boolean().default(true), durationMin: z.number().int().min(5).max(480).nullable().optional() })).max(100) }).parse(req.body);
    const c = await pool.connect();
    try {
      await c.query('begin');
      if (!(await c.query('select 1 from employees where id=$1', [eid])).rowCount) { await c.query('rollback'); return reply.code(404).send({ ok: false, error: 'nao_encontrado' }); }
      await c.query('delete from employee_services where employee_id=$1', [eid]);
      for (const s of b.services) await c.query('insert into employee_services(employee_id, service_id, online_available, calendar_available, duration_min) values ($1,$2,$3,$4,$5)', [eid, s.serviceId, s.onlineAvailable, s.calendarAvailable, s.durationMin ?? null]);
      await c.query('commit');
    } catch (e) { await c.query('rollback'); return dup(e, reply); } finally { c.release(); }
    await audit(u.username, 'barbeiro_servicos', { id: eid, services: b.services }); return { ok: true };
  });

  // --- Serviços ---
  app.get('/admin/services', async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    const r = await pool.query('select id, name, duration_min, pause_min, price_cents, active, sort_order, points_price from services order by sort_order, id');
    return { ok: true, services: r.rows.map(x => ({ id: x.id, name: x.name, durationMin: x.duration_min, pauseMin: x.pause_min, priceCents: x.price_cents, active: x.active, order: x.sort_order, pointsPrice: x.points_price })) };
  });
  const svcBody = z.object({ name: z.string().min(1).max(80), durationMin: z.number().int().min(5).max(480), pauseMin: z.number().int().min(0).max(120).optional(), priceCents: cents, order: z.number().int().min(0).max(999).optional(), pointsPrice: z.number().int().min(1).max(100000).nullable().optional() });
  app.post('/admin/services', async (req, reply) => {
    const u = await needAdmin(req, reply); if (!u) return; const b = svcBody.extend({ id }).parse(req.body);
    try { await pool.query('insert into services(id, name, duration_min, pause_min, price_cents, sort_order, points_price) values ($1,$2,$3,$4,$5,$6,$7)', [b.id, b.name, b.durationMin, b.pauseMin ?? 0, b.priceCents, b.order ?? 0, b.pointsPrice ?? null]); }
    catch (e) { return dup(e, reply); }
    await audit(u.username, 'servico_criar', b); return { ok: true };
  });
  app.patch('/admin/services/:id', async (req, reply) => {
    const u = await needAdmin(req, reply); if (!u) return; const sid = (req.params as any).id;
    const b = svcBody.partial().extend({ active: z.boolean().optional() }).parse(req.body);
    const r = await pool.query(`update services set name=coalesce($2,name), duration_min=coalesce($3,duration_min), pause_min=coalesce($4,pause_min), price_cents=coalesce($5,price_cents), sort_order=coalesce($6,sort_order), active=coalesce($7,active), points_price=case when $8::boolean then $9 else points_price end where id=$1`,
      [sid, b.name ?? null, b.durationMin ?? null, b.pauseMin ?? null, b.priceCents ?? null, b.order ?? null, b.active ?? null, b.pointsPrice !== undefined, b.pointsPrice ?? null]);
    if (!r.rowCount) return reply.code(404).send({ ok: false, error: 'nao_encontrado' });
    await audit(u.username, 'servico_editar', { id: sid, ...b }); return { ok: true };
  });

  // --- Produtos à venda ---
  app.get('/admin/products', async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    const r = await pool.query('select id, name, price_cents, stock, active, sort_order, points_price from products order by sort_order, id');
    return { ok: true, products: r.rows.map(x => ({ id: x.id, name: x.name, priceCents: x.price_cents, stock: x.stock, active: x.active, order: x.sort_order, pointsPrice: x.points_price })) };
  });
  const prodBody = z.object({ name: z.string().min(1).max(80), priceCents: cents, stock: z.number().int().min(0).max(100000).nullable().optional(), order: z.number().int().min(0).max(999).optional(), pointsPrice: z.number().int().min(1).max(100000).nullable().optional() });
  app.post('/admin/products', async (req, reply) => {
    const u = await needAdmin(req, reply); if (!u) return; const b = prodBody.extend({ id }).parse(req.body);
    try { await pool.query('insert into products(id, name, price_cents, stock, sort_order, points_price) values ($1,$2,$3,$4,$5,$6)', [b.id, b.name, b.priceCents, b.stock ?? null, b.order ?? 0, b.pointsPrice ?? null]); }
    catch (e) { return dup(e, reply); }
    await audit(u.username, 'produto_criar', b); return { ok: true };
  });
  app.patch('/admin/products/:id', async (req, reply) => {
    const u = await needAdmin(req, reply); if (!u) return; const pid = (req.params as any).id;
    const b = prodBody.partial().extend({ active: z.boolean().optional() }).parse(req.body);
    const r = await pool.query(`update products set name=coalesce($2,name), price_cents=coalesce($3,price_cents), stock=case when $4::boolean then $5 else stock end, sort_order=coalesce($6,sort_order), active=coalesce($7,active), points_price=case when $8::boolean then $9 else points_price end where id=$1`,
      [pid, b.name ?? null, b.priceCents ?? null, b.stock !== undefined, b.stock ?? null, b.order ?? null, b.active ?? null, b.pointsPrice !== undefined, b.pointsPrice ?? null]);
    if (!r.rowCount) return reply.code(404).send({ ok: false, error: 'nao_encontrado' });
    await audit(u.username, 'produto_editar', { id: pid, ...b }); return { ok: true };
  });

  // --- Horário de funcionamento (substitui o conjunto todo) ---
  app.get('/admin/opening-hours', async (req, reply) => { if (!(await needAdmin(req, reply))) return; const r = await pool.query('select weekday, open_min, close_min from opening_hours order by weekday, open_min'); return { ok: true, hours: r.rows.map(x => ({ weekday: x.weekday, openMin: x.open_min, closeMin: x.close_min })) }; });
  app.put('/admin/opening-hours', async (req, reply) => {
    const u = await needAdmin(req, reply); if (!u) return;
    const b = z.object({ hours: z.array(z.object({ weekday: z.number().int().min(0).max(6), openMin: z.number().int().min(0).max(1440), closeMin: z.number().int().min(1).max(1440) }).refine(h => h.closeMin > h.openMin)).max(30) }).parse(req.body);
    const c = await pool.connect();
    try { await c.query('begin'); await c.query('delete from opening_hours'); for (const h of b.hours) await c.query('insert into opening_hours(weekday, open_min, close_min) values ($1,$2,$3)', [h.weekday, h.openMin, h.closeMin]); await c.query('commit'); }
    catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
    await audit(u.username, 'horario', b); return { ok: true };
  });

  // --- Pontos: ajuste manual (somar ou retirar) com motivo; o saldo é a soma do livro-razão ---
  app.get('/admin/customers/:id/points', async (req, reply) => {
    if (!(await needAdmin(req, reply))) return; const cid = Number((req.params as any).id);
    const c = await pool.query('select member_code from customers where id=$1', [cid]); if (!c.rowCount) return reply.code(404).send({ ok: false, error: 'nao_encontrado' });
    const l = await pool.query('select delta, kind, note, created_at from points_ledger where customer_id=$1 order by id desc limit 100', [cid]);
    const bal = await pool.query('select coalesce(sum(delta),0)::int n from points_ledger where customer_id=$1', [cid]);
    return { ok: true, memberCode: c.rows[0].member_code, balance: bal.rows[0].n, history: l.rows.map(x => ({ delta: x.delta, kind: x.kind, note: x.note, at: x.created_at })) };
  });
  app.post('/admin/customers/:id/points', async (req, reply) => {
    const u = await needAdmin(req, reply); if (!u) return; const cid = Number((req.params as any).id);
    const b = z.object({ delta: z.number().int().min(-100000).max(100000).refine(n => n !== 0), note: z.string().trim().min(3).max(200) }).parse(req.body);
    const c = await pool.connect();
    try {
      await c.query('begin');
      const cu = await c.query('select id, member_code from customers where id=$1 for update', [cid]);
      if (!cu.rowCount) { await c.query('rollback'); return reply.code(404).send({ ok: false, error: 'nao_encontrado' }); }
      const bal = (await c.query('select coalesce(sum(delta),0)::int n from points_ledger where customer_id=$1', [cid])).rows[0].n;
      if (bal + b.delta < 0) { await c.query('rollback'); return reply.code(422).send({ ok: false, error: 'saldo_insuficiente', balance: bal }); }
      if (!cu.rows[0].member_code) for (;;) { try { await c.query('savepoint mc'); await c.query('update customers set member_code=$2 where id=$1', [cid, newMemberCode()]); break; } catch (e: any) { if (e.code !== '23505') throw e; await c.query('rollback to savepoint mc'); } }
      await c.query("insert into points_ledger(customer_id, delta, kind, note, created_by) values ($1,$2,'manual',$3,$4)", [cid, b.delta, b.note, u.id]);
      await c.query('commit'); await audit(u.username, 'pontos_manual', { customerId: cid, ...b });
      return { ok: true, balance: bal + b.delta };
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  });

  // --- Contas de acesso dos barbeiros (o admin cria, repõe palavra-passe, desativa e reativa) ---
  app.get('/admin/users', async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    const r = await pool.query('select id, username, role, employee_id, active from users order by id');
    return { ok: true, users: r.rows.map(x => ({ id: Number(x.id), username: x.username, role: x.role, employeeId: x.employee_id, active: x.active })) };
  });
  app.post('/admin/users/:id/activate', async (req, reply) => {
    const u = await needAdmin(req, reply); if (!u) return; const uid = Number((req.params as any).id);
    const r = await pool.query('update users set active = true where id = $1 and (employee_id is null or employee_id in (select id from employees where active))', [uid]);
    if (!r.rowCount) return reply.code(404).send({ ok: false, error: 'nao_encontrado' }); await audit(u.username, 'conta_ativar', { id: uid }); return { ok: true };
  });

  // --- Clientes (só admin): procurar e ver pontos ---
  app.get('/admin/customers', async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    const q = z.object({ q: z.string().trim().max(80).default('') }).parse(req.query);
    const like = `%${q.q.replace(/[%_\\]/g, m => '\\' + m)}%`, dg = q.q.replace(/\D/g, '');
    const r = await pool.query(`select c.id, c.name, c.phone, c.email, c.member_code, coalesce((select sum(delta) from points_ledger p where p.customer_id = c.id), 0)::int points
      from customers c where $1 = '%%' or c.name ilike $1 or c.member_code ilike $1 or ($2 <> '' and regexp_replace(c.phone, '\\D', '', 'g') like '%' || $2 || '%') order by c.name limit 30`, [like, dg]);
    return { ok: true, customers: r.rows.map(x => ({ id: Number(x.id), name: x.name, phone: x.phone, email: x.email ?? '', memberCode: x.member_code, points: x.points })) };
  });
}
