import { addDays, weekday, type Conflict, type DateStr } from '@rr/domain';
import { Store, EMPLOYEES, SERVICES, fmt, type B } from './store';

const START = 540, END = 1140;
const store = new Store();
type View = 'day' | 'week' | 'list';
const S = { view: 'day' as View, date: store.today(), emp: 'andre', zoom: 16, sel: null as string | null, modal: '', toast: '' };
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
    const bks = store.bookings.filter(b => b.employeeId === c.emp && b.date === c.date && b.status !== 'cancelled' || (b.employeeId === c.emp && b.date === c.date && b.id === S.sel));
    const ln = lanes(bks);
    const blocks = store.blocks.filter(b => b.employeeId === c.emp && b.date === c.date).map(b => `<div class="blocked" style="top:${((b.startMin! - START) / 10) * z}px;height:${((b.endMin! - b.startMin!) / 10) * z}px;left:2px;right:2px">almoço / indisponível</div>`).join('');
    const bh = bks.map(b => { const [l, n] = ln.get(b.id)!; const w = 88 / n; const svc = SERVICES.find(s => s.id === b.serviceIds[0])!;
      return `<div class="blk ${svc.cls} ${b.status === 'cancelled' ? 'cancelled' : ''} ${S.sel === b.id ? 'sel' : ''}" data-id="${b.id}" style="top:${((b.startMin - START) / 10) * z}px;height:${((b.endMin - b.startMin) / 10) * z - 1}px;left:calc(${l * w}% + 2px);width:calc(${w}% - 4px)"><b>${esc(b.customer)}</b><span class="m">${fmt(b.startMin)}–${fmt(b.endMin)} · ${esc(svcName(b.serviceIds))}</span></div>`; }).join('');
    const nl = c.date === store.today() && nowMin >= START && nowMin <= END ? `<div class="now" style="top:${((nowMin - START) / 10) * z}px"></div>` : '';
    return `<div class="col ${open ? '' : 'closed'}" data-col="${i}" style="height:${H}px;background-size:100% ${z * 6}px">${open ? '' : '<div class="closedmsg">Fechado</div>'}${blocks}${bh}${nl}</div>`;
  }).join('');
  const head = cols.map(c => `<div>${esc(c.label)}${c.sub ? `<small>${esc(c.sub)}</small>` : ''}</div>`).join('');
  return `<div class="head" style="grid-template-columns:${tpl}"><div style="border:0"></div>${head}</div><div class="cols" style="grid-template-columns:${tpl}"><div class="gutter" style="height:${H}px">${gut}</div>${colsHtml}</div>`;
}

function listHtml(): string {
  const days = S.view === 'list' ? [S.date] : [];
  const rows = store.bookings.filter(b => days.includes(b.date)).sort((a, b) => a.startMin - b.startMin);
  return `<div class="list"><table><thead><tr><th>Hora</th><th>Colaborador</th><th>Cliente</th><th>Serviço</th><th>Origem</th><th>Estado</th></tr></thead><tbody>${rows.map(b => `<tr data-id="${b.id}"><td>${fmt(b.startMin)}–${fmt(b.endMin)}</td><td>${esc(empName(b.employeeId))}</td><td>${esc(b.customer)}</td><td>${esc(svcName(b.serviceIds))}</td><td>${b.source === 'online' ? 'Online' : 'HQ'}</td><td><span class="pill ${b.status === 'cancelled' ? 'bad' : 'ok'}">${b.status === 'cancelled' ? 'Cancelada' : 'Confirmada'}</span></td></tr>`).join('') || '<tr><td colspan="6">Sem marcações neste dia.</td></tr>'}</tbody></table></div>`;
}

function panelHtml(): string {
  const b = store.bookings.find(x => x.id === S.sel);
  if (!b) return `<aside class="panel"><h2>Detalhe</h2><p style="color:var(--muted)">Clica numa marcação para ver os dados, reagendar ou cancelar. Arrasta uma marcação para a mover para outra hora ou colaborador. Clica numa hora livre para criar.</p></aside>`;
  return `<aside class="panel" aria-live="polite"><h2>${esc(b.customer)}</h2><span class="pill ${b.status === 'cancelled' ? 'bad' : 'ok'}">${b.status === 'cancelled' ? 'Cancelada' : 'Confirmada'}</span>
  <dl><dt>Serviço</dt><dd>${esc(svcName(b.serviceIds))}</dd><dt>Colaborador</dt><dd>${esc(empName(b.employeeId))}</dd><dt>Dia</dt><dd>${esc(dayLabel(b.date))}</dd><dt>Hora</dt><dd>${fmt(b.startMin)}–${fmt(b.endMin)}</dd><dt>Telefone</dt><dd>${esc(b.phone)}</dd><dt>Origem</dt><dd>${b.source === 'online' ? 'Reserva online' : 'HQ'}</dd></dl>
  ${b.status === 'cancelled' ? '' : `<div class="row"><button class="btn" data-act="resched">Reagendar</button><button class="btn danger" data-act="cancel">Cancelar</button></div>`}
  <h3 style="font-size:13px;margin:16px 0 0">Histórico</h3><ul class="log">${b.log.map(l => `<li>${new Date(l.at).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })} · ${esc(l.text)}</li>`).join('')}</ul></aside>`;
}

function modalHtml(): string {
  const m = M;
  if (!m) return '';
  if (m.kind === 'conflict') return `<div class="scrim"><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="t"><h2 id="t">Conflito de marcações</h2><p>Esta marcação coincide com:</p><ul class="conf">${m.conflicts.map(c => `<li>${confText(c)}</li>`).join('')}</ul><div class="acts"><button class="btn" data-act="m-no">Voltar</button><button class="btn primary" data-act="m-force">Marcar mesmo assim</button></div></div></div>`;
  if (m.kind === 'notify') return `<div class="scrim"><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="t"><h2 id="t">${esc(m.title)}</h2><p>Queres notificar o cliente? (Nesta demonstração nenhuma mensagem é enviada.)</p><div class="acts"><button class="btn" data-act="m-no">Voltar</button><button class="btn" data-act="m-silent">Não notificar</button><button class="btn primary" data-act="m-notify">Notificar cliente</button></div></div></div>`;
  if (m.kind === 'new') return `<div class="scrim"><form class="dlg" id="newf" role="dialog" aria-modal="true" aria-labelledby="t"><h2 id="t">Nova marcação</h2>
    <div class="field"><label for="f-name">Cliente</label><input id="f-name" required placeholder="Nome" value="${esc(m.name)}"></div>
    <div class="two"><div class="field"><label for="f-phone">Telefone</label><input id="f-phone" inputmode="tel" value="${esc(m.phone)}"></div>
    <div class="field"><label for="f-emp">Colaborador</label><select id="f-emp">${EMPLOYEES.map(e => `<option value="${e.id}" ${e.id === m.emp ? 'selected' : ''}>${e.name}</option>`).join('')}</select></div></div>
    <div class="two"><div class="field"><label for="f-date">Dia</label><input id="f-date" type="date" value="${m.date}"></div><div class="field"><label for="f-time">Hora</label><input id="f-time" type="time" step="600" value="${fmt(m.start)}"></div></div>
    <div class="field"><label>Serviços</label><div class="checks">${SERVICES.map(s => `<label><input type="checkbox" name="svc" value="${s.id}" ${m.svcs.includes(s.id) ? 'checked' : ''}>${s.name} · ${s.durationMin} min</label>`).join('')}</div></div>
    <div class="acts"><button type="button" class="btn" data-act="m-no">Cancelar</button><button class="btn primary" type="submit">Criar marcação</button></div></form></div>`;
  if (m.kind === 'resched') return `<div class="scrim"><form class="dlg" id="rf" role="dialog" aria-modal="true" aria-labelledby="t"><h2 id="t">Reagendar</h2><div class="two"><div class="field"><label for="r-date">Dia</label><input id="r-date" type="date" value="${m.date}"></div><div class="field"><label for="r-time">Hora</label><input id="r-time" type="time" step="600" value="${fmt(m.start)}"></div></div><div class="field"><label for="r-emp">Colaborador</label><select id="r-emp">${EMPLOYEES.map(e => `<option value="${e.id}" ${e.id === m.emp ? 'selected' : ''}>${e.name}</option>`).join('')}</select></div><div class="acts"><button type="button" class="btn" data-act="m-no">Voltar</button><button class="btn primary" type="submit">Reagendar</button></div></form></div>`;
  return '';
}
const confText = (c: Conflict) => c.kind === 'overlap' ? `outra marcação (${esc(store.bookings.find(b => b.id === c.with)!.customer)}, ${fmt(store.bookings.find(b => b.id === c.with)!.startMin)})` : c.kind === 'blocked' ? 'um período indisponível do colaborador' : c.kind === 'outside_hours' ? 'horas fora do horário de funcionamento' : c.kind === 'service_not_offered' ? 'um serviço que o colaborador não faz' : 'uma reserva temporária';

type Modal = null
  | { kind: 'conflict'; conflicts: Conflict[]; then: () => void; back: Modal }
  | { kind: 'notify'; title: string; then: (notify: boolean) => void }
  | { kind: 'new'; name: string; phone: string; emp: string; date: DateStr; start: number; svcs: string[] }
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
  $app.innerHTML = `<header class="top"><div class="brand">ROCK N' RAZOR<small>AGENDA · DEMONSTRAÇÃO</small></div>
   <div class="seg" role="group" aria-label="Vista">${(['day', 'week', 'list'] as View[]).map(v => `<button data-view="${v}" aria-pressed="${view === v}">${{ day: 'Dia', week: 'Semana', list: 'Lista' }[v]}</button>`).join('')}</div>
   <button class="btn" data-act="today">Hoje</button><button class="btn icon" data-step="${-step}" aria-label="Anterior">←</button><span class="date">${esc(label)}</span><button class="btn icon" data-step="${step}" aria-label="Seguinte">→</button>${emps}
   <span class="spacer"></span>${view !== 'list' ? `<button class="btn icon" data-zoom="-2" aria-label="Menos zoom">−</button><button class="btn icon" data-zoom="2" aria-label="Mais zoom">+</button>` : ''}
   <button class="btn" data-act="theme" id="themebtn">Tema</button><button class="btn primary" data-act="new">+ Nova marcação</button></header>
   <div class="stage">${main}${panelHtml()}</div><div class="foot">Dados fictícios, guardados só neste ecrã. As regras vêm do motor real de marcações (@rr/domain). Nada é enviado a clientes.</div>${modalHtml()}${S.toast ? `<div class="toast" role="status">${esc(S.toast)}</div>` : ''}`;
  const a = document.getElementById('agenda'); if (a) { a.scrollTop = st[0]; a.scrollLeft = st[1]; }
  if (M) (document.querySelector('.dlg input, .dlg button.primary') as HTMLElement | null)?.focus();
  const tb = document.getElementById('themebtn'); if (tb) tb.textContent = 'Tema: ' + ({ system: 'sistema', light: 'claro', dark: 'escuro' } as const)[theme()];
}

// tema
function theme(): 'system' | 'light' | 'dark' { try { const t = localStorage.getItem('rr-theme'); if (t === 'light' || t === 'dark') return t; } catch {} return 'system'; }
function applyTheme(t: string) { const r = document.documentElement; t === 'system' ? r.removeAttribute('data-theme') : r.setAttribute('data-theme', t); }
applyTheme(theme());

// ações
function tryCreate(a: { employeeId: string; date: DateStr; startMin: number; serviceIds: string[]; customer: string; phone: string }, back: Modal) {
  const endMin = a.startMin + store.dur(a.serviceIds, a.employeeId);
  const cs = store.conflicts({ employeeId: a.employeeId, date: a.date, startMin: a.startMin, endMin, serviceIds: a.serviceIds });
  const go = (force: boolean) => { const b = store.create({ ...a, withConflicts: force }); S.sel = b.id; S.date = a.date; M = null; toast('Marcação criada'); };
  if (cs.length) { M = { kind: 'conflict', conflicts: cs, then: () => go(true), back }; render(); } else go(false);
}
function tryMove(id: string, emp: string, date: DateStr, start: number, title: string, back: Modal = null) {
  const b = store.bookings.find(x => x.id === id)!;
  if (b.employeeId === emp && b.date === date && b.startMin === start) { render(); return; }
  const cs = store.conflicts({ employeeId: emp, date, startMin: start, endMin: start + (b.endMin - b.startMin), ignoreBookingId: id });
  const ask = () => { M = { kind: 'notify', title, then: n => { store.move(id, emp, date, start, n); M = null; toast(n ? 'Reagendada. Notificação simulada' : 'Reagendada sem notificar'); } }; render(); };
  if (cs.length) { M = { kind: 'conflict', conflicts: cs, then: ask, back }; render(); } else ask();
}

$app.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const v = t.closest<HTMLElement>('[data-view]'); if (v) { S.view = v.dataset.view as View; return render(); }
  const st = t.closest<HTMLElement>('[data-step]'); if (st) { S.date = addDays(S.date, Number(st.dataset.step)); return render(); }
  const zm = t.closest<HTMLElement>('[data-zoom]'); if (zm) { S.zoom = Math.max(8, Math.min(32, S.zoom + Number(zm.dataset.zoom))); return render(); }
  const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'today') { S.date = store.today(); return render(); }
  if (act === 'theme') { const n = ({ system: 'light', light: 'dark', dark: 'system' } as const)[theme()]; try { localStorage.setItem('rr-theme', n); } catch {} applyTheme(n); return render(); }
  if (act === 'new') { M = { kind: 'new', name: '', phone: '', emp: S.emp, date: S.date, start: 600, svcs: ['corte'] }; return render(); }
  if (act === 'cancel' && S.sel) { const id = S.sel; M = { kind: 'notify', title: 'Cancelar marcação', then: n => { store.cancel(id, n); M = null; toast(n ? 'Cancelada. Notificação simulada' : 'Cancelada sem notificar'); } }; return render(); }
  if (act === 'resched' && S.sel) { const b = store.bookings.find(x => x.id === S.sel)!; M = { kind: 'resched', id: b.id, emp: b.employeeId, date: b.date, start: b.startMin }; return render(); }
  if (act === 'm-no') { M = M?.kind === 'conflict' ? M.back : null; return render(); }
  if (act === 'm-force' && M?.kind === 'conflict') { const f = M.then; M = null; f(); return; }
  if ((act === 'm-notify' || act === 'm-silent') && M?.kind === 'notify') { const f = M.then; f(act === 'm-notify'); return; }
  const row = t.closest<HTMLElement>('tr[data-id]'); if (row) { S.sel = row.dataset.id!; return render(); }
});
$app.addEventListener('change', e => { const t = e.target as HTMLSelectElement; if (t.id === 'emp') { S.emp = t.value; render(); } });
$app.addEventListener('submit', e => {
  e.preventDefault(); const f = e.target as HTMLFormElement; const v = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
  if (f.id === 'newf') {
    const [h, m] = v('f-time').split(':').map(Number); const svcs = [...f.querySelectorAll<HTMLInputElement>('input[name=svc]:checked')].map(x => x.value);
    if (!svcs.length) return toast('Escolhe pelo menos um serviço');
    tryCreate({ employeeId: v('f-emp'), date: v('f-date'), startMin: h * 60 + m, serviceIds: svcs, customer: v('f-name').trim(), phone: v('f-phone').trim() }, { kind: 'new', name: v('f-name'), phone: v('f-phone'), emp: v('f-emp'), date: v('f-date'), start: h * 60 + m, svcs });
  }
  if (f.id === 'rf' && M?.kind === 'resched') { const [h, m] = v('r-time').split(':').map(Number); const id = M.id; const emp = v('r-emp'), date = v('r-date'), start = h * 60 + m; M = null; tryMove(id, emp, date, start, 'Reagendar marcação', { kind: 'resched', id, emp, date, start }); }
});

// clicar em hora livre, selecionar e arrastar marcações
$app.addEventListener('pointerdown', e => {
  const t = e.target as HTMLElement; const blk = t.closest<HTMLElement>('.blk'); const colEl = t.closest<HTMLElement>('.col');
  if (!colEl) return;
  const cols = columns(); const ci = Number(colEl.dataset.col);
  if (!blk) { if (colEl.classList.contains('closed')) return; const r = colEl.getBoundingClientRect(); const min = START + Math.floor(((e.clientY - r.top) / S.zoom)) * 10;
    M = { kind: 'new', name: '', phone: '', emp: cols[ci].emp, date: cols[ci].date, start: Math.max(START, Math.min(END - 10, min)), svcs: ['corte'] }; return render(); }
  const id = blk.dataset.id!; const b = store.bookings.find(x => x.id === id)!; if (b.status === 'cancelled') { S.sel = id; return render(); }
  const sx = e.clientX, sy = e.clientY, top0 = parseFloat(blk.style.top); let drag = false;
  const colRects = () => [...document.querySelectorAll<HTMLElement>('.col')].map(c => c.getBoundingClientRect());
  const move = (ev: PointerEvent) => {
    if (!drag && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    if (!drag) { drag = true; blk.classList.add('dragging'); blk.setPointerCapture(ev.pointerId); }
    const dy = Math.round((ev.clientY - sy) / S.zoom) * S.zoom; blk.style.top = `${top0 + dy}px`;
    blk.style.transform = `translateX(${ev.clientX - sx}px)`;
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (!drag) { S.sel = id; return render(); }
    const rects = colRects(); let tgt = rects.findIndex(r => ev.clientX >= r.left && ev.clientX <= r.right); if (tgt < 0) tgt = ci;
    const start = Math.max(START, Math.min(END - (b.endMin - b.startMin), START + Math.round((top0 + Math.round((ev.clientY - sy) / S.zoom) * S.zoom) / S.zoom) * 10));
    S.sel = id; tryMove(id, cols[tgt].emp, cols[tgt].date, start, 'Mover marcação');
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && M) { M = null; render(); } });

(window as any).__rr = { store, S };
render();
