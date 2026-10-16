import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from 'pg';
import { BookingService, upsertCustomerEx, ensureMemberCode } from './service';
import { hashPassword, verifyPassword, DUMMY_HASH, sha, MAX_FAILURES, FAILURE_WINDOW_MIN } from './auth';

const COOKIE = 'rr_client', DAYS = 90;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const digits9 = (s: string) => s.replace(/\D/g, '').slice(-9);
const normCode = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '');
const tokenOf = (h: string | undefined) => h?.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
const setCookie = (t: string, secure: boolean) => `${COOKIE}=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DAYS * 86400}${secure ? '; Secure' : ''}`;
const clearCookie = (secure: boolean) => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
const phoneSchema = z.string().trim().max(40).refine(p => p.replace(/\D/g, '').length >= 9, 'telefone');
const pwSchema = z.string().min(8).max(200);

export interface ClientMe { id: number; name: string; phone: string; email: string; memberCode: string | null }

/** Contas dos clientes: telemóvel + palavra-passe. Clientes que já existem no HQ reclamam a conta com o ID de membro (sem verificação do telemóvel ainda, para ninguém ficar com o histórico de outra pessoa). */
export function registerClient(app: FastifyInstance, pool: Pool, svc: BookingService, clock: () => number, secure: boolean) {
  const me = async (req: FastifyRequest): Promise<ClientMe | null> => {
    const t = tokenOf(req.headers.cookie); if (!t) return null;
    const r = await pool.query(`select c.id, c.name, c.phone, c.email, c.member_code from client_sessions s join customers c on c.id = s.customer_id join client_accounts a on a.customer_id = c.id where s.token_hash = $1 and s.expires_at > now()`, [sha(t)]);
    const x = r.rows[0]; return x ? { id: Number(x.id), name: x.name, phone: x.phone, email: x.email ?? '', memberCode: x.member_code } : null;
  };
  const need = async (req: FastifyRequest, reply: FastifyReply) => { const u = await me(req); if (!u) { reply.code(401).send({ ok: false, error: 'sem_sessao' }); return null; } return u; };
  const open = async (customerId: number, reply: FastifyReply) => {
    const t = randomBytes(32).toString('base64url');
    await pool.query("insert into client_sessions(token_hash, customer_id, expires_at) values ($1,$2, now() + make_interval(days => $3))", [sha(t), customerId, DAYS]);
    await pool.query('delete from client_sessions where expires_at < now()');
    reply.header('set-cookie', setCookie(t, secure));
  };
  const balance = async (id: number) => (await pool.query('select coalesce(sum(delta),0)::int n from points_ledger where customer_id = $1', [id])).rows[0].n as number;
  const payload = async (u: ClientMe) => ({ id: u.id, name: u.name, phone: u.phone, email: u.email, memberCode: u.memberCode, points: await balance(u.id) });
  const tooMany = async (key: string) => (await pool.query("select count(*)::int n from login_failures where username = $1 and at > now() - make_interval(mins => $2)", [key, FAILURE_WINDOW_MIN])).rows[0].n >= MAX_FAILURES;
  const owns = async (u: ClientMe, id: string) => (await pool.query('select 1 from bookings where id = $1 and customer_id = $2', [id, u.id])).rowCount! > 0;

  app.post('/client/register', async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(2).max(120), phone: phoneSchema, email: z.string().trim().max(120).optional(), password: pwSchema, memberCode: z.string().max(30).optional(), consent: z.literal(true) }).parse(req.body);
    const key = `c:${digits9(b.phone)}`; if (await tooMany(key)) return reply.code(429).send({ ok: false, error: 'demasiadas_tentativas' });
    const hash = await hashPassword(b.password);
    const c = await pool.connect(); let id = 0;
    try {
      await c.query('begin');
      const found = await c.query("select c.id, c.member_code, (a.customer_id is not null) has_acc from customers c left join client_accounts a on a.customer_id = c.id where right(regexp_replace(c.phone, '\\D', '', 'g'), 9) = $1 order by (a.customer_id is not null) desc, c.id limit 1 for update of c", [digits9(b.phone)]);
      if (found.rowCount) {
        const f = found.rows[0];
        if (f.has_acc) { await c.query('rollback'); return reply.code(409).send({ ok: false, error: 'conta_existe' }); }
        if (!f.member_code) { await c.query('rollback'); return reply.code(422).send({ ok: false, error: 'contactar_barbearia' }); }
        if (!b.memberCode || normCode(b.memberCode) !== normCode(f.member_code)) { await c.query('rollback'); await pool.query('insert into login_failures(username) values ($1)', [key]); return reply.code(422).send({ ok: false, error: b.memberCode ? 'codigo_errado' : 'codigo_necessario' }); }
        id = Number(f.id);
        if (b.email) await c.query('update customers set email = coalesce(nullif(email, \'\'), $2) where id = $1', [id, b.email]);
      } else {
        const r = await upsertCustomerEx(c, { name: b.name, phone: b.phone, email: b.email }); id = r.id; await ensureMemberCode(c, id);
      }
      await c.query('insert into client_accounts(customer_id, password_hash) values ($1,$2)', [id, hash]);
      await c.query('commit');
    } catch (e: any) { await c.query('rollback'); if (e.code === '23505') return reply.code(409).send({ ok: false, error: 'conta_existe' }); throw e; } finally { c.release(); }
    await open(id, reply); const u = (await pool.query('select id, name, phone, email, member_code from customers where id = $1', [id])).rows[0];
    return reply.send({ ok: true, me: await payload({ id, name: u.name, phone: u.phone, email: u.email ?? '', memberCode: u.member_code }) });
  });

  app.post('/client/login', async (req, reply) => {
    const b = z.object({ phone: phoneSchema, password: z.string().min(1).max(200) }).parse(req.body);
    const key = `c:${digits9(b.phone)}`; if (await tooMany(key)) return reply.code(429).send({ ok: false, error: 'demasiadas_tentativas' });
    const r = await pool.query("select c.id, c.name, c.phone, c.email, c.member_code, a.password_hash from customers c join client_accounts a on a.customer_id = c.id where right(regexp_replace(c.phone, '\\D', '', 'g'), 9) = $1 limit 1", [digits9(b.phone)]);
    const x = r.rows[0]; const good = await verifyPassword(b.password, x?.password_hash ?? DUMMY_HASH);
    if (!x || !good) { await pool.query('insert into login_failures(username) values ($1)', [key]); return reply.code(401).send({ ok: false, error: 'credenciais_invalidas' }); }
    await pool.query('delete from login_failures where username = $1', [key]); await open(Number(x.id), reply);
    return reply.send({ ok: true, me: await payload({ id: Number(x.id), name: x.name, phone: x.phone, email: x.email ?? '', memberCode: x.member_code }) });
  });

  app.post('/client/logout', async (req, reply) => {
    const t = tokenOf(req.headers.cookie); if (t) await pool.query('delete from client_sessions where token_hash = $1', [sha(t)]);
    return reply.header('set-cookie', clearCookie(secure)).send({ ok: true });
  });
  app.get('/client/me', async (req, reply) => { const u = await need(req, reply); if (!u) return; return reply.header('cache-control', 'no-store').send({ ok: true, me: await payload(u) }); });
  app.get('/client/points', async (req, reply) => {
    const u = await need(req, reply); if (!u) return;
    const l = await pool.query('select delta, kind, note, created_at from points_ledger where customer_id = $1 order by id desc limit 50', [u.id]);
    return reply.header('cache-control', 'no-store').send({ ok: true, balance: await balance(u.id), history: l.rows.map(x => ({ delta: x.delta, kind: x.kind, note: x.note, at: x.created_at })) });
  });
  app.patch('/client/me', async (req, reply) => {
    const u = await need(req, reply); if (!u) return;
    const b = z.object({ name: z.string().trim().min(2).max(120), email: z.string().trim().max(120).optional() }).parse(req.body);
    await pool.query('update customers set name = $2, email = $3 where id = $1', [u.id, b.name, b.email || null]);
    return reply.send({ ok: true, me: await payload({ ...u, name: b.name, email: b.email ?? '' }) });
  });
  app.post('/client/password', async (req, reply) => {
    const u = await need(req, reply); if (!u) return; const key = `c:${digits9(u.phone)}`;
    if (await tooMany(key)) return reply.code(429).send({ ok: false, error: 'demasiadas_tentativas' });
    const b = z.object({ current: z.string().min(1).max(200), next: pwSchema }).parse(req.body);
    const row = (await pool.query('select password_hash from client_accounts where customer_id = $1', [u.id])).rows[0];
    if (!(await verifyPassword(b.current, row.password_hash))) { await pool.query('insert into login_failures(username) values ($1)', [key]); return reply.code(403).send({ ok: false, error: 'palavra_passe_atual_errada' }); }
    await pool.query('update client_accounts set password_hash = $2 where customer_id = $1', [u.id, await hashPassword(b.next)]);
    const keep = tokenOf(req.headers.cookie); await pool.query('delete from client_sessions where customer_id = $1 and token_hash <> $2', [u.id, sha(keep ?? '')]);
    return reply.send({ ok: true });
  });

  app.get('/client/bookings', async (req, reply) => {
    const u = await need(req, reply); if (!u) return;
    const ids = (await pool.query("select id from bookings where customer_id = $1 order by date desc, start_min desc limit 60", [u.id])).rows.map(r => r.id as string);
    const list = (await Promise.all(ids.map(id => svc.publicBooking(id, clock())))).filter(Boolean);
    return reply.header('cache-control', 'no-store').send({ ok: true, bookings: list });
  });
  app.get('/client/bookings/:id', async (req, reply) => {
    const u = await need(req, reply); if (!u) return; const id = (req.params as any).id as string;
    if (!(await owns(u, id))) return reply.code(404).send({ ok: false, error: 'nao_encontrada' });
    return reply.header('cache-control', 'no-store').send({ ok: true, booking: await svc.publicBooking(id, clock()) });
  });
  app.post('/client/bookings', async (req, reply) => {
    const u = await need(req, reply); if (!u) return;
    const b = z.object({ date, startMin: z.number().int().min(0).max(1440), serviceIds: z.array(z.string().min(1)).min(1), employeeId: z.string().optional(), holdId: z.string().optional() }).parse(req.body);
    const r = await svc.createOnline({ ...b, customer: { name: u.name, phone: u.phone, email: u.email || undefined }, nowMs: clock() });
    return reply.code(r.ok ? 200 : r.error === 'indisponivel' || r.error === 'conflito' ? 409 : 422).header('cache-control', 'no-store').send(r);
  });
  app.post('/client/bookings/:id/cancel', async (req, reply) => {
    const u = await need(req, reply); if (!u) return; const id = (req.params as any).id as string;
    if (!(await owns(u, id))) return reply.code(404).send({ ok: false, error: 'nao_encontrada' });
    const r = await svc.cancel({ bookingId: id, by: 'customer', actor: 'cliente', notify: true, nowMs: clock() });
    return reply.code(r.ok ? 200 : r.error === 'ja_cancelada' ? 409 : 422).send(r);
  });
  app.post('/client/bookings/:id/reschedule', async (req, reply) => {
    const u = await need(req, reply); if (!u) return; const id = (req.params as any).id as string;
    if (!(await owns(u, id))) return reply.code(404).send({ ok: false, error: 'nao_encontrada' });
    const b = z.object({ date, startMin: z.number().int().min(0).max(1440) }).parse(req.body);
    const r = await svc.reschedule({ bookingId: id, by: 'customer', actor: 'cliente', ...b, notify: true, nowMs: clock() });
    return reply.code(r.ok ? 200 : r.error === 'indisponivel' || r.error === 'conflito' ? 409 : 422).send(r);
  });
}
