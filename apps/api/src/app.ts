import Fastify from 'fastify';
import { z } from 'zod';
import type { Pool } from 'pg';
import { BookingService, type Notifier } from './service';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const min = z.number().int().min(0).max(1440);
const services = z.array(z.string().min(1)).min(1);

export function buildApp(pool: Pool, notifier: Notifier, clock: () => number = Date.now) {
  const app = Fastify();
  const svc = new BookingService(pool, notifier);
  const status = (r: { ok: boolean; error?: string }) => (r.ok ? 200 : r.error === 'nao_encontrada' ? 404 : r.error === 'indisponivel' || r.error === 'conflito' || r.error === 'ja_cancelada' ? 409 : 422);

  app.setErrorHandler((err: any, _req, reply) => reply.code(err.name === 'ZodError' ? 400 : 500).send({ ok: false, error: err.name === 'ZodError' ? 'pedido_invalido' : 'erro_interno', detalhe: err.name === 'ZodError' ? err.issues : undefined }));

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

  // HQ (autenticação ainda por implementar no marco 3: actor vem de um cabeçalho de desenvolvimento)
  const actor = (req: any) => String(req.headers['x-dev-user'] ?? 'dev');
  app.post('/hq/bookings', async (req, reply) => {
    const b = z.object({ customerId: z.number().int().optional(), employeeId: z.string(), date, startMin: min, endMin: min, serviceIds: services, confirmConflicts: z.boolean().optional(), notify: z.boolean() }).parse(req.body);
    const r = await svc.createHq({ ...b, actor: actor(req), nowMs: clock() }); return reply.code(status(r)).send(r);
  });
  app.post('/hq/bookings/:id/cancel', async (req, reply) => {
    const b = z.object({ notify: z.boolean() }).parse(req.body);
    const r = await svc.cancel({ bookingId: (req.params as any).id, by: 'staff', actor: actor(req), notify: b.notify, nowMs: clock() }); return reply.code(status(r)).send(r);
  });
  app.post('/hq/bookings/:id/reschedule', async (req, reply) => {
    const b = z.object({ date, startMin: min, notify: z.boolean(), confirmConflicts: z.boolean().optional() }).parse(req.body);
    const r = await svc.reschedule({ bookingId: (req.params as any).id, by: 'staff', actor: actor(req), ...b, nowMs: clock() }); return reply.code(status(r)).send(r);
  });
  return app;
}
