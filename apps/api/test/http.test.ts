import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { localToEpochMs } from '@rr/domain';
import { buildApp } from '../src/app';
import { FakeNotifier } from '../src/service';
import { freshDb } from './helpers';

const D = '2026-10-14'; const NOW = localToEpochMs(D, 8 * 60);
let pool: Awaited<ReturnType<typeof freshDb>>, app: ReturnType<typeof buildApp>;
beforeEach(async () => { pool = await freshDb(); app = buildApp(pool, new FakeNotifier(), () => NOW); });
afterAll(async () => { await pool?.end(); });

describe('API HTTP', () => {
  it('fluxo público: disponibilidade -> hold (fora de prazo recusado) -> hold -> reserva', async () => {
    const av = await app.inject({ url: `/public/availability?date=${D}&services=corte&employeeId=a` });
    expect(av.json().slots.length).toBeGreaterThan(0);
    const hold = await app.inject({ method: 'POST', url: '/public/holds', payload: { date: '2026-12-31', startMin: 600, serviceIds: ['corte'], employeeId: 'a' } });
    expect(hold.statusCode).toBe(409); // fora das 8 semanas
    const h2 = await app.inject({ method: 'POST', url: '/public/holds', payload: { date: D, startMin: 840, serviceIds: ['corte'], employeeId: 'a' } });
    expect(h2.statusCode).toBe(200);
    const bk = await app.inject({ method: 'POST', url: '/public/bookings', payload: { customer: { name: 'X', phone: '9' }, date: D, startMin: 840, serviceIds: ['corte'], employeeId: 'a', holdId: h2.json().holdId } });
    expect(bk.statusCode).toBe(200);
  });
  it('validação: pedido inválido dá 400; nome/telefone vazios dão 422', async () => {
    expect((await app.inject({ method: 'POST', url: '/public/bookings', payload: { date: 'ontem' } })).statusCode).toBe(400);
    const r = await app.inject({ method: 'POST', url: '/public/bookings', payload: { customer: { name: '', phone: '' }, date: D, startMin: 840, serviceIds: ['corte'], employeeId: 'a' } });
    expect(r.statusCode).toBe(422);
  });
  it('HQ: conflito devolve 409 com a lista; confirmar cria; cancelar sem notificar', async () => {
    const mk = (extra = {}) => app.inject({ method: 'POST', url: '/hq/bookings', headers: { 'x-dev-user': 'bruno' }, payload: { employeeId: 'a', date: D, startMin: 600, endMin: 640, serviceIds: ['corte'], notify: false, ...extra } });
    const first = await mk(); expect(first.statusCode).toBe(200);
    const clash = await mk({ startMin: 620, endMin: 660 }); expect(clash.statusCode).toBe(409); expect(clash.json().conflicts[0].kind).toBe('overlap');
    const ok = await mk({ startMin: 620, endMin: 660, confirmConflicts: true }); expect(ok.statusCode).toBe(200);
    const cancel = await app.inject({ method: 'POST', url: `/hq/bookings/${first.json().bookingId}/cancel`, payload: { notify: false } });
    expect(cancel.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/hq/bookings/inexistente/cancel', payload: { notify: false } })).statusCode).toBe(404);
  });
});
