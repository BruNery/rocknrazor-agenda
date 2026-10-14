import type { Booking, DateStr } from './types';

/** Valores em cêntimos (inteiros) para evitar erros de arredondamento. */
export interface SaleItem { kind: 'service' | 'product'; refId: string; name: string; qty: number; unitCents: number }
export interface Sale { id: string; bookingId?: string; employeeId: string; customerId: string; date: DateStr; items: SaleItem[]; payment: 'dinheiro' | 'cartao' | 'mbway' | 'outro' }

export interface MetricsInput {
  employeeId: string;
  from: DateStr; to: DateStr;            // intervalo inclusivo
  bookings: Booking[]; sales: Sale[];
  /** Cliente fixo = pelo menos `regularMinVisits` atendimentos com este barbeiro nos `regularWindowDays` dias até `to`. */
  regularMinVisits?: number; regularWindowDays?: number;
  /** Minutos de trabalho disponíveis no intervalo (horário menos bloqueios), para a ocupação. */
  availableMinutes?: number;
}
export interface Ranked { id: string; name: string; qty: number; cents: number }
export interface BarberMetrics {
  employeeId: string; from: DateStr; to: DateStr;
  bookings: number; noShows: number; cancelled: number; noShowRate: number;
  services: number;                         // atendimentos pagos (vendas com pelo menos um serviço)
  revenueServicesCents: number; revenueProductsCents: number; revenueCents: number;
  avgTicketCents: number;                   // receita total / vendas
  productUnits: number; salesWithProduct: number; productAttachRate: number;
  uniqueCustomers: number; newCustomers: number; regularCustomers: number; returnRate: number;
  occupancy: number | null;                 // minutos marcados / disponíveis
  topServices: Ranked[]; topProducts: Ranked[];
  byWeekday: number[];                      // atendimentos por dia da semana (0=domingo)
}

const inRange = (d: DateStr, a: DateStr, b: DateStr) => d >= a && d <= b;
const lineCents = (i: SaleItem) => i.qty * i.unitCents;
const saleCents = (s: Sale, kind?: SaleItem['kind']) => s.items.filter(i => !kind || i.kind === kind).reduce((t, i) => t + lineCents(i), 0);
const dayDiff = (a: DateStr, b: DateStr) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8))) / 86400000);
const wd = (d: DateStr) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8))).getUTCDay();

function rank(sales: Sale[], kind: SaleItem['kind']): Ranked[] {
  const m = new Map<string, Ranked>();
  for (const s of sales) for (const i of s.items) if (i.kind === kind) { const r = m.get(i.refId) ?? { id: i.refId, name: i.name, qty: 0, cents: 0 }; r.qty += i.qty; r.cents += lineCents(i); m.set(i.refId, r); }
  return [...m.values()].sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
}

export function barberMetrics(x: MetricsInput): BarberMetrics {
  const minVisits = x.regularMinVisits ?? 3, windowDays = x.regularWindowDays ?? 90;
  const bks = x.bookings.filter(b => b.employeeId === x.employeeId && inRange(b.date, x.from, x.to));
  const sales = x.sales.filter(s => s.employeeId === x.employeeId && inRange(s.date, x.from, x.to));
  const all = x.sales.filter(s => s.date <= x.to);

  const revenueServicesCents = sales.reduce((t, s) => t + saleCents(s, 'service'), 0);
  const revenueProductsCents = sales.reduce((t, s) => t + saleCents(s, 'product'), 0);
  const revenueCents = revenueServicesCents + revenueProductsCents;
  const salesWithProduct = sales.filter(s => s.items.some(i => i.kind === 'product')).length;

  const customers = new Set(sales.map(s => s.customerId));
  // novo = primeira compra na loja (com qualquer barbeiro) dentro do intervalo
  const firstEver = new Map<string, DateStr>();
  for (const s of all) { const f = firstEver.get(s.customerId); if (!f || s.date < f) firstEver.set(s.customerId, s.date); }
  const newCustomers = [...customers].filter(c => inRange(firstEver.get(c)!, x.from, x.to)).length;
  const winStart = (() => { const t = new Date(Date.UTC(+x.to.slice(0, 4), +x.to.slice(5, 7) - 1, +x.to.slice(8)) - (windowDays - 1) * 86400000); return t.toISOString().slice(0, 10); })();
  const visits = new Map<string, number>();
  for (const s of x.sales) if (s.employeeId === x.employeeId && inRange(s.date, winStart, x.to)) visits.set(s.customerId, (visits.get(s.customerId) ?? 0) + 1);
  const regularCustomers = [...visits.values()].filter(n => n >= minVisits).length;
  // retorno = clientes do intervalo que já tinham vindo antes ao barbeiro
  const before = new Set(x.sales.filter(s => s.employeeId === x.employeeId && s.date < x.from).map(s => s.customerId));
  const returning = [...customers].filter(c => before.has(c)).length;

  const booked = bks.filter(b => b.status !== 'cancelled').reduce((t, b) => t + (b.endMin - b.startMin), 0);
  const noShows = bks.filter(b => b.status === 'noshow').length, cancelled = bks.filter(b => b.status === 'cancelled').length;
  const byWeekday = Array(7).fill(0); for (const s of sales) byWeekday[wd(s.date)]++;
  const units = sales.reduce((t, s) => t + s.items.filter(i => i.kind === 'product').reduce((u, i) => u + i.qty, 0), 0);

  return {
    employeeId: x.employeeId, from: x.from, to: x.to,
    bookings: bks.length, noShows, cancelled, noShowRate: bks.length ? noShows / bks.length : 0,
    services: sales.filter(s => s.items.some(i => i.kind === 'service')).length,
    revenueServicesCents, revenueProductsCents, revenueCents,
    avgTicketCents: sales.length ? Math.round(revenueCents / sales.length) : 0,
    productUnits: units, salesWithProduct, productAttachRate: sales.length ? salesWithProduct / sales.length : 0,
    uniqueCustomers: customers.size, newCustomers, regularCustomers, returnRate: customers.size ? returning / customers.size : 0,
    occupancy: x.availableMinutes ? Math.min(1, booked / x.availableMinutes) : null,
    topServices: rank(sales, 'service'), topProducts: rank(sales, 'product'), byWeekday,
  };
}

export interface ShopMetrics { total: BarberMetrics; perBarber: BarberMetrics[]; ranking: { employeeId: string; revenueCents: number; share: number }[] }
/** Visão do administrador: todos os barbeiros e o total da loja. */
export function shopMetrics(base: Omit<MetricsInput, 'employeeId'>, employeeIds: string[]): ShopMetrics {
  const perBarber = employeeIds.map(id => barberMetrics({ ...base, employeeId: id }));
  const revenue = perBarber.reduce((t, m) => t + m.revenueCents, 0);
  const sum = (f: (m: BarberMetrics) => number) => perBarber.reduce((t, m) => t + f(m), 0);
  const sales = perBarber.reduce((t, m) => t + (m.avgTicketCents ? Math.round(m.revenueCents / m.avgTicketCents) : 0), 0);
  const total: BarberMetrics = {
    employeeId: 'loja', from: base.from, to: base.to,
    bookings: sum(m => m.bookings), noShows: sum(m => m.noShows), cancelled: sum(m => m.cancelled), noShowRate: sum(m => m.bookings) ? sum(m => m.noShows) / sum(m => m.bookings) : 0,
    services: sum(m => m.services), revenueServicesCents: sum(m => m.revenueServicesCents), revenueProductsCents: sum(m => m.revenueProductsCents), revenueCents: revenue,
    avgTicketCents: sales ? Math.round(revenue / sales) : 0, productUnits: sum(m => m.productUnits), salesWithProduct: sum(m => m.salesWithProduct),
    productAttachRate: sales ? sum(m => m.salesWithProduct) / sales : 0,
    uniqueCustomers: new Set(base.sales.filter(s => employeeIds.includes(s.employeeId) && s.date >= base.from && s.date <= base.to).map(s => s.customerId)).size,
    newCustomers: sum(m => m.newCustomers), regularCustomers: sum(m => m.regularCustomers), returnRate: 0, occupancy: null,
    topServices: mergeRank(perBarber.map(m => m.topServices)), topProducts: mergeRank(perBarber.map(m => m.topProducts)),
    byWeekday: Array.from({ length: 7 }, (_, d) => sum(m => m.byWeekday[d])),
  };
  return { total, perBarber, ranking: perBarber.map(m => ({ employeeId: m.employeeId, revenueCents: m.revenueCents, share: revenue ? m.revenueCents / revenue : 0 })).sort((a, b) => b.revenueCents - a.revenueCents) };
}
function mergeRank(lists: Ranked[][]): Ranked[] {
  const m = new Map<string, Ranked>();
  for (const r of lists.flat()) { const c = m.get(r.id) ?? { ...r, qty: 0, cents: 0 }; c.qty += r.qty; c.cents += r.cents; m.set(r.id, c); }
  return [...m.values()].sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
}
