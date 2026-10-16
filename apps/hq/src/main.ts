import { addDays, weekday, localToEpochMs, type Conflict, type DateStr } from '@rr/domain';
import { Store, EMPLOYEES, SERVICES, STATUSES, COUNTRY_CODES, PRODUCTS, PAYMENTS, fmt, empOf, svcOf, type B } from './store';
import { Live, joinPhone } from './live';
import { C as CF, cfgHtml, mineHtml, cfgClick, cfgChange, cfgSubmit, loadCfg, loadMine, type Deps } from './cfg';
import { dashHtml, eur, type Period } from './dash';
import { mountBooking } from './booking';
import { pushState, enablePush, disablePush, type PushState } from './push';
/** Só existe na versão alojada (o servidor injeta o endereço da API). Na demonstração fica em branco e os avisos são simulados. */
const API = (window as any).RR_API as string | undefined;

const START = 540, END = 1140;
const store = new Store(Date.now, { demo: API === undefined });
/** Na app real, tudo vem e vai para o servidor; na demonstração fica no ecrã. */
const live = API !== undefined ? new Live(API, store) : null;
type View = 'day' | 'week' | 'list' | 'dash' | 'cfg' | 'mine';
const S = { auth: (live ? 'loading' : 'in') as 'loading' | 'out' | 'in', loginErr: '', user: '', push: 'off' as PushState, role: 'admin' as string, dashWho: 'all' as string, period: '30' as Period, bell: false, view: 'day' as View, date: store.today(), emp: EMPLOYEES[0]?.id ?? 'andre', zoom: 16, sel: null as string | null, toast: '', showLog: false };
const $app = document.getElementById('app')!;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const empName = (id: string) => { const e = empOf(id); return e.nick ? `${e.name} (${e.nick})` : e.name; };
const svcName = (ids: string[]) => ids.map(i => svcOf(i).name).join(' + ');
const dayLabel = (d: DateStr, long = true) => new Intl.DateTimeFormat('pt-PT', { weekday: long ? 'long' : 'short', day: 'numeric', month: long ? 'long' : 'short', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z'));
const isAdmin = () => S.role === 'admin';
const visibleEmps = () => isAdmin() ? EMPLOYEES : EMPLOYEES.filter(e => e.id === S.role);
const monday = (d: DateStr) => addDays(d, -((weekday(d) + 6) % 7));

type Col = { emp: string; date: DateStr; label: string; sub: string };
function columns(): Col[] {
  if (S.view === 'week') return Array.from({ length: 6 }, (_, i) => { const d = addDays(monday(S.date), i); return { emp: S.emp, date: d, label: dayLabel(d, false), sub: empName(S.emp) }; });
  return visibleEmps().map(e => ({ emp: e.id, date: S.date, label: `${e.name} (${e.nick})`, sub: '' }));
}

function lanes(items: B[]): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>(); const sorted = [...items].sort((a, b) => a.startMin - b.startMin);
  const groups: B[][] = [];
  for (const b of sorted) { const g = groups.find(g => g.some(x => x.startMin < b.endMin && b.startMin < x.endMin)); g ? g.push(b) : groups.push([b]); }
  for (const g of groups) { const ends: number[] = []; const lane = new Map<string, number>();
    for (const b of g) { let i = ends.findIndex(e => e <= b.startMin); if (i < 0) { i = ends.length; ends.push(0); } ends[i] = b.endMin; lane.set(b.id, i); }
    for (const b of g) out.set(b.id, [lane.get(b.id)!, ends.length]); }
  return out;
}

function agendaHtml(): string {
  const cols = columns(), H = ((END - START) / 10) * S.zoom, z = S.zoom;
  const tpl = `${matchMedia('(max-width: 700px)').matches ? 40 : 56}px repeat(${cols.length}, minmax(${matchMedia('(max-width: 700px)').matches ? 118 : 130}px, 1fr))`;
  let gut = ''; for (let m = START; m <= END; m += 20) gut += `<span class="${m % 60 === 0 ? 'h' : ''}" style="top:${((m - START) / 10) * z}px">${fmt(m)}</span>`;
  const now = store.nowMs(), nowMin = Math.floor((now - new Date(new Date(now).toDateString()).getTime()) / 60000);
  const colsHtml = cols.map((c, i) => {
    const open = (weekday(c.date) !== 0);
    const bks = store.bookings.filter(b => b.employeeId === c.emp && b.date === c.date && b.status !== 'cancelled');
    const ln = lanes(bks);
    const blocks = store.blocks.filter(b => b.employeeId === c.emp && b.date === c.date).map(b => { const s0 = b.allDay ? START : Math.max(START, b.startMin!), e0 = b.allDay ? END : Math.min(END, b.endMin!); return `<div class="blocked" style="top:${((s0 - START) / 10) * z}px;height:${((e0 - s0) / 10) * z}px;left:2px;right:2px">${b.allDay ? 'fechado' : 'pausa / indisponível'}</div>`; }).join('');
    const bh = bks.map(b => { const [l, n] = ln.get(b.id)!; const w = 88 / n; const svc = svcOf(b.serviceIds[0]);
      return `<div class="blk ${svc.cls} ${b.status === 'cancelled' ? 'cancelled' : b.status === 'noshow' ? 'noshow' : ''} ${S.sel === b.id ? 'sel' : ''}" data-id="${b.id}" style="top:${((b.startMin - START) / 10) * z}px;height:${((b.endMin - b.startMin) / 10) * z - 1}px;left:calc(${l * w}% + 2px);width:calc(${w}% - 4px)"><b>${esc(store.customer(b.customerId).name)}</b><span class="m">${fmt(b.startMin)}–${fmt(b.endMin)} · ${esc(svcName(b.serviceIds))}</span></div>`; }).join('');
    const nl = c.date === store.today() && nowMin >= START && nowMin <= END ? `<div class="now" style="top:${((nowMin - START) / 10) * z}px"></div>` : '';
    return `<div class="col ${open ? '' : 'closed'}" data-col="${i}" style="height:${H}px;background-size:100% ${z * 6}px">${open ? '' : '<div class="closedmsg">Fechado</div>'}${blocks}${bh}${nl}</div>`;
  }).join('');
  const head = cols.map(c => `<div>${esc(c.label)}${c.sub ? `<small>${esc(c.sub)}</small>` : ''}</div>`).join('');
  return `<div class="head" style="grid-template-columns:${tpl};--n:${cols.length}"><div style="border:0"></div>${head}</div><div class="cols" style="grid-template-columns:${tpl};--n:${cols.length}"><div class="gutter" style="height:${H}px">${gut}</div>${colsHtml}</div>`;
}

function listHtml(): string {
  const days = S.view === 'list' ? [S.date] : [];
  const rows = store.bookings.filter(b => days.includes(b.date) && visibleEmps().some(e => e.id === b.employeeId)).sort((a, b) => a.startMin - b.startMin);
  return `<div class="list"><table><thead><tr><th>Hora</th><th>Colaborador</th><th>Cliente</th><th>Serviço</th><th>Origem</th><th>Estado</th></tr></thead><tbody>${rows.map(b => `<tr data-id="${b.id}"><td>${fmt(b.startMin)}–${fmt(b.endMin)}</td><td>${esc(empName(b.employeeId))}</td><td>${esc(store.customer(b.customerId).name)}</td><td>${esc(svcName(b.serviceIds))}</td><td>${b.source === 'online' ? 'Online' : 'HQ'}</td><td><span class="pill ${b.status === 'confirmed' ? 'ok' : 'bad'}">${STATUSES.find(x => x.id === b.status)!.name}</span></td></tr>`).join('') || '<tr><td colspan="6">Sem marcações neste dia.</td></tr>'}</tbody></table></div>`;
}

// ---------- Ficha da marcação (rascunho editável, como no Noona) ----------
interface Draft { id: string; name: string; cc: string; phone: string; email: string; cnotes: string; emp: string; date: DateStr; start: number; svcs: string[]; notes: string; status: B['status']; adding: boolean }
let D: Draft | null = null;
const openDraft = (id: string) => { const b = store.bookings.find(x => x.id === id)!; const c = store.customer(b.customerId); D = { id, name: c.name, cc: c.cc, phone: c.phone, email: c.email, cnotes: c.notes, emp: b.employeeId, date: b.date, start: b.startMin, svcs: [...b.serviceIds], notes: b.notes, status: b.status, adding: false }; S.sel = id; S.showLog = false; };
const dd = (d: DateStr) => d.split('-').reverse().join('/');
const euro = (n: number) => `€ ${n.toFixed(2).replace('.', ',')}`;

function drawerHtml(): string {
  if (!D) return '';
  const b = store.bookings.find(x => x.id === D!.id)!; const d = D;
  const total = store.dur(d.svcs, d.emp), price = d.svcs.reduce((s, id) => s + svcOf(id).price, 0);
  const prev = store.previousVisits(b);
  const free = SERVICES.filter(s => !d.svcs.includes(s.id));
  return `<div class="scrim side" data-scrim="drawer"><form class="drawer" id="df" role="dialog" aria-modal="true" aria-labelledby="dt">
   <header class="dh"><h2 id="dt">${esc(empOf(d.emp).name)} @ ${fmt(d.start)} <small>– ${esc(dayLabel(d.date, false))}</small></h2><button type="button" class="btn icon" data-act="d-close" aria-label="Fechar">✕</button></header>
   <div class="db"><section class="dc"><h3>Cliente</h3><div class="card">
     <div class="field"><label for="d-name">Nome</label><input id="d-name" data-k="name" value="${esc(d.name)}" required autocomplete="off"></div>
     <div class="field"><label for="d-phone">Número de telefone</label><div class="phone"><select id="d-cc" data-k="cc" aria-label="Indicativo">${COUNTRY_CODES.map(c => `<option ${c === d.cc ? 'selected' : ''}>${c}</option>`).join('')}</select><input id="d-phone" data-k="phone" inputmode="tel" value="${esc(d.phone)}"></div></div>
     <div class="field"><label for="d-email">Endereço de e-mail</label><input id="d-email" type="email" data-k="email" value="${esc(d.email)}"></div>
     <div class="field"><label for="d-cnotes">Notas do cliente</label><textarea id="d-cnotes" data-k="cnotes" rows="4">${esc(d.cnotes)}</textarea></div></div>
     <p class="hint">Os dados do cliente valem para todas as marcações dele.</p></section>
   <section class="dc"><div class="dcrow"><h3>Marcação</h3>${live ? '' : `<button type="button" class="btn" data-act="d-log" aria-pressed="${S.showLog}">Histórico</button>`}</div>
     <div class="tools"><label class="tool">Estado<select id="d-status" data-k="status">${STATUSES.map(s => `<option value="${s.id}" ${s.id === d.status ? 'selected' : ''}>${s.name}</option>`).join('')}</select></label>
       <button type="button" class="tool" data-act="d-sms" disabled title="Integração futura">SMS</button><button type="button" class="tool" data-act="d-move">Mover</button><button type="button" class="tool" data-act="d-copy">Copiar</button></div>
     <div class="card"><div class="line"><label for="d-date">Data</label><input id="d-date" type="date" data-k="date" value="${d.date}"></div>
       <div class="line"><label for="d-time">Hora</label><span class="stepper"><button type="button" class="btn icon" data-act="d-t" data-v="-10" aria-label="10 minutos antes">−</button><input id="d-time" type="time" step="600" data-k="time" value="${fmt(d.start)}"><button type="button" class="btn icon" data-act="d-t" data-v="10" aria-label="10 minutos depois">+</button></span></div>
       <div class="slots">${slotsHtml(d.emp, d.date, d.svcs, store.dur(d.svcs, d.emp), d.id, d.start, 'd')}</div>
       <div class="line"><span>Repetir</span><span class="muted">Nunca</span></div></div>
     <div class="card"><div class="dcrow"><h4>Serviço</h4>${free.length ? `<button type="button" class="btn link" data-act="d-add">+ Adicionar serviço</button>` : ''}</div>
       ${d.adding ? `<div class="addlist">${free.map(s => `<button type="button" class="btn" data-act="d-addsvc" data-v="${s.id}">${esc(s.name)} · ${s.durationMin} min</button>`).join('')}</div>` : ''}
       ${d.svcs.map(id => { const s = svcOf(id); return `<div class="svc"><span class="dot ${s.cls}"></span><div><b>${esc(s.name)}</b><div class="muted">${s.durationMin} min · ${euro(s.price)}</div></div>${d.svcs.length > 1 ? `<button type="button" class="btn icon" data-act="d-delsvc" data-v="${id}" aria-label="Remover ${esc(s.name)}">🗑</button>` : ''}</div>`; }).join('')}
       <p class="muted" style="margin:8px 0 0">Total: <b>${total} minutos</b> · ${euro(price)} · termina às ${fmt(d.start + total)}</p></div>
     <div class="card"><div class="line"><label for="d-emp">Colaborador</label><select id="d-emp" data-k="emp">${visibleEmps().map(e => `<option value="${e.id}" ${e.id === d.emp ? 'selected' : ''}>${esc(e.name)} (${esc(e.nick)})</option>`).join('')}</select></div></div>
     <div class="card"><div class="field" style="margin:0"><label for="d-notes">Notas</label><textarea id="d-notes" data-k="notes" rows="3">${esc(d.notes)}</textarea></div></div>
     <p class="hint">Marcação criada ${new Date(b.createdAt).toLocaleDateString('pt-PT')} ${new Date(b.createdAt).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })} ${b.source === 'online' ? 'pela reserva online' : 'no HQ'}.</p>
     ${S.showLog ? `<ul class="log">${b.log.map(l => `<li>${new Date(l.at).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })} · ${esc(l.text)}</li>`).join('')}</ul>` : ''}
     <h3 style="margin-top:20px">Visitas anteriores</h3>${prev.map(p => `<div class="visit"><div><b>${esc(svcName(p.serviceIds))}</b><div class="muted">Colaborador: ${esc(empName(p.employeeId))}</div></div><div class="muted r">${dd(p.date)}<br>${fmt(p.startMin)}</div></div>`).join('') || '<p class="muted">Sem visitas anteriores.</p>'}</section></div>
   <footer class="df">${!live || isAdmin() ? `<button type="button" class="btn danger solid" data-act="d-del">Apagar</button>` : ''}<span class="spacer"></span>${b.saleId ? `<span class="muted">Atendimento registado${store.sales.find(x => String(x.id) === String(b.saleId)) ? ` · ${eur(store.sales.find(x => String(x.id) === String(b.saleId))!.items.reduce((t, i) => t + i.qty * i.unitCents, 0))}` : ''}</span>` : b.status === 'cancelled' ? '' : `<button type="button" class="btn" data-act="d-sale">Registar atendimento</button>`}<button class="btn primary big" type="submit">Guardar</button></footer></form></div>`;
}

function modalHtml(): string {
  const m = M; if (!m) return '';
  const shell = (title: string, body: string, acts: string) => `<div class="scrim"><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="t"><h2 id="t">${title}</h2>${body}<div class="acts">${acts}</div></div></div>`;
  if (m.kind === 'conflict') return shell('Conflito de marcações', `<p>Esta marcação coincide com:</p><ul class="conf">${m.conflicts.map(c => `<li>${confText(c)}</li>`).join('')}</ul>`, `<button class="btn" data-act="m-no">Voltar</button><button class="btn primary" data-act="m-force">Marcar mesmo assim</button>`);
  if (m.kind === 'notify') return shell(esc(m.title), `<p>Queres notificar o cliente? (${live ? 'O envio de mensagens aos clientes ainda não está ligado: fica só registado.' : 'Nesta demonstração nenhuma mensagem é enviada.'})</p>`, `<button class="btn" data-act="m-no">Voltar</button><button class="btn" data-act="m-silent">Não notificar</button><button class="btn primary" data-act="m-notify">Notificar cliente</button>`);
  if (m.kind === 'sale') { const b = store.bookings.find(x => x.id === m.id)!; return `<div class="scrim"><form class="dlg" id="salef" role="dialog" aria-modal="true" aria-labelledby="t"><h2 id="t">Registar atendimento</h2><p>Confirma o que foi cobrado. Não processa pagamentos.</p>
    <div class="field"><label>Serviços (preço em €)</label>${b.serviceIds.map(id => { const sv = svcOf(id); return `<div class="line"><span>${esc(sv.name)}</span><input type="number" min="0" step="0.5" data-sale="svc" data-id="${id}" value="${sv.price}" aria-label="Preço de ${esc(sv.name)}"></div>`; }).join('')}</div>
    <div class="field"><label>Produtos vendidos (quantidade)</label>${PRODUCTS.map(pr => `<div class="line"><span>${esc(pr.name)} · ${eur(pr.price * 100)}</span><input type="number" min="0" max="9" step="1" data-sale="prod" data-id="${pr.id}" value="0" aria-label="Quantidade de ${esc(pr.name)}"></div>`).join('')}</div>
    <div class="field"><label for="s-pay">Forma de pagamento</label><select id="s-pay">${PAYMENTS.map(x => `<option value="${x.id}">${x.name}</option>`).join('')}</select></div>
    <div class="line"><b>Total</b><b id="sale-total">${eur(b.serviceIds.reduce((t, id) => t + svcOf(id).price, 0) * 100)}</b></div>
    <div class="acts"><button type="button" class="btn" data-act="m-no">Voltar</button><button class="btn primary" type="submit">Registar</button></div></form></div>`; }
  if (m.kind === 'delete') return shell('Apagar marcação', `<p>Esta marcação desaparece da agenda e do histórico. Não se pode desfazer.</p>`, `<button class="btn" data-act="m-no">Voltar</button><button class="btn danger solid" data-act="m-del">Apagar</button>`);
  if (m.kind === 'new') return `<div class="scrim"><form class="dlg" id="newf" role="dialog" aria-modal="true" aria-labelledby="t"><h2 id="t">Nova marcação</h2>
    <div class="field"><label for="f-name">Cliente</label><input id="f-name" list="clients" required autocomplete="off" placeholder="Nome (escolhe um existente ou escreve um novo)" value="${esc(m.name)}"><datalist id="clients">${store.customers.filter(c => c.phone).map(c => `<option value="${esc(c.name)}"></option>`).join('')}</datalist></div>
    <div class="two"><div class="field"><label for="f-phone">Telefone</label><input id="f-phone" inputmode="tel" value="${esc(m.phone)}"></div><div class="field"><label for="f-email">E-mail</label><input id="f-email" type="email" value="${esc(m.email)}"></div></div>
    <div class="two"><div class="field"><label for="f-emp">Colaborador</label><select id="f-emp">${visibleEmps().map(e => `<option value="${e.id}" ${e.id === m.emp ? 'selected' : ''}>${e.name}</option>`).join('')}</select></div><div class="field"><label for="f-date">Dia</label><input id="f-date" type="date" value="${m.date}"></div></div>
    <div class="field"><label for="f-time">Hora</label><input id="f-time" type="time" step="600" value="${fmt(m.start)}"></div>
    <div class="slots" id="slots-m"></div>
    <div class="field"><label>Serviços</label><div class="checks">${SERVICES.map(s => `<label><input type="checkbox" name="svc" value="${s.id}" ${m.svcs.includes(s.id) ? 'checked' : ''}>${s.name} · ${s.durationMin} min</label>`).join('')}</div></div>
    <div class="acts"><button type="button" class="btn" data-act="m-no">Cancelar</button><button class="btn primary" type="submit">Criar marcação</button></div></form></div>`;
  if (m.kind === 'resched') return `<div class="scrim"><form class="dlg" id="rf" role="dialog" aria-modal="true" aria-labelledby="t"><h2 id="t">Mover marcação</h2><div class="two"><div class="field"><label for="r-date">Dia</label><input id="r-date" type="date" value="${m.date}"></div><div class="field"><label for="r-time">Hora</label><input id="r-time" type="time" step="600" value="${fmt(m.start)}"></div></div><div class="field"><label for="r-emp">Colaborador</label><select id="r-emp">${visibleEmps().map(e => `<option value="${e.id}" ${e.id === m.emp ? 'selected' : ''}>${e.name}</option>`).join('')}</select></div><div class="slots" id="slots-m"></div><div class="acts"><button type="button" class="btn" data-act="m-no">Voltar</button><button class="btn primary" type="submit">Mover</button></div></form></div>`;
  return '';
}
const confText = (c: Conflict) => { const o = c.kind === 'overlap' ? store.bookings.find(b => b.id === c.with) : undefined; return c.kind === 'overlap' ? `outra marcação (${esc(store.customer(o!.customerId).name)}, ${fmt(o!.startMin)})` : c.kind === 'blocked' ? 'um período indisponível do colaborador' : c.kind === 'outside_hours' ? 'horas fora do horário de funcionamento' : c.kind === 'service_not_offered' ? 'um serviço que o colaborador não faz' : 'uma reserva temporária'; };

type Modal = null
  | { kind: 'conflict'; conflicts: Conflict[]; then: () => void; back: Modal }
  | { kind: 'notify'; title: string; then: (notify: boolean) => void }
  | { kind: 'delete' }
  | { kind: 'sale'; id: string }
  | { kind: 'new'; name: string; phone: string; email: string; emp: string; date: DateStr; start: number; svcs: string[] }
  | { kind: 'resched'; id: string; emp: string; date: DateStr; start: number };
/** Horários livres de um barbeiro num dia para uma duração: aparecem ao lado do dia, para não haver tentativa e erro. */
function freeSlots(emp: string, date: DateStr, svcs: string[], dur: number, ignoreId?: string): { slots: number[]; why?: string } {
  const today = store.today();
  if (!date || date < today) return { slots: [], why: 'Esse dia já passou.' };
  if (live && date > addDays(today, 180)) return { slots: [], why: 'Dia demasiado longe para listar horários.' };
  const hrs = store.hours[weekday(date)] ?? [];
  if (!hrs.length) return { slots: [], why: 'A loja está fechada nesse dia.' };
  // no HQ a grelha é fina (10 min); os 30 min são só para o cliente
  const grid = 10, out: number[] = []; let notOffered = false;
  for (const h of hrs) for (let t = Math.ceil(h.open / grid) * grid; t + dur <= h.close; t += grid) {
    if (localToEpochMs(date, t) < store.nowMs()) continue;
    const cs = store.conflicts({ employeeId: emp, date, startMin: t, endMin: t + dur, serviceIds: svcs, ignoreBookingId: ignoreId });
    if (cs.some(c => c.kind === 'service_not_offered')) notOffered = true;
    if (!cs.length) out.push(t);
  }
  return { slots: out, why: out.length ? undefined : notOffered ? 'Este barbeiro não faz um dos serviços.' : 'Sem horários livres neste dia.' };
}
function slotsHtml(emp: string, date: DateStr, svcs: string[], dur: number, ignoreId: string | undefined, cur: number, scope: 'd' | 'm'): string {
  const r = freeSlots(emp, date, svcs, dur, ignoreId);
  const head = `<div class="slotsh">Horários livres · ${esc(empOf(emp).name)} · ${esc(dayLabel(date, false))}</div>`;
  if (!r.slots.length) return `${head}<p class="muted">${esc(r.why ?? '')}</p>`;
  return `${head}<div class="slotgrid">${r.slots.map(t => `<button type="button" class="slot${t === cur ? ' on' : ''}" data-act="slot" data-t="${t}" data-for="${scope}">${fmt(t)}</button>`).join('')}</div>`;
}
/** Nos diálogos (Mover, Nova marcação) os campos não redesenham a página: o quadro de horários atualiza-se a partir deles. */
function fillSlots() {
  const box = document.getElementById('slots-m'); const m = M; if (!box || !m) return;
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
  const mins = (t: string) => { const [h, mm] = t.split(':').map(Number); return isNaN(h) ? -1 : h * 60 + mm; };
  if (m.kind === 'resched') { const b = store.bookings.find(x => x.id === m.id); if (b) box.innerHTML = slotsHtml(val('r-emp'), val('r-date') as DateStr, b.serviceIds, b.endMin - b.startMin, b.id, mins(val('r-time')), 'm'); }
  else if (m.kind === 'new') {
    const svcs = [...document.querySelectorAll<HTMLInputElement>('#newf input[name=svc]:checked')].map(x => x.value);
    box.innerHTML = svcs.length ? slotsHtml(val('f-emp'), val('f-date') as DateStr, svcs, store.dur(svcs, val('f-emp')), undefined, mins(val('f-time')), 'm') : '<p class="muted">Escolhe os serviços para ver os horários livres.</p>';
  }
}
let M: Modal = null;

function toast(t: string) { S.toast = t; render(); setTimeout(() => { if (S.toast === t) { S.toast = ''; render(); } }, 3200); }

const deps: Deps = { live: live!, render: () => render(), toast: t => toast(t), reload: async () => { await live!.hydrate(); render(); }, isAdmin: () => isAdmin(), today: () => store.today(), emp: () => S.emp };
const ERRTXT: Record<string, string> = { conflito: 'Esse horário já está ocupado.', indisponivel: 'Esse horário já não está disponível.', sem_permissao: 'Sem permissão para isso.', nao_encontrada: 'Marcação não encontrada.', pedido_invalido: 'Dados inválidos. Confirma o telefone e os campos.', tem_atendimento_registado: 'Esta marcação já tem atendimento registado e não pode ser apagada.', ja_registado: 'O atendimento desta marcação já foi registado.', marcacao_nao_confirmada: 'Só se regista atendimento em marcações confirmadas.' };
const errText = (j: any) => ERRTXT[j?.error] ?? 'Não foi possível concluir. Tenta outra vez.';
/** Escrita no servidor: em caso de erro avisa; em caso de sucesso volta a ler tudo, para o ecrã mostrar sempre o que o servidor tem. */
async function write(p: Promise<{ status: number; json: any }>, ok: string): Promise<{ status: number; json: any }> {
  const r = await p; if (r.status === 401) { S.auth = 'out'; D = null; M = null; render(); return r; }
  if (r.status === 200) { await live!.hydrate(); toast(ok); } else { await live!.hydrate().catch(() => {}); toast(errText(r.json)); }
  return r;
}
function loginHtml(): string {
  return `<div class="login"><form id="loginf" class="card"><div class="brand">ROCK N' RAZOR<small>AGENDA</small></div>${S.auth === 'loading' ? '<p class="muted">A abrir…</p>' : `<div class="field"><label for="l-user">Utilizador</label><input id="l-user" name="user" autocomplete="username" autocapitalize="none" required></div><div class="field"><label for="l-pw">Palavra-passe</label><input id="l-pw" name="pw" type="password" autocomplete="current-password" required></div>${S.loginErr ? `<p class="err" role="alert">${esc(S.loginErr)}</p>` : ''}<button class="btn primary big" type="submit">Entrar</button>`}</form></div>`;
}
function afterLogin() { const me = live!.me!; S.user = me.username; S.role = me.role === 'admin' ? 'admin' : me.employeeId!; S.emp = me.role === 'admin' ? (EMPLOYEES[0]?.id ?? '') : me.employeeId!; S.dashWho = me.role === 'admin' ? 'all' : S.role; S.view = 'day'; S.date = store.today(); D = null; M = null; }

function render() {
  if (live && S.auth !== 'in') { $app.innerHTML = loginHtml(); return; }
  const view = S.view; const dash = view === 'dash' || view === 'cfg' || view === 'mine';
  const emps = view === 'week' && isAdmin() ? `<select class="btn" id="emp" aria-label="Colaborador">${visibleEmps().map(e => `<option value="${e.id}" ${e.id === S.emp ? 'selected' : ''}>${e.name} (${e.nick})</option>`).join('')}</select>` : '';
  const label = view === 'week' ? `${dayLabel(monday(S.date), false)} – ${dayLabel(addDays(monday(S.date), 5), false)}` : dayLabel(S.date);
  const step = view === 'week' ? 7 : 1;
  const mine = store.notes.filter(n => isAdmin() || n.employeeId === S.role); const unread = mine.filter(n => !n.read).length;
  const main = view === 'cfg' ? cfgHtml(deps) : view === 'mine' ? mineHtml(deps) : view === 'dash' ? dashHtml(store, { who: isAdmin() ? S.dashWho : S.role, period: S.period }, isAdmin()) : view === 'list' ? listHtml() : `<div class="agenda" id="agenda">${agendaHtml()}</div>`;
  const keep = document.getElementById('agenda'); const st = keep ? [keep.scrollTop, keep.scrollLeft] : [0, 0];
  const dr = document.querySelector<HTMLElement>('.db'); const dst = dr ? dr.scrollTop : 0;
  $app.innerHTML = `<header class="top"><div class="brand">ROCK N' RAZOR<small>${live ? 'AGENDA' : 'AGENDA · DEMONSTRAÇÃO'}</small></div>
   <div class="seg" role="group" aria-label="Vista">${(['day', 'week', 'list', 'dash', ...(live ? ['mine'] : []), ...(live && isAdmin() ? ['cfg'] : [])] as View[]).map(v => `<button data-view="${v}" aria-pressed="${view === v}">${{ day: 'Dia', week: 'Semana', list: 'Lista', dash: 'Dashboard', mine: 'O meu horário', cfg: 'Definições' }[v]}</button>`).join('')}</div>
   ${dash ? '' : `<button class="btn" data-act="today">Hoje</button><button class="btn icon" data-step="${-step}" aria-label="Anterior">←</button><span class="date">${esc(label)}</span><button class="btn icon" data-step="${step}" aria-label="Seguinte">→</button>${emps}`}
   <span class="spacer"></span>${view === 'day' || view === 'week' ? `<button class="btn icon" data-zoom="-2" aria-label="Menos zoom">−</button><button class="btn icon" data-zoom="2" aria-label="Mais zoom">+</button>` : ''}
   ${live ? `<span class="who muted">${esc(S.user)}</span><button class="btn" data-act="logout">Sair</button>` : `<label class="who">Entrar como <select class="btn" id="role">${[['admin', 'Admin da barbearia'], ...EMPLOYEES.map(e => [e.id, `${e.name} (${e.nick})`])].map(([v, l]) => `<option value="${v}" ${S.role === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`}
   <button class="btn" data-act="bell" aria-expanded="${S.bell}">Avisos${unread ? ` <b class="badge">${unread}</b>` : ''}</button>
   ${live ? '' : `<a class="btn" href="#/reservar" id="to-client">Ver como cliente</a>`}<button class="btn" data-act="theme" id="themebtn">Tema</button>${dash ? '' : `<button class="btn primary" data-act="new">+ Nova marcação</button>`}${S.bell ? `<div class="bellp" role="region" aria-label="Avisos"><div class="dcrow"><b>${live ? 'Avisos no telemóvel' : 'Avisos (simulação do aviso no telemóvel)'}</b><button class="btn" data-act="bell-read">Marcar como lidos</button></div>${pushBlock()}${live ? '<p class="muted">Cada aviso chega ao telemóvel quando uma marcação é criada, mudada ou cancelada.</p>' : mine.length ? `<ul>${mine.slice(0, 12).map(n => `<li class="${n.read ? 'muted' : ''}">${new Date(n.at).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })} · ${isAdmin() ? esc(EMPLOYEES.find(e => e.id === n.employeeId)!.name) + ': ' : ''}${esc(n.text)}</li>`).join('')}</ul>` : '<p class="muted">Sem avisos. Quando uma marcação for criada, mudada ou cancelada, o barbeiro recebe aqui o aviso.</p>'}</div>` : ''}</header>
   <div class="stage">${main}</div>${live ? '' : `<div class="foot">Dados fictícios, guardados só neste ecrã. As regras vêm do motor real de marcações (@rr/domain). Nada é enviado a clientes.</div>`}${drawerHtml()}${modalHtml()}${S.toast ? `<div class="toast" role="status">${esc(S.toast)}</div>` : ''}`;
  const a = document.getElementById('agenda'); if (a) { a.scrollTop = st[0]; a.scrollLeft = st[1]; }
  const nd = document.querySelector<HTMLElement>('.db'); if (nd) nd.scrollTop = dst;
  fillSlots();
  if (M) (document.querySelector('.dlg input, .dlg button.primary') as HTMLElement | null)?.focus();
  const tb = document.getElementById('themebtn'); if (tb) tb.textContent = 'Tema: ' + ({ system: 'sistema', light: 'claro', dark: 'escuro' } as const)[theme()];
}

function pushBlock(): string {
  if (API === undefined) return `<p class="muted pushnote">Na app instalada, cada barbeiro ativa aqui os avisos no telemóvel. Esta demonstração só mostra a simulação.</p>`;
  const m: Record<PushState, string> = {
    unsupported: '<p class="muted pushnote">Este navegador não suporta avisos no telemóvel.</p>',
    'ios-install': '<p class="muted pushnote">No iPhone, instala primeiro a app: toca em Partilhar e depois em "Adicionar ao ecrã principal". Depois abre-a por lá e ativa os avisos.</p>',
    denied: '<p class="muted pushnote">Os avisos estão bloqueados neste navegador. Ativa-os nas definições do site e volta aqui.</p>',
    off: '<div class="pushnote"><button class="btn primary" data-act="push-on">Ativar avisos neste telemóvel</button></div>',
    on: '<div class="pushnote"><span class="pill ok">Avisos ativos neste telemóvel</span> <button class="btn" data-act="push-off">Desativar</button></div>',
  };
  return m[S.push];
}
function theme(): 'system' | 'light' | 'dark' { try { const t = localStorage.getItem('rr-theme'); if (t === 'light' || t === 'dark') return t; } catch {} return 'system'; }
function applyTheme(t: string) { const r = document.documentElement; t === 'system' ? r.removeAttribute('data-theme') : r.setAttribute('data-theme', t); }
applyTheme(theme());

// ---------- Ações ----------
function tryCreate(a: { employeeId: string; date: DateStr; startMin: number; serviceIds: string[]; name: string; phone: string; email: string; cc?: string }, back: Modal) {
  const endMin = a.startMin + store.dur(a.serviceIds, a.employeeId);
  const cs = store.conflicts({ employeeId: a.employeeId, date: a.date, startMin: a.startMin, endMin, serviceIds: a.serviceIds });
  const go = async (force: boolean) => {
    if (live) {
      const r = await live.req('POST', '/hq/bookings', { customer: { name: a.name, phone: joinPhone(a.cc ?? '+351', a.phone), email: a.email || undefined }, employeeId: a.employeeId, date: a.date, startMin: a.startMin, endMin, serviceIds: a.serviceIds, confirmConflicts: force, notify: false });
      if (r.status === 409 && r.json?.error === 'conflito') { M = { kind: 'conflict', conflicts: r.json.conflicts, then: () => go(true), back }; await live.hydrate().catch(() => {}); return render(); }
      M = null; if (r.status === 401) { S.auth = 'out'; return render(); }
      if (r.status !== 200) return toast(errText(r.json));
      await live.hydrate(); S.sel = r.json.bookingId; S.date = a.date; return toast('Marcação criada');
    }
    const c = store.saveCustomer({ name: a.name, cc: a.cc ?? '+351', phone: a.phone, email: a.email }); const b = store.create({ employeeId: a.employeeId, date: a.date, startMin: a.startMin, serviceIds: a.serviceIds, customerId: c.id, withConflicts: force }); S.sel = b.id; S.date = a.date; M = null; toast('Marcação criada'); };
  if (cs.length) { M = { kind: 'conflict', conflicts: cs, then: () => go(true), back }; render(); } else go(false);
}
function tryMove(id: string, emp: string, date: DateStr, start: number, title: string, back: Modal = null) {
  const b = store.bookings.find(x => x.id === id)!;
  if (b.employeeId === emp && b.date === date && b.startMin === start) { render(); return; }
  const cs = store.conflicts({ employeeId: emp, date, startMin: start, endMin: start + (b.endMin - b.startMin), ignoreBookingId: id });
  const ask = () => { M = { kind: 'notify', title, then: n => { if (live) { M = null; D = null; write(live.req('PATCH', `/hq/bookings/${id}`, { employeeId: isAdmin() ? emp : undefined, date, startMin: start, confirmConflicts: true, notify: n }), 'Reagendada'); return; } store.move(id, emp, date, start, n); M = null; D = null; toast(n ? 'Reagendada. Notificação simulada' : 'Reagendada sem notificar'); } }; render(); };
  if (cs.length) { M = { kind: 'conflict', conflicts: cs, then: ask, back }; render(); } else ask();
}
/** Guardar a ficha: cliente (sempre), depois conflitos e notificação quando muda hora/dia/colaborador ou o estado passa a cancelada. */
function saveDraft() {
  const d = D!; const b = store.bookings.find(x => x.id === d.id)!; const c0 = store.customer(b.customerId);
  if (!d.name.trim()) return toast('O nome do cliente é obrigatório');
  const customerChanged = d.name !== c0.name || d.cc !== c0.cc || d.phone !== c0.phone || d.email !== c0.email || d.cnotes !== c0.notes;
  const moved = d.emp !== b.employeeId || d.date !== b.date || d.start !== b.startMin;
  const cancelling = d.status === 'cancelled' && b.status !== 'cancelled';
  const svcChanged = d.svcs.join() !== b.serviceIds.join();
  const endMin = d.start + store.dur(d.svcs, d.emp);
  const apply = (notify: boolean | null) => {
    if (live) {
      const run = async () => {
        if (customerChanged && b.customerId !== 'anon') { const cr = await live.req('PATCH', `/hq/customers/${b.customerId}`, { name: d.name.trim(), phone: joinPhone(d.cc, d.phone), email: d.email.trim(), notes: d.cnotes }); if (cr.status !== 200) { toast(errText(cr.json)); return; } }
        const r = await write(live.req('PATCH', `/hq/bookings/${d.id}`, { employeeId: isAdmin() && d.emp !== b.employeeId ? d.emp : undefined, date: d.date, startMin: d.start, serviceIds: d.svcs, notes: d.notes, status: d.status, confirmConflicts: true, notify: !!notify }), 'Marcação guardada');
        if (r.status === 200) { D = null; render(); }
      };
      M = null; run(); return;
    }
    if (customerChanged) store.saveCustomer({ id: b.customerId, name: d.name.trim(), cc: d.cc, phone: d.phone.trim(), email: d.email.trim(), notes: d.cnotes });
    store.update(d.id, { employeeId: d.emp, date: d.date, startMin: d.start, serviceIds: d.svcs, notes: d.notes, status: d.status, customerChanged }, notify);
    D = null; M = null; toast('Marcação guardada');
  };
  const ask = () => { if (moved || cancelling) { M = { kind: 'notify', title: cancelling ? 'Cancelar marcação' : 'Reagendar marcação', then: n => apply(n) }; render(); } else apply(null); };
  const cs = (moved || svcChanged) && d.status !== 'cancelled' ? store.conflicts({ employeeId: d.emp, date: d.date, startMin: d.start, endMin, serviceIds: d.svcs, ignoreBookingId: d.id }) : [];
  if (cs.length) { M = { kind: 'conflict', conflicts: cs, then: ask, back: null }; render(); } else ask();
}

$app.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  if (t.dataset.scrim === 'drawer') { D = null; return render(); }
  if (live && cfgClick(t, deps)) return;
  const v = t.closest<HTMLElement>('[data-view]'); if (v) { S.view = v.dataset.view as View; render(); if (live && S.view === 'cfg') loadCfg(deps); if (live && S.view === 'mine') { CF.mineEmp = isAdmin() ? S.emp : ''; loadMine(deps); } return; }
  const st = t.closest<HTMLElement>('[data-step]'); if (st) { S.date = addDays(S.date, Number(st.dataset.step)); return render(); }
  const zm = t.closest<HTMLElement>('[data-zoom]'); if (zm) { S.zoom = Math.max(8, Math.min(32, S.zoom + Number(zm.dataset.zoom))); return render(); }
  const el = t.closest<HTMLElement>('[data-act]'); const act = el?.dataset.act; const val = el?.dataset.v;
  if (act === 'slot') { const tt = Number(el!.dataset.t); if (el!.dataset.for === 'd' && D) { D.start = tt; return render(); } const inp = document.getElementById(M?.kind === 'resched' ? 'r-time' : 'f-time') as HTMLInputElement | null; if (inp) { inp.value = fmt(tt); fillSlots(); } return; }
  if (act === 'logout' && live) { stopWatch?.(); stopWatch = null; live.logout().then(() => { S.auth = 'out'; S.loginErr = ''; render(); }); return; }
  if (act === 'today') { S.date = store.today(); return render(); }
  if (act === 'theme') { const n = ({ system: 'light', light: 'dark', dark: 'system' } as const)[theme()]; try { localStorage.setItem('rr-theme', n); } catch {} applyTheme(n); return render(); }
  if (act === 'new') { M = { kind: 'new', name: '', phone: '', email: '', emp: S.emp, date: S.date, start: 600, svcs: ['corte'] }; return render(); }
  if (act === 'push-on' || act === 'push-off') { const f = act === 'push-on' ? enablePush : disablePush; f(API ?? '').then(st => { S.push = st; render(); }).catch(() => toast('Não foi possível ativar os avisos. Confirma a ligação e tenta outra vez.')); return; }
  if (act === 'bell') { S.bell = !S.bell; return render(); }
  if (act === 'bell-read') { store.notes.filter(n => isAdmin() || n.employeeId === S.role).forEach(n => n.read = true); return render(); }
  if (act === 'd-sale' && D) { M = { kind: 'sale', id: D.id }; return render(); }
  const per = t.closest<HTMLElement>('[data-period]'); if (per) { S.period = per.dataset.period as Period; return render(); }
  const wr = t.closest<HTMLElement>('tr[data-who]'); if (wr) { S.dashWho = wr.dataset.who!; return render(); }
  if (act === 'd-close') { D = null; return render(); }
  if (act === 'd-log') { S.showLog = !S.showLog; return render(); }
  if (act === 'd-t' && D) { D.start = Math.max(START, Math.min(END - 10, D.start + Number(val))); return render(); }
  if (act === 'd-add' && D) { D.adding = !D.adding; return render(); }
  if (act === 'd-addsvc' && D) { D.svcs.push(val!); D.adding = false; return render(); }
  if (act === 'd-delsvc' && D) { D.svcs = D.svcs.filter(x => x !== val); return render(); }
  if (act === 'd-del') { M = { kind: 'delete' }; return render(); }
  if (act === 'd-move' && D) { M = { kind: 'resched', id: D.id, emp: D.emp, date: D.date, start: D.start }; return render(); }
  if (act === 'd-copy' && D) { const d = D; D = null; M = { kind: 'new', name: d.name, phone: d.phone, email: d.email, emp: d.emp, date: d.date, start: d.start, svcs: [...d.svcs] }; toast('Cópia: escolhe o novo dia e hora'); return; }
  if (act === 'm-no') { M = M?.kind === 'conflict' ? M.back : null; return render(); }
  if (act === 'm-del' && D) { if (live) { const id = D.id; D = null; M = null; S.sel = null; write(live.req('DELETE', `/hq/bookings/${id}`), 'Marcação apagada'); return; } store.remove(D.id); D = null; M = null; S.sel = null; return toast('Marcação apagada'); }
  if (act === 'm-force' && M?.kind === 'conflict') { const f = M.then; M = null; f(); return; }
  if ((act === 'm-notify' || act === 'm-silent') && M?.kind === 'notify') { const f = M.then; f(act === 'm-notify'); return; }
  const row = t.closest<HTMLElement>('tr[data-id]'); if (row) { openDraft(row.dataset.id!); return render(); }
});
function readSale(f: HTMLElement, id: string) {
  const items: import('@rr/domain').SaleItem[] = [];
  f.querySelectorAll<HTMLInputElement>('input[data-sale=svc]').forEach(i => { const sv = svcOf(i.dataset.id!); items.push({ kind: 'service', refId: sv.id, name: sv.name, qty: 1, unitCents: Math.round(Number(i.value || 0) * 100) }); });
  f.querySelectorAll<HTMLInputElement>('input[data-sale=prod]').forEach(i => { const q = Math.max(0, Math.floor(Number(i.value || 0))); const pr = PRODUCTS.find(z => z.id === i.dataset.id)!; if (q) items.push({ kind: 'product', refId: pr.id, name: pr.name, qty: q, unitCents: pr.price * 100 }); });
  return items;
}
// campos da ficha: atualizam o rascunho sem redesenhar (mantém o foco)
const draftInput = (e: Event) => {
  const t = e.target as HTMLInputElement; const k = t.dataset.k; if (!D || !k) return;
  if (k === 'time') { const [h, m] = t.value.split(':').map(Number); if (!isNaN(h)) D.start = h * 60 + m; }
  else (D as any)[k === 'cnotes' ? 'cnotes' : k] = t.value;
  if (k === 'date' || k === 'time' || k === 'emp') render();
};
$app.addEventListener('input', e => { const sf = (e.target as HTMLElement).closest<HTMLElement>('#salef'); if (sf) { document.getElementById('sale-total')!.textContent = eur(readSale(sf, '').reduce((t, i) => t + i.qty * i.unitCents, 0)); return; } const k = (e.target as HTMLElement).dataset.k; if (k && k !== 'date' && k !== 'time' && k !== 'emp') draftInput(e); });
$app.addEventListener('change', e => { const t = e.target as HTMLSelectElement;
  if (live && cfgChange(t, deps)) return;
  if (t.id === 'role') { S.role = t.value; D = null; M = null; S.sel = null; S.bell = false; if (!isAdmin()) { S.emp = S.role; S.dashWho = S.role; } return render(); }
  if (t.id === 'dwho') { S.dashWho = t.value; return render(); }
  if (t.id === 'emp') { S.emp = t.value; return render(); } if (t.dataset.k) draftInput(e);
  if (['r-date', 'r-emp', 'f-date', 'f-emp'].includes(t.id) || (M?.kind === 'new' && t.name === 'svc')) return fillSlots();
  if (t.id === 'f-name' && M?.kind === 'new') { const c = store.customerByName(t.value); if (c) { (document.getElementById('f-phone') as HTMLInputElement).value = c.phone; (document.getElementById('f-email') as HTMLInputElement).value = c.email; } } });
$app.addEventListener('submit', e => {
  e.preventDefault(); const f = e.target as HTMLFormElement; const v = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
  if (live && f.id === 'loginf') { const u = v('l-user').trim(), pw = v('l-pw'); live.login(u, pw).then(async r => { if (r !== 'ok') { S.loginErr = r === 'credenciais' ? 'Utilizador ou palavra-passe errados.' : r === 'bloqueado' ? 'Demasiadas tentativas. Espera uns minutos.' : 'Não foi possível entrar. Tenta outra vez.'; return render(); } S.loginErr = ''; try { await live.hydrate(); S.auth = 'in'; afterLogin(); startWatch(); } catch { S.loginErr = 'Não foi possível abrir a agenda.'; S.auth = 'out'; } render(); }); return; }
  if (live && cfgSubmit(f, deps)) return;
  if (f.id === 'df') return saveDraft();
  if (f.id === 'salef' && M?.kind === 'sale') { const id = M.id; const items = readSale(f, id); M = null; const pay = (document.getElementById('s-pay') as HTMLSelectElement).value as any; if (live) { write(live.req('POST', `/hq/bookings/${id}/sale`, { payment: pay, items }), 'Atendimento registado'); return; } store.completeSale(id, items, pay); return toast('Atendimento registado'); }
  if (f.id === 'newf') {
    const [h, m] = v('f-time').split(':').map(Number); const svcs = [...f.querySelectorAll<HTMLInputElement>('input[name=svc]:checked')].map(x => x.value);
    if (!svcs.length) return toast('Escolhe pelo menos um serviço');
    if (live && v('f-phone').replace(/\D/g, '').length < 9) return toast('Indica o telefone do cliente (9 dígitos).');
    tryCreate({ employeeId: v('f-emp'), date: v('f-date'), startMin: h * 60 + m, serviceIds: svcs, name: v('f-name').trim(), phone: v('f-phone').trim(), email: v('f-email').trim() }, { kind: 'new', name: v('f-name'), phone: v('f-phone'), email: v('f-email'), emp: v('f-emp'), date: v('f-date'), start: h * 60 + m, svcs });
  }
  if (f.id === 'rf' && M?.kind === 'resched') { const [h, m] = v('r-time').split(':').map(Number); const id = M.id; const emp = v('r-emp'), date = v('r-date'), start = h * 60 + m; M = null; D = null; tryMove(id, emp, date, start, 'Reagendar marcação', null); }
});

// clicar em hora livre, abrir ficha e arrastar marcações
$app.addEventListener('pointerdown', e => {
  const t = e.target as HTMLElement; const blk = t.closest<HTMLElement>('.blk'); const colEl = t.closest<HTMLElement>('.col');
  if (!colEl || D) return;
  const cols = columns(); const ci = Number(colEl.dataset.col); const touch = e.pointerType !== 'mouse';
  const sx = e.clientX, sy = e.clientY;
  // Hora livre: abre a nova marcação só quando o dedo/rato SOBE sem ter andado (assim, arrastar para deslizar a agenda não abre nada).
  if (!blk) {
    if (colEl.classList.contains('closed')) return;
    const end = () => { window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', end); };
    const up = (ev: PointerEvent) => { end(); if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) return;
      const r = colEl.getBoundingClientRect(); const min = START + Math.floor(((ev.clientY - r.top) / S.zoom)) * 10;
      M = { kind: 'new', name: '', phone: '', email: '', emp: cols[ci].emp, date: cols[ci].date, start: Math.max(START, Math.min(END - 10, min)), svcs: ['corte'] }; render(); };
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', end); return;
  }
  // Marcação: toque curto abre a ficha; no telemóvel, para mover é preciso carregar e segurar (~0,4 s) — deslizar normalmente continua a mexer na agenda.
  const id = blk.dataset.id!; const b = store.bookings.find(x => x.id === id)!;
  const top0 = parseFloat(blk.style.top); let drag = false; let armed = !touch; let timer = 0;
  const stopScroll = (ev: TouchEvent) => { if (armed) ev.preventDefault(); };
  const arm = () => { armed = true; blk.classList.add('dragging'); navigator.vibrate?.(15); };
  if (touch) { timer = window.setTimeout(arm, 400); document.addEventListener('touchmove', stopScroll, { passive: false }); }
  const cleanup = () => { clearTimeout(timer); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); document.removeEventListener('touchmove', stopScroll); };
  const move = (ev: PointerEvent) => {
    const far = Math.hypot(ev.clientX - sx, ev.clientY - sy);
    if (!armed) { if (far > 8) { clearTimeout(timer); } return; } // dedo andou antes do tempo: é para deslizar, não para mover
    if (!drag && far < 5) return;
    if (!drag) { drag = true; blk.classList.add('dragging'); try { blk.setPointerCapture(ev.pointerId); } catch { /* ignora */ } }
    blk.style.top = `${top0 + Math.round((ev.clientY - sy) / S.zoom) * S.zoom}px`; blk.style.transform = `translateX(${ev.clientX - sx}px)`;
  };
  const cancel = () => { cleanup(); blk.classList.remove('dragging'); blk.style.transform = ''; blk.style.top = `${top0}px`; };
  const up = (ev: PointerEvent) => {
    cleanup();
    if (!drag) { blk.classList.remove('dragging'); openDraft(id); return render(); }
    const rects = [...document.querySelectorAll<HTMLElement>('.col')].map(c => c.getBoundingClientRect()); let tgt = rects.findIndex(r => ev.clientX >= r.left && ev.clientX <= r.right); if (tgt < 0) tgt = ci;
    const start = Math.max(START, Math.min(END - (b.endMin - b.startMin), START + Math.round((top0 + Math.round((ev.clientY - sy) / S.zoom) * S.zoom) / S.zoom) * 10));
    tryMove(id, cols[tgt].emp, cols[tgt].date, start, 'Mover marcação');
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel);
});
document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (M) { M = M.kind === 'conflict' ? M.back : null; render(); } else if (D) { D = null; render(); } });

const tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true; document.body.appendChild(tip);
document.addEventListener('pointermove', e => { const t = (e.target as Element).closest?.('[data-tip]') as HTMLElement | null; if (!t) { tip.hidden = true; return; } tip.textContent = t.getAttribute('data-tip')!; tip.hidden = false; tip.style.left = Math.min(innerWidth - tip.offsetWidth - 8, e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 14) + 'px'; });
(window as any).__rr = { store, S };
const $book = document.getElementById('booking')!;
function route() { const h = location.hash, client = h.startsWith('#/reservar') || h.startsWith('#/marcacao/'); $app.hidden = client; $book.hidden = !client; if (client && live) { $book.innerHTML = '<div class="login"><div class="card"><div class="brand">ROCK N\' RAZOR<small>MARCAÇÕES</small></div><p>A marcação online está a ser ligada. Volta daqui a pouco.</p></div></div>'; } else if (client) mountBooking($book, store, h); else render(); }
window.addEventListener('hashchange', route); route();
// versão instalável: regista o service worker (só quando a página traz o manifesto e está em http/https)
if (document.querySelector('link[rel=manifest]') && 'serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
/** Atualização em tempo real: lê os dados de novo e redesenha sem tocar no que a pessoa está a escrever ou a arrastar. */
let refreshing = false, again = false, stopWatch: (() => void) | null = null;
async function refresh() {
  if (!live || S.auth !== 'in') return;
  if (refreshing) { again = true; return; }
  if (document.querySelector('.blk.dragging')) { setTimeout(refresh, 1200); return; }
  refreshing = true;
  try { await live.hydrate(); } catch { refreshing = false; return; } // sem rede: tenta no próximo aviso
  refreshing = false;
  const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (!M && !D && !typing && (S.view === 'day' || S.view === 'week' || S.view === 'list' || S.view === 'dash')) render();
  else { const a = document.getElementById('agenda'); if (a) { const st = [a.scrollTop, a.scrollLeft]; a.innerHTML = agendaHtml(); a.scrollTop = st[0]; a.scrollLeft = st[1]; } }
  if (again) { again = false; refresh(); }
}
function startWatch() { stopWatch?.(); stopWatch = live ? live.watch(refresh) : null; }
if (live) { live.start().then(ok => { S.auth = ok ? 'in' : 'out'; if (ok) { afterLogin(); startWatch(); } render(); }).catch(() => { S.auth = 'out'; render(); }); }
if (API !== undefined) pushState().then(st => { S.push = st; render(); });
