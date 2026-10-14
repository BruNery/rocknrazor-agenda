import { addDays, barberMetrics, shopMetrics, revenueByDay, periodBefore, weekday, type BarberMetrics, type DateStr } from '@rr/domain';
import type { Store } from './store';
import { EMPLOYEES } from './store';

export type Period = '7' | '30' | '90' | 'mes';
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
export const eur = (c: number) => '€ ' + (c / 100).toLocaleString('pt-PT', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2, useGrouping: 'always' as any });
const pct = (x: number) => `${Math.round(x * 100)}%`;
const WD = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const dm = (d: DateStr) => d.slice(8) + '/' + d.slice(5, 7);

export function range(period: Period, today: DateStr): { from: DateStr; to: DateStr } {
  if (period === 'mes') return { from: today.slice(0, 8) + '01', to: today };
  return { from: addDays(today, -(Number(period) - 1)), to: today };
}
function openDays(from: DateStr, to: DateStr) { let n = 0; for (let d = from; d <= to; d = addDays(d, 1)) if (weekday(d) !== 0) n++; return n; }
/** Minutos de trabalho por barbeiro: seg a sáb, 9 h menos 1 h de almoço (pressuposto da demonstração). */
const WORK_MIN = 540;

export interface DashState { who: 'all' | string; period: Period }
export function compute(store: Store, st: DashState) {
  const today = store.today(); const { from, to } = range(st.period, today); const prev = periodBefore(from, to);
  const ids = st.who === 'all' ? EMPLOYEES.map(e => e.id) : [st.who];
  const mk = (a: DateStr, b: DateStr) => { const base = { from: a, to: b, bookings: store.bookings, sales: store.sales, availableMinutes: openDays(a, b) * WORK_MIN };
    return st.who === 'all' ? shopMetrics(base, ids) : { total: barberMetrics({ ...base, employeeId: st.who }), perBarber: [] as BarberMetrics[], ranking: [] as { employeeId: string; revenueCents: number; share: number }[] }; };
  return { from, to, prevFrom: prev.from, prevTo: prev.to, cur: mk(from, to), prev: mk(prev.from, prev.to), days: revenueByDay(store.sales, st.who === 'all' ? null : ids, from, to) };
}

function delta(cur: number, prev: number, invert = false): string {
  if (!prev) return '<span class="dl muted">sem período anterior</span>';
  const d = (cur - prev) / prev; const good = invert ? d < 0 : d > 0; const flat = Math.abs(d) < 0.005;
  const cls = flat ? 'muted' : good ? 'up' : 'down'; const arrow = flat ? '→' : d > 0 ? '▲' : '▼';
  return `<span class="dl ${cls}">${arrow} ${Math.abs(Math.round(d * 100))}% <span class="muted">vs período anterior</span></span>`;
}
const tile = (label: string, value: string, extra = '', big = false, tip = '') => `<div class="kpi ${big ? 'big' : ''}" ${tip ? `data-tip="${esc(tip)}"` : ''}><div class="kl">${label}</div><div class="kv">${value}</div>${extra}</div>`;

function dailyChart(days: { date: DateStr; servicesCents: number; productsCents: number }[]): string {
  const W = 760, H = 220, L = 44, B = 24, T = 10, R = 6; const max = Math.max(1, ...days.map(d => d.servicesCents + d.productsCents));
  const step = niceStep(max / 4); const top = Math.ceil(max / step) * step; const bw = (W - L - R) / days.length; const y = (v: number) => T + (H - T - B) * (1 - v / top);
  let g = ''; for (let v = 0; v <= top; v += step) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${eur(v)}</text>`;
  let bars = '', hits = '', xl = '';
  days.forEach((d, i) => {
    const x = L + i * bw, w = Math.max(1, bw - 2), s = d.servicesCents, p = d.productsCents;
    if (s) bars += `<rect x="${x + 1}" y="${y(s)}" width="${w}" height="${y(0) - y(s)}" fill="var(--s1)" rx="${Math.min(3, w / 2)}"/>`;
    if (p) bars += `<rect x="${x + 1}" y="${y(s + p)}" width="${w}" height="${y(s) - y(s + p) - 2}" fill="var(--s2)" rx="${Math.min(3, w / 2)}"/>`;
    hits += `<rect x="${x}" y="${T}" width="${bw}" height="${H - T - B}" fill="transparent" data-tip="${WD[weekday(d.date)]} ${dm(d.date)} · Serviços ${eur(s)} · Produtos ${eur(p)} · Total ${eur(s + p)}"/>`;
    if (i % Math.ceil(days.length / 8) === 0) xl += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" class="ax">${dm(d.date)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Receita por dia, serviços e produtos">${g}${bars}${xl}${hits}</svg>`;
}
function niceStep(raw: number) { const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1)))); const n = raw / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }

function weekdayChart(by: number[]): string {
  const order = [1, 2, 3, 4, 5, 6, 0]; const max = Math.max(1, ...by); const W = 360, H = 170, B = 22, T = 18; const bw = W / 7;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Atendimentos por dia da semana">${order.map((d, i) => { const h = (H - B - T) * by[d] / max; const x = i * bw + 8, w = bw - 16;
    return `<rect x="${x}" y="${H - B - h}" width="${w}" height="${h}" rx="4" fill="var(--s1)" data-tip="${WD[d]}: ${by[d]} atendimentos"/><text x="${x + w / 2}" y="${H - B - h - 4}" text-anchor="middle" class="ax val">${by[d]}</text><text x="${x + w / 2}" y="${H - 6}" text-anchor="middle" class="ax">${WD[d]}</text>`; }).join('')}</svg>`;
}
function hbars(rows: { name: string; qty: number; cents: number }[], unit: string): string {
  if (!rows.length) return '<p class="muted">Sem vendas neste período.</p>'; const max = Math.max(...rows.map(r => r.cents));
  return `<ul class="hb">${rows.slice(0, 5).map(r => `<li data-tip="${esc(r.name)} · ${r.qty} ${unit} · ${eur(r.cents)}"><span class="hn">${esc(r.name)}</span><span class="hbar"><i style="width:${Math.max(2, 100 * r.cents / max)}%"></i></span><span class="hv">${r.qty}× · ${eur(r.cents)}</span></li>`).join('')}</ul>`;
}

export function dashHtml(store: Store, st: DashState, admin: boolean): string {
  const c = compute(store, st); const m = c.cur.total, p = c.prev.total;
  const who = st.who === 'all' ? 'Loja inteira' : EMPLOYEES.find(e => e.id === st.who)!.name;
  const tbl = `<table><thead><tr><th>Dia</th><th>Serviços</th><th>Produtos</th><th>Total</th></tr></thead><tbody>${c.days.filter(d => d.servicesCents + d.productsCents).map(d => `<tr><td>${dm(d.date)}</td><td>${eur(d.servicesCents)}</td><td>${eur(d.productsCents)}</td><td>${eur(d.servicesCents + d.productsCents)}</td></tr>`).join('')}</tbody></table>`;
  const rank = admin && st.who === 'all' ? `<section class="panelc"><h3>Barbeiros</h3><p class="muted">Receita e quota da loja no período.</p><ul class="hb">${c.cur.ranking.map(r => { const e = EMPLOYEES.find(x => x.id === r.employeeId)!; const pm = c.cur.perBarber.find(x => x.employeeId === r.employeeId)!;
    return `<li data-tip="${esc(e.name)} · ${eur(r.revenueCents)} · ${pct(r.share)} da loja"><span class="hn">${esc(e.name)} (${esc(e.nick)})</span><span class="hbar"><i style="width:${Math.max(2, r.share * 100)}%"></i></span><span class="hv">${eur(r.revenueCents)} · ${pct(r.share)}</span></li>`; }).join('')}</ul>
    <div class="scroll"><table><thead><tr><th>Barbeiro</th><th>Receita</th><th>Atendimentos</th><th>Ticket médio</th><th>Produtos (un.)</th><th>Ocupação</th><th>Não compareceu</th></tr></thead><tbody>${c.cur.perBarber.map(x => { const e = EMPLOYEES.find(y => y.id === x.employeeId)!; return `<tr data-who="${x.employeeId}" class="clk"><td>${esc(e.name)}</td><td>${eur(x.revenueCents)}</td><td>${x.services}</td><td>${eur(x.avgTicketCents)}</td><td>${x.productUnits}</td><td>${x.occupancy === null ? '–' : pct(x.occupancy)}</td><td>${pct(x.noShowRate)}</td></tr>`; }).join('')}</tbody></table></div></section>` : '';
  return `<div class="dash" id="dash">
   <div class="dctl"><div><h2 style="margin:0">Dashboard · ${esc(who)}</h2><p class="muted" style="margin:2px 0 0">${dm(c.from)} a ${dm(c.to)} · comparado com ${dm(c.prevFrom)} a ${dm(c.prevTo)}. Só números agregados, sem dados de clientes.</p></div><span class="spacer"></span>
    ${admin ? `<select class="btn" id="dwho" aria-label="Barbeiro"><option value="all" ${st.who === 'all' ? 'selected' : ''}>Loja inteira</option>${EMPLOYEES.map(e => `<option value="${e.id}" ${st.who === e.id ? 'selected' : ''}>${esc(e.name)} (${esc(e.nick)})</option>`).join('')}</select>` : ''}
    <div class="seg" role="group" aria-label="Período">${([['7', '7 dias'], ['30', '30 dias'], ['mes', 'Este mês'], ['90', '90 dias']] as const).map(([k, l]) => `<button data-period="${k}" aria-pressed="${st.period === k}">${l}</button>`).join('')}</div></div>
   <div class="kpis">${tile('Receita', eur(m.revenueCents), delta(m.revenueCents, p.revenueCents), true)}${tile('Ticket médio', eur(m.avgTicketCents), delta(m.avgTicketCents, p.avgTicketCents), true, 'Receita total dividida pelo número de atendimentos pagos')}${tile('Atendimentos', String(m.services), delta(m.services, p.services), true)}${tile('Ocupação', m.occupancy === null ? '–' : pct(m.occupancy), p.occupancy === null || m.occupancy === null ? '' : delta(m.occupancy, p.occupancy), true, 'Minutos marcados sobre minutos de trabalho (seg a sáb, 9 h por dia)')}</div>
   <div class="kpis small">${tile('Serviços', eur(m.revenueServicesCents), delta(m.revenueServicesCents, p.revenueServicesCents))}${tile('Produtos', eur(m.revenueProductsCents), delta(m.revenueProductsCents, p.revenueProductsCents))}${tile('Produtos vendidos', String(m.productUnits) + ' un.', delta(m.productUnits, p.productUnits))}${tile('Atendimentos com produto', pct(m.productAttachRate), delta(m.productAttachRate, p.productAttachRate), false, 'Parte dos atendimentos em que se vendeu pelo menos um produto')}
     ${tile('Clientes fixos', String(m.regularCustomers), delta(m.regularCustomers, p.regularCustomers), false, 'Clientes com 3 ou mais visitas nos últimos 90 dias. Só a contagem.')}${tile('Clientes novos', String(m.newCustomers), delta(m.newCustomers, p.newCustomers))}${tile('Taxa de retorno', pct(m.returnRate), delta(m.returnRate, p.returnRate), false, 'Parte dos clientes do período que já tinham vindo antes')}${tile('Não compareceu', pct(m.noShowRate), delta(m.noShowRate, p.noShowRate, true), false, `${m.noShows} de ${m.bookings} marcações. ${m.cancelled} canceladas.`)}</div>
   <section class="panelc"><div class="dcrow"><h3>Receita por dia</h3><span class="legend"><i class="sw s1"></i>Serviços <i class="sw s2"></i>Produtos</span></div><div class="chart">${dailyChart(c.days)}</div><details><summary>Ver como tabela</summary><div class="scroll">${tbl}</div></details></section>
   <div class="grid2"><section class="panelc"><h3>Atendimentos por dia da semana</h3>${weekdayChart(m.byWeekday)}</section>
   <section class="panelc"><h3>Serviços mais vendidos</h3>${hbars(m.topServices, 'atend.')}<h3 style="margin-top:18px">Produtos mais vendidos</h3>${hbars(m.topProducts, 'un.')}</section></div>
   ${rank}</div>`;
}
