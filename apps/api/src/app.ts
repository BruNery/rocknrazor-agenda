import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from 'pg';
import { BookingService, loadRules, type Notifier } from './service';
import { registerAdmin } from './admin';
import { registerStatic } from './static';
import type { StaffNotifier } from './push';
import { barberMetrics, shopMetrics, revenueByDay, periodBefore, weekday, addDays, type Sale } from '@rr/domain';
import { hashPassword, verifyPassword, DUMMY_HASH, createSession, userFromToken, sha, cookieToken, sessionCookie, clearCookie, MAX_FAILURES, FAILURE_WINDOW_MIN, type User } from './auth';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const min = z.number().int().min(0).max(1440);
const services = z.array(z.string().min(1)).min(1);

export function buildApp(pool: Pool, notifier: Notifier, clock: () => number = Date.now, opts: { secureCookies?: boolean; staff?: StaffNotifier; vapidPublicKey?: string; publicDir?: string } = {}) {
  const secure = !!opts.secureCookies;
  const app = Fastify();
  const svc = new BookingService(pool, notifier, opts.staff);
  const status = (r: { ok: boolean; error?: string }) => (r.ok ? 200 : r.error === 'nao_encontrada' ? 404 : r.error === 'indisponivel' || r.error === 'conflito' || r.error === 'ja_cancelada' ? 409 : 422);

  app.setErrorHandler((err: any, _req, reply) => reply.code(err.name === 'ZodError' ? 400 : 500).send({ ok: false, error: err.name === 'ZodError' ? 'pedido_invalido' : 'erro_interno', detalhe: err.name === 'ZodError' ? err.issues : undefined }));

  app.get('/healthz', async () => { await pool.query('select 1'); return { ok: true }; });

  // Público (Booking)
  app.get('/public/availability', async req => {
    const q = z.object({ date, services: z.string().min(1), employeeId: z.string().optional() }).parse(req.query);
    return { ok: true, slots: await svc.availability(q.date, q.services.split(','), q.employeeId, clock()) };
  });
  app.post('/public/holds', async (req, reply) => {
    const b = z.object({ date, startMin: min, serviceIds: services, employeeId: z.string().optional() }).parse(req.body);
    const r = await svc.hold({ ...b, nowMs: clock() }); return reply.code(status(r)).send(r);
  });
  app.post('/public/bookings', async (req, reply) => {
    const b = z.object({ customer: z.object({ name: z.string(), phone: z.string() }), date, startMin: min, serviceIds: services, employeeId: z.string().optional(), holdId: z.string().optional() }).parse(req.body);
    const r = await svc.createOnline({ ...b, nowMs: clock() }); return reply.code(status(r)).send(r);
  });
  app.post('/public/bookings/:id/cancel', async (req, reply) => {
    const r = await svc.cancel({ bookingId: (req.params as any).id, by: 'customer', actor: 'cliente', notify: true, nowMs: clock() }); return reply.code(status(r)).send(r);
  });
  app.post('/public/bookings/:id/reschedule', async (req, reply) => {
    const b = z.object({ date, startMin: min }).parse(req.body);
    const r = await svc.reschedule({ bookingId: (req.params as any).id, by: 'customer', actor: 'cliente', ...b, notify: true, nowMs: clock() }); return reply.code(status(r)).send(r);
  });

  // ---------- Autenticação ----------
  app.post('/auth/login', async (req, reply) => {
    const b = z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(200) }).parse(req.body);
    const username = b.username.trim().toLowerCase();
    const fails = await pool.query("select count(*)::int n from login_failures where username = $1 and at > now() - make_interval(mins => $2)", [username, FAILURE_WINDOW_MIN]);
    if (fails.rows[0].n >= MAX_FAILURES) return reply.code(429).send({ ok: false, error: 'demasiadas_tentativas' });
    const r = await pool.query('select id, password_hash, role, employee_id, active from users where username = $1', [username]);
    const u = r.rows[0]; const good = await verifyPassword(b.password, u?.password_hash ?? DUMMY_HASH);
    if (!u || !u.active || !good) { await pool.query('insert into login_failures(username) values ($1)', [username]); return reply.code(401).send({ ok: false, error: 'credenciais_invalidas' }); }
    await pool.query('delete from login_failures where username = $1', [username]);
    const token = await createSession(pool, Number(u.id));
    return reply.header('set-cookie', sessionCookie(token, secure)).send({ ok: true, user: { username, role: u.role, employeeId: u.employee_id } });
  });
  app.post('/auth/logout', async (req, reply) => {
    const t = cookieToken(req.headers.cookie); if (t) await pool.query('delete from sessions where token_hash = $1', [sha(t)]);
    return reply.header('set-cookie', clearCookie(secure)).send({ ok: true });
  });
  const me = (req: any): Promise<User | null> => userFromToken(pool, cookieToken(req.headers.cookie));
  /** Devolve o utilizador ou responde 401. */
  const need = async (req: any, reply: any): Promise<User | null> => { const u = await me(req); if (!u) { reply.code(401).send({ ok: false, error: 'sem_sessao' }); return null; } return u; };
  const needAdmin = async (req: any, reply: any): Promise<User | null> => { const u = await need(req, reply); if (!u) return null; if (u.role !== 'admin') { reply.code(403).send({ ok: false, error: 'sem_permissao' }); return null; } return u; };
  app.get('/auth/me', async (req, reply) => { const u = await need(req, reply); if (u) return { ok: true, user: { username: u.username, role: u.role, employeeId: u.employeeId } }; });

  // A própria pessoa muda a sua palavra-passe (confirma a atual; as outras sessões fecham)
  app.post('/auth/password', async (req, reply) => {
    const u = await need(req, reply); if (!u) return;
    const b = z.object({ current: z.string().min(1).max(200), password: z.string().min(10).max(200) }).parse(req.body);
    const fails = await pool.query("select count(*)::int n from login_failures where username = $1 and at > now() - make_interval(mins => $2)", [u.username, FAILURE_WINDOW_MIN]);
    if (fails.rows[0].n >= MAX_FAILURES) return reply.code(429).send({ ok: false, error: 'demasiadas_tentativas' });
    const row = (await pool.query('select password_hash from users where id = $1', [u.id])).rows[0];
    if (!(await verifyPassword(b.current, row.password_hash))) { await pool.query('insert into login_failures(username) values ($1)', [u.username]); return reply.code(403).send({ ok: false, error: 'palavra_passe_atual_errada' }); }
    await pool.query('update users set password_hash = $2 where id = $1', [u.id, await hashPassword(b.password)]);
    const t = cookieToken(req.headers.cookie); await pool.query('delete from sessions where user_id = $1 and token_hash <> $2', [u.id, t ? sha(t) : '']);
    return { ok: true };
  });

  // Contas (só o administrador cria barbeiros e repõe palavras-passe)
  app.post('/admin/users', async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    const b = z.object({ username: z.string().min(3).max(40).regex(/^[a-z0-9._-]+$/), password: z.string().min(10).max(200), role: z.enum(['admin', 'barber']), employeeId: z.string().optional() }).parse(req.body);
    if (b.role === 'barber' && !b.employeeId) return reply.code(422).send({ ok: false, error: 'barbeiro_precisa_de_colaborador' });
    try { const r = await pool.query('insert into users(username, password_hash, role, employee_id) values ($1,$2,$3,$4) returning id', [b.username, await hashPassword(b.password), b.role, b.role === 'barber' ? b.employeeId : null]); return { ok: true, id: Number(r.rows[0].id) }; }
    catch (e: any) { if (e.code === '23505') return reply.code(409).send({ ok: false, error: 'utilizador_ja_existe' }); if (e.code === '23503') return reply.code(422).send({ ok: false, error: 'colaborador_desconhecido' }); throw e; }
  });
  app.post('/admin/users/:id/password', async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    const b = z.object({ password: z.string().min(10).max(200) }).parse(req.body); const id = Number((req.params as any).id);
    const r = await pool.query('update users set password_hash = $2 where id = $1', [id, await hashPassword(b.password)]);
    if (!r.rowCount) return reply.code(404).send({ ok: false, error: 'nao_encontrado' });
    await pool.query('delete from sessions where user_id = $1', [id]); // fecha as sessões abertas
    return { ok: true };
  });
  app.post('/admin/users/:id/deactivate', async (req, reply) => {
    if (!(await needAdmin(req, reply))) return;
    const id = Number((req.params as any).id); const r = await pool.query('update users set active = false where id = $1', [id]);
    if (!r.rowCount) return reply.code(404).send({ ok: false, error: 'nao_encontrado' });
    await pool.query('delete from sessions where user_id = $1', [id]); return { ok: true };
  });

  registerAdmin(app, pool, needAdmin);

  // Catálogo público para o Booking: só ativos, tudo o que o HQ gere.
  app.get('/public/catalog', async () => {
    const [e, s, r] = await Promise.all([
      pool.query("select id, name, nickname, specialties from employees where active and available_online order by sort_order, id"),
      pool.query("select id, name, duration_min, price_cents, points_price from services where active order by sort_order, id"),
      loadRules(pool)]);
    const es = await pool.query('select employee_id, service_id, duration_min from employee_services where online_available and calendar_available');
    return { ok: true, rules: { maxWeeksAhead: r.maxWeeksAhead, holdMin: r.holdMin, cancelLeadMin: r.cancelLeadMin, gridMin: r.gridMin },
      employees: e.rows.map(x => ({ id: x.id, name: x.name, nickname: x.nickname, specialties: x.specialties })),
      services: s.rows.map(x => ({ id: x.id, name: x.name, durationMin: x.duration_min, priceCents: x.price_cents, pointsPrice: x.points_price })),
      offers: es.rows.map(x => ({ employeeId: x.employee_id, serviceId: x.service_id, durationMin: x.duration_min })) };
  });

  // ---------- HQ (protegido) ----------
  /** Barbeiro só mexe no que é seu; o admin em tudo. Marcação de outro barbeiro responde 404 (não revela que existe). */
  const owns = async (u: User, bookingId: string) => { if (u.role === 'admin') return true; const r = await pool.query('select 1 from bookings where id = $1 and employee_id = $2', [bookingId, u.employeeId]); return r.rowCount! > 0; };
  const forbidden = (reply: any) => reply.code(403).send({ ok: false, error: 'sem_permissao' });
  const notFound = (reply: any) => reply.code(404).send({ ok: false, error: 'nao_encontrada' });

  app.get('/hq/bookings', async (req, reply) => {
    const u = await need(req, reply); if (!u) return;
    const q = z.object({ date: date.optional(), from: date.optional(), to: date.optional(), employeeId: z.string().optional() }).parse(req.query);
    const from = q.from ?? q.date, to = q.to ?? q.date; if (!from || !to || from > to || addDays(from, 400) < to) return reply.code(400).send({ ok: false, error: 'pedido_invalido' });
    if (u.role === 'barber' && q.employeeId && q.employeeId !== u.employeeId) return forbidden(reply);
    const emp = u.role === 'barber' ? u.employeeId : q.employeeId ?? null;
    const r = await pool.query(`select b.id, b.employee_id, to_char(b.date,'YYYY-MM-DD') date, b.start_min, b.end_min, b.service_ids, b.source, b.status, b.notes, extract(epoch from b.created_at)*1000 created_ms,
        c.id customer_id, c.name customer_name, c.phone customer_phone, c.email customer_email, c.notes customer_notes, c.member_code, s.id sale_id
      from bookings b left join customers c on c.id = b.customer_id left join sales s on s.booking_id = b.id where b.date between $1 and $2 and ($3::text is null or b.employee_id = $3) order by b.date, b.start_min`, [from, to, emp]);
    return { ok: true, bookings: r.rows.map(x => ({ id: x.id, employeeId: x.employee_id, date: x.date, startMin: x.start_min, endMin: x.end_min, serviceIds: x.service_ids, source: x.source, status: x.status, notes: x.notes, createdAt: Number(x.created_ms), saleId: x.sale_id ? Number(x.sale_id) : null,
      customer: x.customer_id ? { id: Number(x.customer_id), name: x.customer_name, phone: x.customer_phone, email: x.customer_email ?? '', notes: x.customer_notes, memberCode: x.member_code } : null })) };
  });
  /** Tudo o que o ecrã do HQ precisa de conhecer (barbeiros, serviços, produtos, horário, regras), para qualquer utilizador com sessão. */
  app.get('/hq/catalog', async (req, reply) => {
    const u = await need(req, reply); if (!u) return;
    const [e, sv, pr, oh, es, pa] = await Promise.all([
      pool.query('select id, name, nickname, specialties, active, available_online, auto_assign, sort_order from employees order by sort_order, id'),
      pool.query('select id, name, duration_min, pause_min, price_cents, active, points_price from services order by sort_order, id'),
      pool.query('select id, name, price_cents, stock, active, points_price from products order by sort_order, id'),
      pool.query('select weekday, open_min, close_min from opening_hours order by weekday, open_min'),
      pool.query('select employee_id, service_id, online_available, calendar_available, duration_min from employee_services'),
      pool.query('select employee_id, weekday, start_min, end_min, label from employee_pauses order by weekday, start_min')]);
    return { ok: true, me: { username: u.username, role: u.role, employeeId: u.employeeId }, rules: await loadRules(pool),
      employees: e.rows.map(x => ({ id: x.id, name: x.name, nickname: x.nickname, specialties: x.specialties, active: x.active, availableOnline: x.available_online, autoAssign: x.auto_assign, order: x.sort_order })),
      services: sv.rows.map(x => ({ id: x.id, name: x.name, durationMin: x.duration_min, pauseMin: x.pause_min, priceCents: x.price_cents, active: x.active, pointsPrice: x.points_price })),
      products: pr.rows.map(x => ({ id: x.id, name: x.name, priceCents: x.price_cents, stock: x.stock, active: x.active, pointsPrice: x.points_price })),
      hours: oh.rows.map(x => ({ weekday: x.weekday, openMin: x.open_min, closeMin: x.close_min })),
      offers: es.rows.map(x => ({ employeeId: x.employee_id, serviceId: x.service_id, onlineAvailable: x.online_available, calendarAvailable: x.calendar_available, durationMin: x.duration_min })),
      pauses: pa.rows.filter(x => u.role === 'admin' || x.employee_id === u.employeeId).map(x => ({ employeeId: x.employee_id, weekday: x.weekday, startMin: x.start_min, endMin: x.end_min, label: x.label })) };
  });
  /** Bloqueios do período (barbeiro: só os seus). Servem para desenhar a agenda. */
  app.get('/hq/blocks', async (req, reply) => {
    const u = await need(req, reply); if (!u) return; const q = z.object({ from: date, to: date }).parse(req.query);
    const r = await pool.query("select id, employee_id, to_char(date,'YYYY-MM-DD') d, all_day, start_min, end_min, reason from blocks where date between $1 and $2 and ($3::text is null or employee_id = $3)", [q.from, q.to, u.role === 'barber' ? u.employeeId : null]);
    return { ok: true, blocks: r.rows.map(x => ({ id: x.id, employeeId: x.employee_id, date: x.d, allDay: x.all_day, startMin: x.start_min, endMin: x.end_min, reason: x.reason })) };
  });
  /** Atendimentos registados no período (para os dashboards agregados). Barbeiro: só os seus. */
  app.get('/hq/sales', async (req, reply) => {
    const u = await need(req, reply); if (!u) return; const q = z.object({ from: date, to: date }).parse(req.query);
    const r = await pool.query(`select s.id, s.booking_id, s.employee_id, coalesce(s.customer_id::text, 'b:' || s.booking_id) customer_id, to_char(s.date,'YYYY-MM-DD') d, s.payment,
        coalesce(json_agg(json_build_object('kind', i.kind, 'refId', i.ref_id, 'name', i.name, 'qty', i.qty, 'unitCents', i.unit_cents)) filter (where i.id is not null), '[]') items
      from sales s left join sale_items i on i.sale_id = s.id where s.date between $1 and $2 and ($3::text is null or s.employee_id = $3) group by s.id`, [q.from, q.to, u.role === 'barber' ? u.employeeId : null]);
    return { ok: true, sales: r.rows.map(x => ({ id: String(x.id), bookingId: x.booking_id, employeeId: x.employee_id, customerId: String(x.customer_id), date: x.d, items: x.items, payment: x.payment })) };
  });
  /** Atualiza os dados de um cliente (barbeiro: só clientes que já atendeu). */
  app.patch('/hq/customers/:id', async (req, reply) => {
    const u = await need(req, reply); if (!u) return; const cid = Number((req.params as any).id);
    const b = z.object({ name: z.string().trim().min(1).max(120).optional(), phone: z.string().trim().min(5).max(30).optional(), email: z.string().trim().max(160).optional(), notes: z.string().max(2000).optional() }).parse(req.body);
    if (u.role === 'barber') { const k = await pool.query('select 1 from bookings where customer_id = $1 and employee_id = $2 limit 1', [cid, u.employeeId]); if (!k.rowCount) return notFound(reply); }
    const r = await pool.query('update customers set name = coalesce($2, name), phone = coalesce($3, phone), email = case when $4::boolean then nullif($5, \'\') else email end, notes = coalesce($6, notes) where id = $1', [cid, b.name ?? null, b.phone ?? null, b.email !== undefined, b.email ?? null, b.notes ?? null]);
    if (!r.rowCount) return notFound(reply);
    await pool.query('insert into audit_log(actor, action, after) values ($1,$2,$3)', [u.username, 'cliente_editar', { id: cid, ...b }]); return { ok: true };
  });
  app.post('/hq/bookings', async (req, reply) => {
    const u = await need(req, reply); if (!u) return;
    const b = z.object({ customerId: z.number().int().optional(), customer: z.object({ name: z.string().trim().min(1).max(120), phone: z.string().trim().min(5).max(30), email: z.string().max(160).optional() }).optional(), notes: z.string().max(2000).optional(), employeeId: z.string(), date, startMin: min, endMin: min, serviceIds: services, confirmConflicts: z.boolean().optional(), notify: z.boolean() }).parse(req.body);
    if (u.role === 'barber') {
      if (b.employeeId !== u.employeeId) return forbidden(reply);
      if (b.customerId != null) { const k = await pool.query('select 1 from bookings where customer_id = $1 and employee_id = $2 limit 1', [b.customerId, u.employeeId]); if (!k.rowCount) return forbidden(reply); } // só clientes que já atendeu
    }
    const r = await svc.createHq({ ...b, actor: u.username, actorEmployeeId: u.employeeId, nowMs: clock() }); return reply.code(status(r)).send(r);
  });
  app.patch('/hq/bookings/:id', async (req, reply) => {
    const u = await need(req, reply); if (!u) return; const id = (req.params as any).id;
    const b = z.object({ employeeId: z.string().optional(), date: date.optional(), startMin: min.optional(), serviceIds: services.optional(), notes: z.string().max(2000).optional(), status: z.enum(['confirmed', 'cancelled', 'noshow']).optional(), confirmConflicts: z.boolean().optional(), notify: z.boolean() }).parse(req.body);
    if (!(await owns(u, id))) return notFound(reply);
    const { confirmConflicts, notify, ...patch } = b;
    const r = await svc.updateHq({ bookingId: id, actor: u.username, actorEmployeeId: u.employeeId, isAdmin: u.role === 'admin', patch, confirmConflicts, notify, nowMs: clock() });
    return reply.code(!r.ok && r.error === 'sem_permissao' ? 403 : status(r)).send(r);
  });
  app.delete('/hq/bookings/:id', async (req, reply) => {
    const u = await needAdmin(req, reply); if (!u) return; const id = (req.params as any).id;
    const c = await pool.connect();
    try {
      await c.query('begin');
      const r = await c.query('select 1 from bookings where id = $1 for update', [id]); if (!r.rowCount) { await c.query('rollback'); return notFound(reply); }
      if ((await c.query('select 1 from sales where booking_id = $1', [id])).rowCount) { await c.query('rollback'); return reply.code(409).send({ ok: false, error: 'tem_atendimento_registado' }); }
      await c.query('delete from bookings where id = $1', [id]);
      await c.query('insert into audit_log(actor, action, booking_id) values ($1,$2,$3)', [u.username, 'apagar', id]); await c.query('commit'); return { ok: true };
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  });
  app.post('/hq/bookings/:id/cancel', async (req, reply) => {
    const u = await need(req, reply); if (!u) return;
    const b = z.object({ notify: z.boolean() }).parse(req.body); const id = (req.params as any).id;
    if (!(await owns(u, id))) return notFound(reply);
    const r = await svc.cancel({ bookingId: id, by: 'staff', actor: u.username, actorEmployeeId: u.employeeId, notify: b.notify, nowMs: clock() }); return reply.code(status(r)).send(r);
  });
  app.post('/hq/bookings/:id/reschedule', async (req, reply) => {
    const u = await need(req, reply); if (!u) return;
    const b = z.object({ date, startMin: min, notify: z.boolean(), confirmConflicts: z.boolean().optional() }).parse(req.body); const id = (req.params as any).id;
    if (!(await owns(u, id))) return notFound(reply);
    const r = await svc.reschedule({ bookingId: id, by: 'staff', actor: u.username, actorEmployeeId: u.employeeId, ...b, nowMs: clock() }); return reply.code(status(r)).send(r);
  });

  // ---------- Avisos no telemóvel (Web Push) ----------
  app.get('/push/key', async (_req, reply) => (opts.vapidPublicKey ? { ok: true, key: opts.vapidPublicKey } : reply.code(503).send({ ok: false, error: 'push_nao_configurado' })));
  app.post('/push/subscribe', async (req, reply) => {
    const u = await need(req, reply); if (!u) return;
    const b = z.object({ endpoint: z.string().url().max(1000).refine(x => x.startsWith('https://')), keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(10).max(100) }) }).parse(req.body);
    // o mesmo dispositivo passa para o utilizador que está com sessão (ex.: telemóvel partilhado)
    await pool.query('insert into push_subscriptions(user_id, endpoint, p256dh, auth) values ($1,$2,$3,$4) on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth', [u.id, b.endpoint, b.keys.p256dh, b.keys.auth]);
    return { ok: true };
  });
  app.post('/push/unsubscribe', async (req, reply) => {
    const u = await need(req, reply); if (!u) return; const b = z.object({ endpoint: z.string() }).parse(req.body);
    await pool.query('delete from push_subscriptions where endpoint = $1 and user_id = $2', [b.endpoint, u.id]); return { ok: true };
  });

  // ---------- A minha disponibilidade: cada barbeiro abre/fecha o seu horário (o admin trata de qualquer um) ----------
  /** Barbeiro só gere o próprio calendário; o admin o de qualquer barbeiro (indicado em employeeId). */
  const target = (u: User, requested?: string) => (u.role === 'barber' ? (requested && requested !== u.employeeId ? null : u.employeeId) : requested ?? null);
  app.get('/hq/availability', async (req, reply) => {
    const u = await need(req, reply); if (!u) return;
    const q = z.object({ employeeId: z.string().optional(), from: date, to: date }).parse(req.query);
    const emp = target(u, q.employeeId); if (!emp) return u.role === 'barber' ? forbidden(reply) : reply.code(400).send({ ok: false, error: 'pedido_invalido' });
    const bl = await pool.query("select id, to_char(date,'YYYY-MM-DD') d, all_day, start_min, end_min, reason from blocks where employee_id = $1 and date between $2 and $3 order by date, start_min", [emp, q.from, q.to]);
    const pa = await pool.query('select id, weekday, start_min, end_min, label from employee_pauses where employee_id = $1 order by weekday, start_min', [emp]);
    return { ok: true, employeeId: emp, blocks: bl.rows.map(x => ({ id: x.id, date: x.d, allDay: x.all_day, startMin: x.start_min, endMin: x.end_min, reason: x.reason })), pauses: pa.rows.map(x => ({ id: Number(x.id), weekday: x.weekday, startMin: x.start_min, endMin: x.end_min, label: x.label })) };
  });
  app.post('/hq/blocks', async (req, reply) => {
    const u = await need(req, reply); if (!u) return;
    const b = z.object({ employeeId: z.string().optional(), date, allDay: z.boolean().optional(), startMin: min.optional(), endMin: min.optional(), reason: z.string().max(120).optional() }).parse(req.body);
    const emp = target(u, b.employeeId); if (!emp) return u.role === 'barber' ? forbidden(reply) : reply.code(400).send({ ok: false, error: 'pedido_invalido' });
    if (!b.allDay && (b.startMin == null || b.endMin == null || b.endMin <= b.startMin)) return reply.code(400).send({ ok: false, error: 'pedido_invalido' });
    const id = randomUUID();
    try { await pool.query('insert into blocks(id, employee_id, date, all_day, start_min, end_min, reason, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8)', [id, emp, b.date, !!b.allDay, b.allDay ? null : b.startMin, b.allDay ? null : b.endMin, b.reason ?? null, u.id]); }
    catch (e: any) { if (e.code === '23503') return reply.code(422).send({ ok: false, error: 'colaborador_desconhecido' }); throw e; }
    // Não cancela nada sozinho: avisa se já havia marcações nessa janela, para o barbeiro tratar delas.
    const hit = await pool.query("select count(*)::int n from bookings where employee_id = $1 and date = $2 and status = 'confirmed' and ($3::boolean or (start_min < $5 and $4 < end_min))", [emp, b.date, !!b.allDay, b.startMin ?? 0, b.endMin ?? 0]);
    await pool.query('insert into audit_log(actor, action, after) values ($1,$2,$3)', [u.username, 'bloqueio_criar', { id, employeeId: emp, ...b }]);
    return { ok: true, id, bookingsInside: hit.rows[0].n };
  });
  app.delete('/hq/blocks/:id', async (req, reply) => {
    const u = await need(req, reply); if (!u) return;
    const r = await pool.query('delete from blocks where id = $1 and ($2::text is null or employee_id = $2)', [(req.params as any).id, u.role === 'barber' ? u.employeeId : null]);
    if (!r.rowCount) return notFound(reply);
    await pool.query('insert into audit_log(actor, action, after) values ($1,$2,$3)', [u.username, 'bloqueio_apagar', { id: (req.params as any).id }]); return { ok: true };
  });
  /** Pausas que se repetem toda a semana (ex.: almoço 13:00–14:00 de segunda a sexta). Substitui o conjunto do barbeiro. */
  app.put('/hq/pauses', async (req, reply) => {
    const u = await need(req, reply); if (!u) return;
    const b = z.object({ employeeId: z.string().optional(), pauses: z.array(z.object({ weekday: z.number().int().min(0).max(6), startMin: min, endMin: min, label: z.string().max(60).optional() }).refine(p => p.endMin > p.startMin)).max(40) }).parse(req.body);
    const emp = target(u, b.employeeId); if (!emp) return u.role === 'barber' ? forbidden(reply) : reply.code(400).send({ ok: false, error: 'pedido_invalido' });
    const c = await pool.connect();
    try {
      await c.query('begin');
      if (!(await c.query('select 1 from employees where id = $1', [emp])).rowCount) { await c.query('rollback'); return reply.code(404).send({ ok: false, error: 'nao_encontrado' }); }
      await c.query('delete from employee_pauses where employee_id = $1', [emp]);
      for (const p of b.pauses) await c.query('insert into employee_pauses(employee_id, weekday, start_min, end_min, label) values ($1,$2,$3,$4,$5)', [emp, p.weekday, p.startMin, p.endMin, p.label ?? '']);
      await c.query('commit');
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
    await pool.query('insert into audit_log(actor, action, after) values ($1,$2,$3)', [u.username, 'pausas', { employeeId: emp, pauses: b.pauses }]); return { ok: true };
  });

  // Atendimento (venda) registado na app. Não processa pagamentos.
  app.post('/hq/bookings/:id/sale', async (req, reply) => {
    const u = await need(req, reply); if (!u) return;
    const b = z.object({ payment: z.enum(['dinheiro', 'cartao', 'mbway', 'outro']), items: z.array(z.object({ kind: z.enum(['service', 'product']), refId: z.string().min(1).max(60), name: z.string().min(1).max(120), qty: z.number().int().min(1).max(99), unitCents: z.number().int().min(0).max(1_000_000) })).min(1).max(20) }).parse(req.body);
    const id = (req.params as any).id; if (!(await owns(u, id))) return notFound(reply);
    const c = await pool.connect();
    try {
      await c.query('begin');
      const bk = (await c.query("select employee_id, customer_id, to_char(date,'YYYY-MM-DD') d, status from bookings where id = $1 for update", [id])).rows[0];
      if (!bk || bk.status !== 'confirmed') { await c.query('rollback'); return reply.code(422).send({ ok: false, error: 'marcacao_nao_confirmada' }); }
      if ((await c.query('select 1 from sales where booking_id = $1', [id])).rowCount) { await c.query('rollback'); return reply.code(409).send({ ok: false, error: 'ja_registado' }); }
      const s = await c.query('insert into sales(booking_id, employee_id, customer_id, date, payment, created_by) values ($1,$2,$3,$4,$5,$6) returning id', [id, bk.employee_id, bk.customer_id, bk.d, b.payment, u.id]);
      for (const i of b.items) await c.query('insert into sale_items(sale_id, kind, ref_id, name, qty, unit_cents) values ($1,$2,$3,$4,$5,$6)', [s.rows[0].id, i.kind, i.refId, i.name, i.qty, i.unitCents]);
      await c.query('commit'); return { ok: true, saleId: Number(s.rows[0].id) };
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  });

  // Dashboards: só números agregados, nunca nomes nem dados de clientes.
  app.get('/hq/dashboard', async (req, reply) => {
    const u = await need(req, reply); if (!u) return;
    const q = z.object({ from: date, to: date, employeeId: z.string().optional() }).parse(req.query);
    if (q.from > q.to) return reply.code(400).send({ ok: false, error: 'pedido_invalido' });
    if (u.role === 'barber' && q.employeeId && q.employeeId !== u.employeeId) return forbidden(reply);
    const who = u.role === 'barber' ? u.employeeId! : q.employeeId; // undefined = loja toda (admin)
    const prev = periodBefore(q.from, q.to); const from = prev.from, to = q.to;
    const bk = await pool.query("select id, employee_id, to_char(date,'YYYY-MM-DD') d, start_min, end_min, status from bookings where date between $1 and $2", [from, to]);
    const sl = await pool.query(`select s.id, s.booking_id, s.employee_id, coalesce(s.customer_id::text, 'b:' || s.booking_id) customer_id, to_char(s.date,'YYYY-MM-DD') d, s.payment,
        coalesce(json_agg(json_build_object('kind', i.kind, 'refId', i.ref_id, 'name', i.name, 'qty', i.qty, 'unitCents', i.unit_cents)) filter (where i.id is not null), '[]') items
      from sales s left join sale_items i on i.sale_id = s.id where s.date <= $1 group by s.id`, [to]);
    const oh = await pool.query('select weekday, open_min, close_min from opening_hours');
    const emps = (await pool.query('select id from employees order by id')).rows.map(r => r.id as string);
    const bookings = bk.rows.map(r => ({ id: r.id, employeeId: r.employee_id, date: r.d, startMin: r.start_min, endMin: r.end_min, status: r.status }));
    const sales: Sale[] = sl.rows.map(r => ({ id: String(r.id), bookingId: r.booking_id, employeeId: r.employee_id, customerId: String(r.customer_id), date: r.d, items: r.items, payment: r.payment }));
    const mins = (a: string, b: string) => { let t = 0; for (let d = a; d <= b; d = addDays(d, 1)) for (const h of oh.rows.filter(h => h.weekday === weekday(d))) t += h.close_min - h.open_min; return t; }; // PRESSUPOSTO: sem descontar bloqueios
    const mk = (a: string, b: string) => { const base = { from: a, to: b, bookings, sales, availableMinutes: mins(a, b) }; return who ? { total: barberMetrics({ ...base, employeeId: who }) } : shopMetrics(base, emps); };
    return { ok: true, scope: who ?? 'loja', period: { from: q.from, to: q.to }, current: mk(q.from, q.to), previous: mk(prev.from, prev.to), revenueByDay: revenueByDay(sales, who ? [who] : null, q.from, q.to) };
  });
  if (opts.publicDir) registerStatic(app, opts.publicDir);
  return app;
}
