import { addDays, weekday, type Conflict, type DateStr } from '@rr/domain';
import { Store, EMPLOYEES, SERVICES, STATUSES, COUNTRY_CODES, fmt, type B } from './store';

const START = 540, END = 1140;
const store = new Store();
type View = 'day' | 'week' | 'list';
const S = { view: 'day' as View, date: store.today(), emp: 'andre', zoom: 16, sel: null as string | null, toast: '', showLog: false };
const $app = document.getElementById('app')!;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const empName = (id: string) => { const e = EMPLOYEES.find(x => x.id === id)!; return `${e.name} (${e.nick})`; };
const svcName = (ids: string[]) => ids.map(i => SERVICES.find(s => s.id === i)!.name).join(' + ');
const dayLabel = (d: DateStr, long = true) => new Intl.DateTimeFormat('pt-PT', { weekday: long ? 'long' : 'short', day: 'numeric', month: long ? 'long' : 'short', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z'));
const monday = (d: DateStr) => addDays(d, -((weekday(d) + 6) % 7));

type Col = { emp: string; date: DateStr; label: string; sub: string };
function columns(): Col[] {
  if (S.view === 'week') return Array.from({ length: 6 }, (_, i) => { const d = addDays(monday(S.date), i); return { emp: S.emp, date: d, label: dayLabel(d, false), sub: empName(S.emp) }; });
  return EMPLOYEES.map(e => ({ emp: e.id, date: S.date, label: `${e.name} (${e.nick})`, sub: '' }));
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
  const tpl = `56px repeat(${cols.length}, minmax(130px, 1fr))`;
  let gut = ''; for (let m = START; m <= END; m += 20) gut += `<span class="${m % 60 === 0 ? 'h' : ''}" style="top:${((m - START) / 10) * z}px">${fmt(m)}</span>`;
  const now = store.nowMs(), nowMin = Math.floor((now - new Date(new Date(now).toDateString()).getTime()) / 60000);
  const colsHtml = cols.map((c, i) => {
    const open = (weekday(c.date) !== 0);
    const bks = store.bookings.filter(b => b.employeeId === c.emp && b.date === c.date && b.status !== 'cancelled');
    const ln = lanes(bks);
    const blocks = store.blocks.filter(b => b.employeeId === c.emp && b.date === c.date).map(b => `<div class="blocked" style="top:${((b.startMin! - START) / 10) * z}px;height:${((b.endMin! - b.startMin!) / 10) * z}px;left:2px;right:2px">almoço / indisponível</div>`).join('');
    const bh = bks.map(b => { const [l, n] = ln.get(b.id)!; const w = 88 / n; const svc = SERVICES.find(s => s.id === b.serviceIds[0])!;
      return `<div class="blk ${svc.cls} ${b.status === 'cancelled' ? 'cancelled' : b.status === 'noshow' ? 'noshow' : ''} ${S.sel === b.id ? 'sel' : ''}" data-id="${b.id}" style="top:${((b.startMin - START) / 10) * z}px;height:${((b.endMin - b.startMin) / 10) * z - 1}px;left:calc(${l * w}% + 2px);width:calc(${w}% - 4px)"><b>${esc(store.customer(b.customerId).name)}</b><span class="m">${fmt(b.startMin)}–${fmt(b.endMin)} · ${esc(svcName(b.serviceIds))}</span></div>`; }).join('');
    const nl = c.date === store.today() && nowMin >= START && nowMin <= END ? `<div class="now" style="top:${((nowMin - START) / 10) * z}px"></div>` : '';
    return `<div class="col ${open ? '' : 'closed'}" data-col="${i}" style="height:${H}px;background-size:100% ${z * 6}px">${open ? '' : '<div class="closedmsg">Fechado</div>'}${blocks}${bh}${nl}</div>`;
  }).join('');
  const head = cols.map(c => `<div>${esc(c.label)}${c.sub ? `<small>${esc(c.sub)}</small>` : ''}</div>`).join('');
  return `<div class="head" style="grid-template-columns:${tpl}"><div style="border:0"></div>${head}</div><div class="cols" style="grid-template-columns:${tpl}"><div class="gutter" style="height:${H}px">${gut}</div>${colsHtml}</div>`;
}

function listHtml(): string {
  const days = S.view === 'list' ? [S.date] : [];
  const rows = store.bookings.filter(b => days.includes(b.date)).sort((a, b) => a.startMin - b.startMin);
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
  const total = store.dur(d.svcs, d.emp), price = d.svcs.reduce((s, id) => s + SERVICES.find(x => x.id === id)!.price, 0);
  const prev = store.previousVisits(b);
  const free = SERVICES.filter(s => !d.svcs.includes(s.id));
  return `<div class="scrim side" data-scrim="drawer"><form class="drawer" id="df" role="dialog" aria-modal="true" aria-labelledby="dt">
   <header class="dh"><h2 id="dt">${esc(EMPLOYEES.find(e => e.id === d.emp)!.name)} @ ${fmt(d.start)} <small>– ${esc(dayLabel(d.date, false))}</small></h2><button type="button" class="btn icon" data-act="d-close" aria-label="Fechar">✕</button></header>
   <div class="db"><section class="dc"><h3>Cliente</h3><div class="card">
     <div class="field"><label for="d-name">Nome</label><input id="d-name" data-k="name" value="${esc(d.name)}" required autocomplete="off"></div>
     <div class="field"><label for="d-phone">Número de telefone</label><div class="phone"><select id="d-cc" data-k="cc" aria-label="Indicativo">${COUNTRY_CODES.map(c => `<option ${c === d.cc ? 'selected' : ''}>${c}</option>`).join('')}</select><input id="d-phone" data-k="phone" inputmode="tel" value="${esc(d.phone)}"></div></div>
     <div class="field"><label for="d-email">Endereço de e-mail</label><input id="d-email" type="email" data-k="email" value="${esc(d.email)}"></div>
     <div class="field"><label for="d-cnotes">Notas do cliente</label><textarea id="d-cnotes" data-k="cnotes" rows="4">${esc(d.cnotes)}</textarea></div></div>
     <p class="hint">Os dados do cliente valem para todas as marcações dele.</p></section>
   <section class="dc"><div class="dcrow"><h3>Marcação</h3><button type="button" class="btn" data-act="d-log" aria-pressed="${S.showLog}">Histórico</button></div>
     <div class="tools"><label class="tool">Estado<select id="d-status" data-k="status">${STATUSES.map(s => `<option value="${s.id}" ${s.id === d.status ? 'selected' : ''}>${s.name}</option>`).join('')}</select></label>
       <button type="button" class="tool" data-act="d-sms" disabled title="Integração futura">SMS</button><button type="button" class="tool" data-act="d-move">Mover</button><button type="button" class="tool" data-act="d-copy">Copiar</button></div>
     <div class="card"><div class="line"><label for="d-date">Data</label><input id="d-date" type="date" data-k="date" value="${d.date}"></div>
       <div class="line"><label for="d-time">Hora</label><span class="stepper"><button type="button" class="btn icon" data-act="d-t" data-v="-10" aria-label="10 minutos antes">−</button><input id="d-time" type="time" step="600" data-k="time" value="${fmt(d.start)}"><button type="button" class="btn icon" data-act="d-t" data-v="10" aria-label="10 minutos depois">+</button></span></div>
       <div class="line"><span>Repetir</span><span class="muted">Nunca</span></div></div>
     <div class="card"><div class="dcrow"><h4>Serviço</h4>${free.length ? `<button type="button" class="btn link" data-act="d-add">+ Adicionar serviço</button>` : ''}</div>
       ${d.adding ? `<div class="addlist">${free.map(s => `<button type="button" class="btn" data-act="d-addsvc" data-v="${s.id}">${esc(s.name)} · ${s.durationMin} min</button>`).join('')}</div>` : ''}
       ${d.svcs.map(id => { const s = SERVICES.find(x => x.id === id)!; return `<div class="svc"><span class="dot ${s.cls}"></span><div><b>${esc(s.name)}</b><div class="muted">${s.durationMin} min · ${euro(s.price)}</div></div>${d.svcs.length > 1 ? `<button type="button" class="btn icon" data-act="d-delsvc" data-v="${id}" aria-label="Remover ${esc(s.name)}">🗑</button>` : ''}</div>`; }).join('')}
       <p class="muted" style="margin:8px 0 0">Total: <b>${total} minutos</b> · ${euro(price)} · termina às ${fmt(d.start + total)}</p></div>
     <div class="card"><div class="line"><label for="d-emp">Colaborador</label><select id="d-emp" data-k="emp">${EMPLOYEES.map(e => `<option value="${e.id}" ${e.id === d.emp ? 'selected' : ''}>${esc(e.name)} (${esc(e.nick)})</option>`).join('')}</select></div></div>
     <div class="card"><div class="field" style="margin:0"><label for="d-notes">Notas</label><textarea id="d-notes" data-k="notes" rows="3">${esc(d.notes)}</textarea></div></div>
     <p class="hint">Marcação criada ${new Date(b.createdAt).toLocaleDateString('pt-PT')} ${new Date(b.createdAt).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })} ${b.source === 'online' ? 'pela reserva online' : 'no HQ'}.</p>
     ${S.showLog ? `<ul class="log">${b.log.map(l => `<li>${new Date(l.at).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })} · ${esc(l.text)}</li>`).join('')}</ul>` : ''}
     <h3 style="margin-top:20px">Visitas anteriores</h3>${prev.map(p => `<div class="visit"><div><b>${esc(svcName(p.serviceIds))}</b><div class="muted">Colaborador: ${esc(empName(p.employeeId))}</div></div><div class="muted r">${dd(p.date)}<br>${fmt(p.startMin)}</div></div>`).join('') || '<p class="muted">Sem visitas anteriores.</p>'}</section></div>
   <footer class="df"><button type="button" class="btn danger solid" data-act="d-del">Apagar</button><span class="spacer"></span><button class="btn primary big" type="submit">Guardar</button></footer></form></div>`;
}

function modalHtml(): string {
  const m = M; if (!m) return '';
  const shell = (title: string, body: string, acts: string) => `<div class="scrim"><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="t"><h2 id="t">${title}</h2>${body}<div class="acts">${acts}</div></div></div>`;
  if (m.kind === 'conflict') return shell('Conflito de marcações', `<p>Esta marcação coincide com:</p><ul class="conf">${m.conflicts.map(c => `<li>${confText(c)}</li>`).join('')}</ul>`, `<button class="btn" data-act="m-no">Voltar</button><button class="btn primary" data-act="m-force">Marcar mesmo assim</button>`);
  if (m.kind === 'notify') return shell(esc(m.title), `<p>Queres notificar o cliente? (Nesta demonstração nenhuma mensagem é enviada.)</p>`, `<button class="btn" data-act="m-no">Voltar</button><button class="btn" data-act="m-silent">Não notificar</button><button class="btn primary" data-act="m-notify">Notificar cliente</button>`);
  if (m.kind === 'delete') return shell('Apagar marcação', `<p>Esta marcação desaparece da agenda e do histórico. Não se pode desfazer.</p>`, `<button class="btn" data-act="m-no">Voltar</button><button class="btn danger solid" data-act="m-del">Apagar</button>`);
  if (m.kind === 'new') return `<div class="scrim"><form class="dlg" id="newf" role="dialog" aria-modal="true" aria-labelledby="t"><h2 id="t">Nova marcação</h2>
    <div class="field"><label for="f-name">Cliente</label><input id="f-name" list="clients" required autocomplete="off" placeholder="Nome (escolhe um existente ou escreve um novo)" value="${esc(m.name)}"><datalist id="clients">${store.customers.map(c => `<option value="${esc(c.name)}"></option>`).join('')}</datalist></div>
    <div class="two"><div class="field"><label for="f-phone">Telefone</label><input id="f-phone" inputmode="tel" value="${esc(m.phone)}"></div><div class="field"><label for="f-email">E-mail</label><input id="f-email" type="email" value="${esc(m.email)}"></div></div>
    <div class="two"><div class="field"><label for="f-emp">Colaborador</label><select id="f-emp">${EMPLOYEES.map(e => `<option value="${e.id}" ${e.id === m.emp ? 'selected' : ''}>${e.name}</option>`).join('')}</select></div><div class="field"><label for="f-date">Dia</label><input id="f-date" type="date" value="${m.date}"></div></div>
    <div class="field"><label for="f-time">Hora</label><input id="f-time" type="time" step="600" value="${fmt(m.start)}"></div>
    <div class="field"><label>Serviços</label><div class="checks">${SERVICES.map(s => `<label><input type="checkbox" name="svc" value="${s.id}" ${m.svcs.includes(s.id) ? 'checked' : ''}>${s.name} · ${s.durationMin} min</label>`).join('')}</div></div>
    <div class="acts"><button type="button" class="btn" data-act="m-no">Cancelar</button><button class="btn primary" type="submit">Criar marcação</button></div></form></div>`;
  if (m.kind === 'resched') return `<div class="scrim"><form class="dlg" id="rf" role="dialog" aria-modal="true" aria-labelledby="t"><h2 id="t">Mover marcação</h2><div class="two"><div class="field"><label for="r-date">Dia</label><input id="r-date" type="date" value="${m.date}"></div><div class="field"><label for="r-time">Hora</label><input id="r-time" type="time" step="600" value="${fmt(m.start)}"></div></div><div class="field"><label for="r-emp">Colaborador</label><select id="r-emp">${EMPLOYEES.map(e => `<option value="${e.id}" ${e.id === m.emp ? 'selected' : ''}>${e.name}</option>`).join('')}</select></div><div class="acts"><button type="button" class="btn" data-act="m-no">Voltar</button><button class="btn primary" type="submit">Mover</button></div></form></div>`;
  return '';
}
const confText = (c: Conflict) => { const o = c.kind === 'overlap' ? store.bookings.find(b => b.id === c.with) : undefined; return c.kind === 'overlap' ? `outra marcação (${esc(store.customer(o!.customerId).name)}, ${fmt(o!.startMin)})` : c.kind === 'blocked' ? 'um período indisponível do colaborador' : c.kind === 'outside_hours' ? 'horas fora do horário de funcionamento' : c.kind === 'service_not_offered' ? 'um serviço que o colaborador não faz' : 'uma reserva temporária'; };

type Modal = null
  | { kind: 'conflict'; conflicts: Conflict[]; then: () => void; back: Modal }
  | { kind: 'notify'; title: string; then: (notify: boolean) => void }
  | { kind: 'delete' }
  | { kind: 'new'; name: string; phone: string; email: string; emp: string; date: DateStr; start: number; svcs: string[] }
  | { kind: 'resched'; id: string; emp: string; date: DateStr; start: number };
let M: Modal = null;

function toast(t: string) { S.toast = t; render(); setTimeout(() => { if (S.toast === t) { S.toast = ''; render(); } }, 3200); }

function render() {
  const view = S.view;
  const emps = view === 'week' ? `<select class="btn" id="emp" aria-label="Colaborador">${EMPLOYEES.map(e => `<option value="${e.id}" ${e.id === S.emp ? 'selected' : ''}>${e.name} (${e.nick})</option>`).join('')}</select>` : '';
  const label = view === 'week' ? `${dayLabel(monday(S.date), false)} – ${dayLabel(addDays(monday(S.date), 5), false)}` : dayLabel(S.date);
  const step = view === 'week' ? 7 : 1;
  const main = view === 'list' ? listHtml() : `<div class="agenda" id="agenda">${agendaHtml()}</div>`;
  const keep = document.getElementById('agenda'); const st = keep ? [keep.scrollTop, keep.scrollLeft] : [0, 0];
  const dr = document.querySelector<HTMLElement>('.db'); const dst = dr ? dr.scrollTop : 0;
  $app.innerHTML = `<header class="top"><div class="brand">ROCK N' RAZOR<small>AGENDA · DEMONSTRAÇÃO</small></div>
   <div class="seg" role="group" aria-label="Vista">${(['day', 'week', 'list'] as View[]).map(v => `<button data-view="${v}" aria-pressed="${view === v}">${{ day: 'Dia', week: 'Semana', list: 'Lista' }[v]}</button>`).join('')}</div>
   <button class="btn" data-act="today">Hoje</button><button class="btn icon" data-step="${-step}" aria-label="Anterior">←</button><span class="date">${esc(label)}</span><button class="btn icon" data-step="${step}" aria-label="Seguinte">→</button>${emps}
   <span class="spacer"></span>${view !== 'list' ? `<button class="btn icon" data-zoom="-2" aria-label="Menos zoom">−</button><button class="btn icon" data-zoom="2" aria-label="Mais zoom">+</button>` : ''}
   <button class="btn" data-act="theme" id="themebtn">Tema</button><button class="btn primary" data-act="new">+ Nova marcação</button></header>
   <div class="stage">${main}</div><div class="foot">Dados fictícios, guardados só neste ecrã. As regras vêm do motor real de marcações (@rr/domain). Nada é enviado a clientes.</div>${drawerHtml()}${modalHtml()}${S.toast ? `<div class="toast" role="status">${esc(S.toast)}</div>` : ''}`;
  const a = document.getElementById('agenda'); if (a) { a.scrollTop = st[0]; a.scrollLeft = st[1]; }
  const nd = document.querySelector<HTMLElement>('.db'); if (nd) nd.scrollTop = dst;
  if (M) (document.querySelector('.dlg input, .dlg button.primary') as HTMLElement | null)?.focus();
  const tb = document.getElementById('themebtn'); if (tb) tb.textContent = 'Tema: ' + ({ system: 'sistema', light: 'claro', dark: 'escuro' } as const)[theme()];
}

function theme(): 'system' | 'light' | 'dark' { try { const t = localStorage.getItem('rr-theme'); if (t === 'light' || t === 'dark') return t; } catch {} return 'system'; }
function applyTheme(t: string) { const r = document.documentElement; t === 'system' ? r.removeAttribute('data-theme') : r.setAttribute('data-theme', t); }
applyTheme(theme());

// ---------- Ações ----------
function tryCreate(a: { employeeId: string; date: DateStr; startMin: number; serviceIds: string[]; name: string; phone: string; email: string; cc?: string }, back: Modal) {
  const endMin = a.startMin + store.dur(a.serviceIds, a.employeeId);
  const cs = store.conflicts({ employeeId: a.employeeId, date: a.date, startMin: a.startMin, endMin, serviceIds: a.serviceIds });
  const go = (force: boolean) => { const c = store.saveCustomer({ name: a.name, cc: a.cc ?? '+351', phone: a.phone, email: a.email }); const b = store.create({ employeeId: a.employeeId, date: a.date, startMin: a.startMin, serviceIds: a.serviceIds, customerId: c.id, withConflicts: force }); S.sel = b.id; S.date = a.date; M = null; toast('Marcação criada'); };
  if (cs.length) { M = { kind: 'conflict', conflicts: cs, then: () => go(true), back }; render(); } else go(false);
}
function tryMove(id: string, emp: string, date: DateStr, start: number, title: string, back: Modal = null) {
  const b = store.bookings.find(x => x.id === id)!;
  if (b.employeeId === emp && b.date === date && b.startMin === start) { render(); return; }
  const cs = store.conflicts({ employeeId: emp, date, startMin: start, endMin: start + (b.endMin - b.startMin), ignoreBookingId: id });
  const ask = () => { M = { kind: 'notify', title, then: n => { store.move(id, emp, date, start, n); M = null; D = null; toast(n ? 'Reagendada. Notificação simulada' : 'Reagendada sem notificar'); } }; render(); };
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
  const v = t.closest<HTMLElement>('[data-view]'); if (v) { S.view = v.dataset.view as View; return render(); }
  const st = t.closest<HTMLElement>('[data-step]'); if (st) { S.date = addDays(S.date, Number(st.dataset.step)); return render(); }
  const zm = t.closest<HTMLElement>('[data-zoom]'); if (zm) { S.zoom = Math.max(8, Math.min(32, S.zoom + Number(zm.dataset.zoom))); return render(); }
  const el = t.closest<HTMLElement>('[data-act]'); const act = el?.dataset.act; const val = el?.dataset.v;
  if (act === 'today') { S.date = store.today(); return render(); }
  if (act === 'theme') { const n = ({ system: 'light', light: 'dark', dark: 'system' } as const)[theme()]; try { localStorage.setItem('rr-theme', n); } catch {} applyTheme(n); return render(); }
  if (act === 'new') { M = { kind: 'new', name: '', phone: '', email: '', emp: S.emp, date: S.date, start: 600, svcs: ['corte'] }; return render(); }
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
  if (act === 'm-del' && D) { store.remove(D.id); D = null; M = null; S.sel = null; return toast('Marcação apagada'); }
  if (act === 'm-force' && M?.kind === 'conflict') { const f = M.then; M = null; f(); return; }
  if ((act === 'm-notify' || act === 'm-silent') && M?.kind === 'notify') { const f = M.then; f(act === 'm-notify'); return; }
  const row = t.closest<HTMLElement>('tr[data-id]'); if (row) { openDraft(row.dataset.id!); return render(); }
});
// campos da ficha: atualizam o rascunho sem redesenhar (mantém o foco)
const draftInput = (e: Event) => {
  const t = e.target as HTMLInputElement; const k = t.dataset.k; if (!D || !k) return;
  if (k === 'time') { const [h, m] = t.value.split(':').map(Number); if (!isNaN(h)) D.start = h * 60 + m; }
  else (D as any)[k === 'cnotes' ? 'cnotes' : k] = t.value;
  if (k === 'date' || k === 'time' || k === 'emp') render();
};
$app.addEventListener('input', e => { const k = (e.target as HTMLElement).dataset.k; if (k && k !== 'date' && k !== 'time' && k !== 'emp') draftInput(e); });
$app.addEventListener('change', e => { const t = e.target as HTMLSelectElement; if (t.id === 'emp') { S.emp = t.value; return render(); } if (t.dataset.k) draftInput(e);
  if (t.id === 'f-name' && M?.kind === 'new') { const c = store.customerByName(t.value); if (c) { (document.getElementById('f-phone') as HTMLInputElement).value = c.phone; (document.getElementById('f-email') as HTMLInputElement).value = c.email; } } });
$app.addEventListener('submit', e => {
  e.preventDefault(); const f = e.target as HTMLFormElement; const v = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
  if (f.id === 'df') return saveDraft();
  if (f.id === 'newf') {
    const [h, m] = v('f-time').split(':').map(Number); const svcs = [...f.querySelectorAll<HTMLInputElement>('input[name=svc]:checked')].map(x => x.value);
    if (!svcs.length) return toast('Escolhe pelo menos um serviço');
    tryCreate({ employeeId: v('f-emp'), date: v('f-date'), startMin: h * 60 + m, serviceIds: svcs, name: v('f-name').trim(), phone: v('f-phone').trim(), email: v('f-email').trim() }, { kind: 'new', name: v('f-name'), phone: v('f-phone'), email: v('f-email'), emp: v('f-emp'), date: v('f-date'), start: h * 60 + m, svcs });
  }
  if (f.id === 'rf' && M?.kind === 'resched') { const [h, m] = v('r-time').split(':').map(Number); const id = M.id; const emp = v('r-emp'), date = v('r-date'), start = h * 60 + m; M = null; D = null; tryMove(id, emp, date, start, 'Reagendar marcação', null); }
});

// clicar em hora livre, abrir ficha e arrastar marcações
$app.addEventListener('pointerdown', e => {
  const t = e.target as HTMLElement; const blk = t.closest<HTMLElement>('.blk'); const colEl = t.closest<HTMLElement>('.col');
  if (!colEl || D) return;
  const cols = columns(); const ci = Number(colEl.dataset.col);
  if (!blk) { if (colEl.classList.contains('closed')) return; const r = colEl.getBoundingClientRect(); const min = START + Math.floor(((e.clientY - r.top) / S.zoom)) * 10;
    M = { kind: 'new', name: '', phone: '', email: '', emp: cols[ci].emp, date: cols[ci].date, start: Math.max(START, Math.min(END - 10, min)), svcs: ['corte'] }; return render(); }
  const id = blk.dataset.id!; const b = store.bookings.find(x => x.id === id)!;
  const sx = e.clientX, sy = e.clientY, top0 = parseFloat(blk.style.top); let drag = false;
  const move = (ev: PointerEvent) => {
    if (!drag && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    if (!drag) { drag = true; blk.classList.add('dragging'); blk.setPointerCapture(ev.pointerId); }
    blk.style.top = `${top0 + Math.round((ev.clientY - sy) / S.zoom) * S.zoom}px`; blk.style.transform = `translateX(${ev.clientX - sx}px)`;
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (!drag) { openDraft(id); return render(); }
    const rects = [...document.querySelectorAll<HTMLElement>('.col')].map(c => c.getBoundingClientRect()); let tgt = rects.findIndex(r => ev.clientX >= r.left && ev.clientX <= r.right); if (tgt < 0) tgt = ci;
    const start = Math.max(START, Math.min(END - (b.endMin - b.startMin), START + Math.round((top0 + Math.round((ev.clientY - sy) / S.zoom) * S.zoom) / S.zoom) * 10));
    tryMove(id, cols[tgt].emp, cols[tgt].date, start, 'Mover marcação');
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
});
document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (M) { M = M.kind === 'conflict' ? M.back : null; render(); } else if (D) { D = null; render(); } });

(window as any).__rr = { store, S };
render();
