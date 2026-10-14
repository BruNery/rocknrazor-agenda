import { describe, it, expect } from 'vitest';
import { barberMetrics, shopMetrics, revenueByDay, periodBefore, type Sale, type Booking } from '../src';

const svc = (cents: number, name = 'Corte Premium', id = 'corte') => ({ kind: 'service' as const, refId: id, name, qty: 1, unitCents: cents });
const prod = (cents: number, qty = 1, name = 'Pomada', id = 'pomada') => ({ kind: 'product' as const, refId: id, name, qty, unitCents: cents });
const sale = (id: string, emp: string, cust: string, date: string, items: Sale['items']): Sale => ({ id, employeeId: emp, customerId: cust, date, items, payment: 'cartao' });
const bk = (id: string, emp: string, date: string, status: Booking['status'] = 'confirmed', s = 600, e = 640): Booking => ({ id, employeeId: emp, date, startMin: s, endMin: e, status });

const sales: Sale[] = [
  sale('1', 'a', 'c1', '2026-10-01', [svc(1700)]),
  sale('2', 'a', 'c1', '2026-10-08', [svc(1700), prod(1500)]),
  sale('3', 'a', 'c1', '2026-10-13', [svc(1700), prod(1500, 2)]),
  sale('4', 'a', 'c2', '2026-10-13', [svc(2500, "Trim n' Shave", 'trim')]),
  sale('5', 'b', 'c3', '2026-10-12', [svc(1700)]),
  sale('6', 'a', 'c9', '2026-08-01', [svc(1700)]), // antes do intervalo
];
const bookings: Booking[] = [bk('b1', 'a', '2026-10-01'), bk('b2', 'a', '2026-10-08'), bk('b3', 'a', '2026-10-13'), bk('b4', 'a', '2026-10-13', 'noshow'), bk('b5', 'a', '2026-10-14', 'cancelled'), bk('b6', 'b', '2026-10-12')];
const base = { from: '2026-10-01', to: '2026-10-14', bookings, sales };

describe('indicadores do barbeiro', () => {
  const m = barberMetrics({ ...base, employeeId: 'a', availableMinutes: 1000 });
  it('receita separada em serviços e produtos (cêntimos)', () => {
    expect(m.revenueServicesCents).toBe(1700 * 3 + 2500);
    expect(m.revenueProductsCents).toBe(1500 + 3000);
    expect(m.revenueCents).toBe(12100);
  });
  it('ticket médio = receita total / nº de vendas', () => { expect(m.avgTicketCents).toBe(Math.round(12100 / 4)); });
  it('produtos: unidades e taxa de venda de produto por atendimento', () => {
    expect(m.productUnits).toBe(3); expect(m.salesWithProduct).toBe(2); expect(m.productAttachRate).toBe(0.5);
  });
  it('marcações, não compareceu e cancelamentos', () => {
    expect(m.bookings).toBe(5); expect(m.noShows).toBe(1); expect(m.cancelled).toBe(1); expect(m.noShowRate).toBeCloseTo(0.2);
  });
  it('clientes únicos, fixos (≥3 visitas em 90 dias) e novos no intervalo', () => {
    expect(m.uniqueCustomers).toBe(2); expect(m.regularCustomers).toBe(1); expect(m.newCustomers).toBe(2);
  });
  it('taxa de retorno: c1 e c2 já tinham vindo antes? só quem comprou antes do intervalo', () => {
    const r = barberMetrics({ ...base, from: '2026-10-08', employeeId: 'a' });
    expect(r.uniqueCustomers).toBe(2); expect(r.returnRate).toBe(0.5); // c1 voltou, c2 é novo
  });
  it('ocupação limita-se a 100% e ignora canceladas', () => {
    expect(m.occupancy).toBeCloseTo((40 * 4) / 1000); // b1,b2,b3,b4 (noshow conta como ocupado), b5 cancelada fora
    expect(barberMetrics({ ...base, employeeId: 'a', availableMinutes: 10 }).occupancy).toBe(1);
  });
  it('top serviços e produtos por receita; atendimentos por dia da semana', () => {
    expect(m.topServices[0]).toMatchObject({ id: 'corte', qty: 3, cents: 5100 }); expect(m.topProducts[0]).toMatchObject({ id: 'pomada', qty: 3, cents: 4500 });
    expect(m.byWeekday.reduce((a, b) => a + b, 0)).toBe(4);
  });
  it('sem vendas: tudo a zero, sem divisões por zero', () => {
    const z = barberMetrics({ ...base, employeeId: 'ninguem' });
    expect(z).toMatchObject({ revenueCents: 0, avgTicketCents: 0, noShowRate: 0, productAttachRate: 0, returnRate: 0, occupancy: null });
  });
  it('só conta vendas do próprio barbeiro', () => { expect(barberMetrics({ ...base, employeeId: 'b' }).revenueCents).toBe(1700); });
});

describe('visão do administrador', () => {
  const s = shopMetrics(base, ['a', 'b']);
  it('total da loja = soma dos barbeiros; ranking e quota', () => {
    expect(s.total.revenueCents).toBe(12100 + 1700);
    expect(s.ranking.map(r => r.employeeId)).toEqual(['a', 'b']);
    expect(s.ranking.reduce((t, r) => t + r.share, 0)).toBeCloseTo(1);
    expect(s.total.avgTicketCents).toBe(Math.round(13800 / 5));
    expect(s.total.topProducts[0].qty).toBe(3);
  });
});

describe('loja: clientes sem duplicar, receita por dia, período anterior, privacidade', () => {
  it('cliente que foi a 2 barbeiros conta uma vez e pode ser fixo ao nível da loja', () => {
    const ss = [sale('1', 'a', 'x', '2026-10-01', [svc(1700)]), sale('2', 'a', 'x', '2026-10-05', [svc(1700)]), sale('3', 'b', 'x', '2026-10-09', [svc(1700)])];
    const s = shopMetrics({ from: '2026-10-01', to: '2026-10-14', bookings: [], sales: ss }, ['a', 'b']);
    expect(s.total.uniqueCustomers).toBe(1); expect(s.total.newCustomers).toBe(1); expect(s.total.regularCustomers).toBe(1);
    expect(s.perBarber.map(m => m.regularCustomers)).toEqual([0, 0]);
  });
  it('revenueByDay cobre todos os dias e separa serviços de produtos', () => {
    const r = revenueByDay(sales, ['a'], '2026-10-12', '2026-10-14');
    expect(r.map(d => d.date)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14']);
    expect(r[1]).toEqual({ date: '2026-10-13', servicesCents: 1700 + 2500, productsCents: 3000 }); expect(r[2].servicesCents).toBe(0);
    expect(revenueByDay(sales, null, '2026-10-12', '2026-10-12')[0].servicesCents).toBe(1700);
  });
  it('periodBefore tem a mesma duração e termina na véspera', () => { expect(periodBefore('2026-10-08', '2026-10-14')).toEqual({ from: '2026-10-01', to: '2026-10-07' }); });
  it('privacidade: os indicadores nunca contêm identificadores de clientes', () => {
    const json = JSON.stringify(shopMetrics(base, ['a', 'b']));
    for (const c of ['c1', 'c2', 'c3', 'c9']) expect(json).not.toContain(`"${c}"`);
  });
});
