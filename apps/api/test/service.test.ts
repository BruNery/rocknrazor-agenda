import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { localToEpochMs } from '@rr/domain';
import { BookingService, FakeNotifier } from '../src/service';
import { freshDb } from './helpers';

const D = '2026-10-14'; const NOW = localToEpochMs(D, 8 * 60);
const cust = { name: 'EL TESTE', phone: '910000000' };
let pool: Awaited<ReturnType<typeof freshDb>>, svc: BookingService, n: FakeNotifier;
beforeEach(async () => { pool = await freshDb(); n = new FakeNotifier(); svc = new BookingService(pool, n); });
afterAll(async () => { await pool?.end(); });

describe('concorrência', () => {
  it('20 pedidos simultâneos ao mesmo horário: só um ganha', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => svc.createOnline({ customer: { name: `c${i}`, phone: '9' + i }, date: D, startMin: 600, serviceIds: ['corte'], employeeId: 'a', nowMs: NOW })));
    expect(rs.filter(r => r.ok)).toHaveLength(1);
    expect(rs.filter(r => !r.ok && r.error === 'indisponivel')).toHaveLength(19);
    const { rows } = await pool.query("select count(*)::int n from bookings where status='confirmed'");
    expect(rows[0].n).toBe(1);
  });
  it('"qualquer colaborador": 2 pedidos ao mesmo horário ficam com colaboradores diferentes, o 3.º falha', async () => {
    const rs = await Promise.all([1, 2, 3].map(i => svc.createOnline({ customer: { name: `c${i}`, phone: `9${i}` }, date: D, startMin: 600, serviceIds: ['corte'], nowMs: NOW })));
    expect(rs.filter(r => r.ok)).toHaveLength(2);
    expect(new Set(rs.filter(r => r.ok).map(r => (r as any).employeeId)).size).toBe(2);
  });
});

describe('reserva temporária', () => {
  it('hold bloqueia outros durante 5 min e é consumida pela marcação do próprio', async () => {
    const h = await svc.hold({ date: D, startMin: 600, serviceIds: ['corte'], employeeId: 'a', nowMs: NOW });
    expect(h.ok).toBe(true);
    const other = await svc.createOnline({ customer: cust, date: D, startMin: 600, serviceIds: ['corte'], employeeId: 'a', nowMs: NOW + 60_000 });
    expect(other.ok).toBe(false);
    const mine = await svc.createOnline({ customer: cust, date: D, startMin: 600, serviceIds: ['corte'], employeeId: 'a', holdId: (h as any).holdId, nowMs: NOW + 60_000 });
    expect(mine.ok).toBe(true);
  });
  it('depois de 5 min o hold expira e o horário volta a estar livre', async () => {
    await svc.hold({ date: D, startMin: 600, serviceIds: ['corte'], employeeId: 'a', nowMs: NOW });
    const r = await svc.createOnline({ customer: cust, date: D, startMin: 600, serviceIds: ['corte'], employeeId: 'a', nowMs: NOW + 5 * 60_000 + 1 });
    expect(r.ok).toBe(true);
  });
});

describe('regras de reserva', () => {
  it('nome e telefone obrigatórios', async () => {
    expect((await svc.createOnline({ customer: { name: '', phone: '' }, date: D, startMin: 600, serviceIds: ['corte'], employeeId: 'a', nowMs: NOW })).ok).toBe(false);
  });
  it('última marcação 1 h antes', async () => {
    const r = await svc.createOnline({ customer: cust, date: D, startMin: 540, serviceIds: ['corte'], employeeId: 'a', nowMs: localToEpochMs(D, 9 * 60) });
    expect(r).toMatchObject({ ok: false, error: 'indisponivel' });
  });
});

describe('HQ: conflitos, cancelar e reagendar com auditoria e notificação opcional', () => {
  it('HQ pede confirmação em conflito e permite sobrepor depois de confirmar', async () => {
    await svc.createHq({ actor: 'bruno', employeeId: 'a', date: D, startMin: 600, endMin: 640, serviceIds: ['corte'], notify: false, nowMs: NOW });
    const c1 = await svc.createHq({ actor: 'bruno', employeeId: 'a', date: D, startMin: 620, endMin: 660, serviceIds: ['corte'], notify: false, nowMs: NOW });
    expect(c1).toMatchObject({ ok: false, error: 'conflito' });
    const c2 = await svc.createHq({ actor: 'bruno', employeeId: 'a', date: D, startMin: 620, endMin: 660, serviceIds: ['corte'], confirmConflicts: true, notify: false, nowMs: NOW });
    expect(c2.ok).toBe(true);
    const a = await pool.query("select action from audit_log order by id");
    expect(a.rows.map(r => r.action)).toEqual(['criar', 'criar_com_conflito']);
  });
  it('cliente reagenda só para horários que a reserva online permitiria (1 h de antecedência)', async () => {
    const b = await svc.createOnline({ customer: cust, date: D, startMin: 14 * 60, serviceIds: ['corte'], employeeId: 'a', nowMs: NOW }) as any;
    const now = localToEpochMs(D, 9 * 60 + 30); // 09:30 => antes das 10:30 já não se pode reservar
    expect(await svc.reschedule({ bookingId: b.bookingId, by: 'customer', actor: 'c', date: D, startMin: 600, notify: false, nowMs: now })).toMatchObject({ error: 'indisponivel' });
    expect((await svc.reschedule({ bookingId: b.bookingId, by: 'customer', actor: 'c', date: D, startMin: 660, notify: false, nowMs: now })).ok).toBe(true);
  });
  it('cliente só cancela até 3 h antes; staff sempre; notificação só se pedida', async () => {
    const b = await svc.createOnline({ customer: cust, date: D, startMin: 14 * 60, serviceIds: ['corte'], employeeId: 'a', nowMs: NOW }) as any;
    n.sent = [];
    expect(await svc.cancel({ bookingId: b.bookingId, by: 'customer', actor: 'cliente', notify: true, nowMs: localToEpochMs(D, 11 * 60 + 1) })).toMatchObject({ ok: false, error: 'fora_do_prazo' });
    expect((await svc.cancel({ bookingId: b.bookingId, by: 'staff', actor: 'bruno', notify: false, nowMs: localToEpochMs(D, 13 * 60) })).ok).toBe(true);
    expect(n.sent).toEqual([]);
    expect(await svc.cancel({ bookingId: b.bookingId, by: 'staff', actor: 'bruno', notify: false, nowMs: NOW })).toMatchObject({ error: 'ja_cancelada' });
  });
  it('reagendar: cliente nunca sobrepõe; histórico regista de/para; horário antigo fica livre', async () => {
    const b1 = await svc.createOnline({ customer: cust, date: D, startMin: 840, serviceIds: ['corte'], employeeId: 'a', nowMs: NOW }) as any;
    await svc.createOnline({ customer: cust, date: D, startMin: 940, serviceIds: ['corte'], employeeId: 'a', nowMs: NOW });
    expect(await svc.reschedule({ bookingId: b1.bookingId, by: 'customer', actor: 'c', date: D, startMin: 930, notify: false, nowMs: NOW })).toMatchObject({ error: 'conflito' });
    expect((await svc.reschedule({ bookingId: b1.bookingId, by: 'customer', actor: 'c', date: D, startMin: 1040, notify: true, nowMs: NOW })).ok).toBe(true);
    const av = await svc.availability(D, ['corte'], 'a', NOW);
    expect(av.map(s => s.startMin)).toContain(840);
    expect(av.map(s => s.startMin)).not.toContain(1040);
    const { rows } = await pool.query("select before, after from audit_log where action='reagendar'");
    expect(rows[0]).toEqual({ before: { date: D, startMin: 840 }, after: { date: D, startMin: 1040 } });
    expect(n.sent.at(-1)).toMatchObject({ kind: 'rescheduled' });
  });
});
