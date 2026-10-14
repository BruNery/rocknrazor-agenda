import { addDays, todayLocal, weekday, canCancelOrReschedule, type DateStr } from '@rr/domain';
import { Store, EMPLOYEES, SERVICES, COUNTRY_CODES, HOLD_MS, MAX_OPEN_ONLINE, fmt, type OnlineError } from './store';

/** Booking público da Rock n' Razor. Mesmas regras do motor (@rr/domain): só mostra horas realmente livres. */
type Step = 'services' | 'barber' | 'time' | 'details' | 'done';
interface W { step: Step; svcs: string[]; emp: string; date: DateStr | ''; start: number | null; days: number; avail: Record<string, number>; name: string; cc: string; phone: string; email: string; consent: boolean; holdId?: string; holdEmp?: string; holdUntil?: number; token?: string; error: string }
interface Mg { token: string; mode: 'view' | 'resched' | 'cancelled' | 'moved'; date: DateStr | ''; start: number | null; days: number; avail: Record<string, number>; confirmCancel: boolean; error: string }

const ERR: Record<OnlineError, string> = {
  dados_invalidos: 'Confirma o nome e o telefone (pelo menos 9 números).',
  sem_consentimento: 'Para marcar, precisamos da tua autorização para guardar o nome e o telefone.',
  indisponivel: 'Esse horário acabou de ser ocupado. Escolhe outro, por favor.',
  limite_marcacoes: `Já tens ${MAX_OPEN_ONLINE} marcações em aberto com este número. Cancela uma ou fala com a barbearia.`,
  fora_do_prazo: 'Já não é possível alterar online (menos de 3 horas para a marcação). Fala com a barbearia.',
  nao_encontrada: 'Não encontrámos esta marcação.',
  ja_cancelada: 'Esta marcação já foi cancelada.',
};
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const euro = (n: number) => `€ ${n.toFixed(2).replace('.', ',')}`;
const dayLong = (d: DateStr) => new Intl.DateTimeFormat('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z'));
const wk = (d: DateStr) => new Intl.DateTimeFormat('pt-PT', { weekday: 'short', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z')).replace('.', '');
const empLabel = (id: string) => { const e = EMPLOYEES.find(x => x.id === id)!; return `${e.name} (${e.nick})`; };
const svcNames = (ids: string[]) => ids.map(i => SERVICES.find(s => s.id === i)!.name).join(' + ');
const total = (ids: string[]) => ({ min: ids.reduce((t, i) => t + SERVICES.find(s => s.id === i)!.durationMin, 0), price: ids.reduce((t, i) => t + SERVICES.find(s => s.id === i)!.price, 0) });

let root: HTMLElement, store: Store, w: W, mg: Mg | null = null, ticker: number | undefined, lastKey = '';
const fresh = (q: URLSearchParams): W => {
  const emp = q.get('barbeiro') ?? 'any';
  return { step: 'services', svcs: [], emp: EMPLOYEES.some(e => e.id === emp) ? emp : 'any', date: '', start: null, days: 14, avail: {}, name: '', cc: '+351', phone: (q.get('tel') ?? '').slice(0, 20), email: '', consent: false, error: '' };
};
const empArg = (e: string) => (e === 'any' ? undefined : e);

export function mountBooking(el: HTMLElement, st: Store, hash: string) {
  const first = !root; root = el; store = st;
  const [path, qs = ''] = hash.replace(/^#/, '').split('?'); const q = new URLSearchParams(qs);
  if (first) { el.addEventListener('click', onClick); el.addEventListener('change', onChange); el.addEventListener('input', onInput); el.addEventListener('submit', onSubmit); }
  const key = path;
  if (path.startsWith('/marcacao/')) { if (key !== lastKey) mg = { token: path.slice('/marcacao/'.length), mode: 'view', date: '', start: null, days: 14, avail: {}, confirmCancel: false, error: '' }; }
  else { if (w && w.holdId) store.release(w.holdId); mg = null; if (key !== lastKey || !w) w = fresh(q); }
  lastKey = key; render();
}

function stepNav(): string {
  const order: [Step, string][] = [['services', 'Serviços'], ['barber', 'Barbeiro'], ['time', 'Hora'], ['details', 'Dados']];
  const idx = order.findIndex(o => o[0] === w.step);
  return `<ol class="bk-steps" aria-label="Passos">${order.map((o, i) => `<li ${i === idx ? 'aria-current="step"' : ''} class="${i < idx ? 'done' : ''}"><span>${i + 1}</span>${o[1]}</li>`).join('')}</ol>`;
}

/** Faixa de dias + horas livres. `ignore` serve ao reagendamento (a própria marcação não bloqueia). */
function picker(svcs: string[], emp: string, date: DateStr | '', start: number | null, days: number, avail: Record<string, number>): string {
  const today = todayLocal(store.nowMs());
  const strip = Array.from({ length: days }, (_, i) => addDays(today, i)).map(d => {
    const n = avail[d] ?? 0, closed = weekday(d) === 0;
    return `<button type="button" class="bk-day" data-act="day" data-v="${d}" aria-pressed="${date === d}" ${n ? '' : 'disabled'} aria-label="${esc(dayLong(d))}${n ? '' : closed ? ', fechado' : ', sem horas livres'}"><small>${wk(d)}</small><b>${Number(d.slice(8))}</b></button>`;
  }).join('');
  const more = days < 57 ? `<button type="button" class="bk-more" data-act="more">Mais dias ›</button>` : '';
  let slots = '';
  if (date) {
    const list = store.availability(date, svcs, empArg(emp), mg?.token ? store.byToken(mg.token)?.id : undefined);
    const groups: [string, number, number][] = [['Manhã', 0, 720], ['Tarde', 720, 1020], ['Fim do dia', 1020, 1441]];
    slots = `<h2 class="bk-h2">${esc(dayLong(date))}</h2>` + (list.length ? groups.map(([t, a, b]) => { const g = list.filter(s => s.startMin >= a && s.startMin < b); return g.length ? `<h3 class="bk-h3">${t}</h3><div class="bk-slots">${g.map(s => `<button type="button" class="bk-slot" data-act="slot" data-v="${s.startMin}" aria-pressed="${start === s.startMin}">${fmt(s.startMin)}</button>`).join('')}</div>` : ''; }).join('') : '<p class="bk-muted">Sem horas livres neste dia.</p>');
  } else {
    const nextD = Array.from({ length: days }, (_, i) => addDays(today, i)).find(d => (avail[d] ?? 0) > 0);
    slots = nextD ? `<p class="bk-muted">Próximo dia com horas livres: <button type="button" class="bk-link" data-act="day" data-v="${nextD}">${esc(dayLong(nextD))}</button></p>` : '<p class="bk-muted">Sem horas livres nas próximas semanas. Fala com a barbearia.</p>';
  }
  return `<div class="bk-strip" role="group" aria-label="Dias">${strip}${more}</div>${slots}`;
}
const computeAvail = (svcs: string[], emp: string, days: number, ignore?: string) => { const t = todayLocal(store.nowMs()); const o: Record<string, number> = {}; for (let i = 0; i < days; i++) { const d = addDays(t, i); o[d] = store.availability(d, svcs, empArg(emp), ignore).length; } return o; };

function summary(svcs: string[], emp: string, date?: DateStr | '', start?: number | null): string {
  const t = total(svcs);
  return `<dl class="bk-sum"><div><dt>Serviços</dt><dd>${esc(svcNames(svcs))}</dd></div>${emp !== 'any' ? `<div><dt>Barbeiro</dt><dd>${esc(empLabel(emp))}</dd></div>` : ''}${date && start != null ? `<div><dt>Quando</dt><dd>${esc(dayLong(date))}, ${fmt(start)}</dd></div>` : ''}<div><dt>Duração e preço</dt><dd>${t.min} min · ${euro(t.price)}</dd></div></dl>`;
}

function shell(inner: string, bar = ''): string {
  return `<header class="bk-top"><div class="brand">ROCK N' RAZOR<small>MARCAÇÕES</small></div><button type="button" class="bk-theme" data-act="theme" aria-label="Mudar tema">Tema</button></header><main class="bk-main">${inner}</main>${bar}<footer class="bk-foot">Demonstração: nenhuma mensagem é enviada. <a href="#/">Abrir a agenda (HQ)</a></footer>`;
}
const bar = (left: string, btn: string) => `<div class="bk-bar"><div>${left}</div>${btn}</div>`;

function render() {
  const keepY = window.scrollY;
  if (mg) renderManage(); else renderWizard();
  const key = mg ? `m:${mg.mode}` : `w:${w.step}`; const h = root.querySelector<HTMLElement>('h1'); if (h && key !== renderedKey) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  renderedKey = key; window.scrollTo(0, keepY);
  clearInterval(ticker); if (!mg && w.step === 'details') ticker = window.setInterval(tick, 1000) as unknown as number;
}
let renderedKey = '';
function tick() {
  if (!w.holdUntil) return; const left = w.holdUntil - store.nowMs(); const e = document.getElementById('hold-left');
  if (left <= 0) { store.release(w.holdId); w.holdId = undefined; w.holdUntil = undefined; w.start = null; w.step = 'time'; w.avail = computeAvail(w.svcs, w.emp, w.days); w.error = 'O tempo da reserva acabou. Escolhe a hora outra vez.'; return render(); }
  if (e) e.textContent = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
}

function renderWizard() {
  const t = total(w.svcs); const err = w.error ? `<p class="bk-err" role="alert">${esc(w.error)}</p>` : '';
  if (w.step === 'services') {
    root.innerHTML = shell(`${stepNav()}<h1 class="bk-h1">Escolhe os serviços</h1>${err}<div class="bk-list">${SERVICES.map(s => `<label class="bk-card ${w.svcs.includes(s.id) ? 'on' : ''}"><input type="checkbox" name="svc" value="${s.id}" ${w.svcs.includes(s.id) ? 'checked' : ''}><span class="dot ${s.cls}"></span><span class="grow"><b>${esc(s.name)}</b><small>${s.durationMin} min</small></span><span class="price">${euro(s.price)}</span></label>`).join('')}</div>`,
      bar(w.svcs.length ? `<b>${t.min} min · ${euro(t.price)}</b>` : '<span class="bk-muted">Escolhe pelo menos um serviço</span>', `<button class="bk-btn" data-act="to-barber" ${w.svcs.length ? '' : 'disabled'}>Continuar</button>`));
  } else if (w.step === 'barber') {
    const opt = (id: string, name: string, sub: string) => `<label class="bk-card ${w.emp === id ? 'on' : ''}"><input type="radio" name="emp" value="${id}" ${w.emp === id ? 'checked' : ''}><span class="grow"><b>${esc(name)}</b><small>${esc(sub)}</small></span></label>`;
    root.innerHTML = shell(`${stepNav()}<button class="bk-back" data-act="back">‹ Voltar</button><h1 class="bk-h1">Com quem queres marcar?</h1>${err}<div class="bk-list">${opt('any', 'Qualquer barbeiro', 'Mostramos todas as horas livres da equipa')}${EMPLOYEES.map(e => opt(e.id, `${e.name} (${e.nick})`, 'Barbeiro')).join('')}</div>`,
      bar(`<b>${t.min} min · ${euro(t.price)}</b>`, `<button class="bk-btn" data-act="to-time">Continuar</button>`));
  } else if (w.step === 'time') {
    root.innerHTML = shell(`${stepNav()}<button class="bk-back" data-act="back">‹ Voltar</button><h1 class="bk-h1">Escolhe o dia e a hora</h1>${err}<p class="bk-muted">${esc(svcNames(w.svcs))} · ${w.emp === 'any' ? 'qualquer barbeiro' : esc(empLabel(w.emp))}</p>${picker(w.svcs, w.emp, w.date, w.start, w.days, w.avail)}`);
  } else if (w.step === 'details') {
    root.innerHTML = shell(`${stepNav()}<button class="bk-back" data-act="back">‹ Voltar</button><h1 class="bk-h1">Os teus dados</h1>${err}${summary(w.svcs, w.holdEmp ?? w.emp, w.date, w.start)}<p class="bk-hold">Guardámos esta hora para ti durante <b id="hold-left">${Math.floor(HOLD_MS / 60000)}:00</b>.</p>
      <form id="bkf" class="bk-form" novalidate><label>Nome<input name="name" value="${esc(w.name)}" autocomplete="name" required></label>
        <label>Telemóvel<span class="bk-phone"><select name="cc" aria-label="Indicativo">${COUNTRY_CODES.map(c => `<option ${c === w.cc ? 'selected' : ''}>${c}</option>`).join('')}</select><input name="phone" inputmode="tel" autocomplete="tel-national" value="${esc(w.phone)}" required></span></label>
        <label>E-mail <small>(opcional)</small><input name="email" type="email" autocomplete="email" value="${esc(w.email)}"></label>
        <label class="bk-check"><input type="checkbox" name="consent" ${w.consent ? 'checked' : ''}><span>Autorizo a Rock n' Razor a guardar o meu nome e telefone para gerir esta marcação e avisar-me sobre ela.</span></label>
        <button class="bk-btn wide" type="submit">Confirmar marcação</button></form>`);
  } else {
    const b = store.byToken(w.token!)!;
    root.innerHTML = shell(`<div class="bk-ok" role="status"><span class="tick" aria-hidden="true">✓</span><h1 class="bk-h1">Marcação confirmada</h1></div>${summary(b.serviceIds, b.employeeId, b.date, b.startMin)}<p class="bk-muted">Barbeiro: <b>${esc(empLabel(b.employeeId))}</b>. Podes cancelar ou mudar a hora até 3 horas antes.</p><p><a class="bk-btn" href="#/marcacao/${b.token}">Ver ou alterar a marcação</a></p><p><button type="button" class="bk-link" data-act="again">Fazer outra marcação</button></p>`);
  }
}

function renderManage() {
  const m = mg!; const b = store.byToken(m.token);
  if (!b) { root.innerHTML = shell(`<h1 class="bk-h1">Marcação não encontrada</h1><p class="bk-muted">O link pode estar incompleto. Fala com a barbearia.</p><p><a class="bk-link" href="#/reservar">Fazer uma marcação</a></p>`); return; }
  const err = m.error ? `<p class="bk-err" role="alert">${esc(m.error)}</p>` : '';
  if (m.mode === 'cancelled' || b.status === 'cancelled') { root.innerHTML = shell(`<h1 class="bk-h1">Marcação cancelada</h1><p class="bk-muted">Já libertámos a hora. Esperamos ver-te em breve.</p><p><a class="bk-btn" href="#/reservar">Fazer nova marcação</a></p>`); return; }
  const ok = b.status === 'confirmed' && canCancelOrReschedule(b, store.nowMs());
  if (m.mode === 'resched') {
    root.innerHTML = shell(`<button class="bk-back" data-act="m-back">‹ Voltar</button><h1 class="bk-h1">Escolhe a nova hora</h1>${err}<p class="bk-muted">${esc(svcNames(b.serviceIds))} · ${esc(empLabel(b.employeeId))}</p>${picker(b.serviceIds, b.employeeId, m.date, m.start, m.days, m.avail)}`,
      m.start != null && m.date ? bar(`<b>${esc(dayLong(m.date))}, ${fmt(m.start)}</b>`, `<button class="bk-btn" data-act="m-confirm">Confirmar nova hora</button>`) : '');
    return;
  }
  root.innerHTML = shell(`<h1 class="bk-h1">${m.mode === 'moved' ? 'Hora alterada' : 'A tua marcação'}</h1>${err}${summary(b.serviceIds, b.employeeId, b.date, b.startMin)}<p class="bk-muted">Barbeiro: <b>${esc(empLabel(b.employeeId))}</b></p>
    ${ok ? (m.confirmCancel ? `<div class="bk-warn" role="alertdialog" aria-label="Confirmar cancelamento"><p>Queres mesmo cancelar esta marcação?</p><div class="row"><button class="bk-btn ghost" data-act="m-keep">Manter</button><button class="bk-btn danger" data-act="m-cancel">Sim, cancelar</button></div></div>` : `<div class="row"><button class="bk-btn" data-act="m-resched">Mudar a hora</button><button class="bk-btn ghost" data-act="m-ask">Cancelar marcação</button></div>`) : `<p class="bk-muted">Faltam menos de 3 horas, por isso já não dá para alterar online. Fala com a barbearia.</p>`}`);
}

// ---------- eventos ----------
function onClick(e: Event) {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]'); if (!el) return; const act = el.dataset.act!, v = el.dataset.v;
  if (act === 'theme') { let cur = 'system'; try { cur = localStorage.getItem('rr-theme') ?? 'system'; } catch {} const n = ({ system: 'light', light: 'dark', dark: 'system' } as Record<string, string>)[cur] ?? 'light'; try { localStorage.setItem('rr-theme', n); } catch {} n === 'system' ? document.documentElement.removeAttribute('data-theme') : document.documentElement.setAttribute('data-theme', n); return; }
  if (mg) return manageAct(act, v);
  w.error = '';
  if (act === 'again') { w = fresh(new URLSearchParams()); return render(); }
  if (act === 'to-barber') { w.step = 'barber'; return render(); }
  if (act === 'to-time') { w.step = 'time'; w.date = ''; w.start = null; w.avail = computeAvail(w.svcs, w.emp, w.days); return render(); }
  if (act === 'back') { if (w.step === 'details') { store.release(w.holdId); w.holdId = undefined; w.start = null; w.avail = computeAvail(w.svcs, w.emp, w.days); } w.step = ({ barber: 'services', time: 'barber', details: 'time' } as Record<string, Step>)[w.step] ?? 'services'; return render(); }
  if (act === 'more') { w.days = Math.min(57, w.days + 14); w.avail = computeAvail(w.svcs, w.emp, w.days); return render(); }
  if (act === 'day') { w.date = v!; w.start = null; return render(); }
  if (act === 'slot') {
    w.start = Number(v); const h = store.hold({ date: w.date as DateStr, startMin: w.start, serviceIds: w.svcs, employeeId: empArg(w.emp) });
    if (!h.ok) { w.error = ERR[h.error]; w.start = null; w.avail = computeAvail(w.svcs, w.emp, w.days); return render(); }
    w.holdId = h.id; w.holdEmp = h.employeeId; w.holdUntil = h.expiresAtMs; w.step = 'details'; return render();
  }
}
function onChange(e: Event) {
  const t = e.target as HTMLInputElement; if (mg) return;
  if (t.name === 'svc') { w.svcs = SERVICES.map(s => s.id).filter(id => id === t.value ? t.checked : w.svcs.includes(id)); return render(); }
  if (t.name === 'emp') { w.emp = t.value; return render(); }
  if (t.name === 'cc') w.cc = t.value; if (t.name === 'consent') w.consent = t.checked;
}
function onInput(e: Event) { const t = e.target as HTMLInputElement; if (mg) return; if (t.name === 'name') w.name = t.value; if (t.name === 'phone') w.phone = t.value; if (t.name === 'email') w.email = t.value; }
function onSubmit(e: Event) {
  e.preventDefault(); if ((e.target as HTMLElement).id !== 'bkf' || mg) return;
  const r = store.bookOnline({ name: w.name, cc: w.cc, phone: w.phone, email: w.email, consent: w.consent, serviceIds: w.svcs, date: w.date as DateStr, startMin: w.start!, employeeId: w.holdEmp ?? empArg(w.emp), holdId: w.holdId });
  w.holdId = undefined;
  if (!r.ok) {
    w.error = ERR[r.error];
    if (r.error === 'indisponivel') { w.step = 'time'; w.start = null; w.avail = computeAvail(w.svcs, w.emp, w.days); } else { const h = store.hold({ date: w.date as DateStr, startMin: w.start!, serviceIds: w.svcs, employeeId: w.holdEmp }); if (h.ok) { w.holdId = h.id; w.holdUntil = h.expiresAtMs; } }
    return render();
  }
  w.token = r.booking.token; w.step = 'done'; render();
}
function manageAct(act: string, v?: string) {
  const m = mg!; const b = store.byToken(m.token)!; m.error = '';
  if (act === 'm-ask') { m.confirmCancel = true; return render(); }
  if (act === 'm-keep') { m.confirmCancel = false; return render(); }
  if (act === 'm-cancel') { const r = store.cancelOnline(m.token); if (!r.ok) { m.error = ERR[r.error]; m.confirmCancel = false; } else m.mode = 'cancelled'; return render(); }
  if (act === 'm-resched') { m.mode = 'resched'; m.date = ''; m.start = null; m.avail = computeAvail(b.serviceIds, b.employeeId, m.days, b.id); return render(); }
  if (act === 'm-back') { m.mode = 'view'; return render(); }
  if (act === 'more') { m.days = Math.min(57, m.days + 14); m.avail = computeAvail(b.serviceIds, b.employeeId, m.days, b.id); return render(); }
  if (act === 'day') { m.date = v!; m.start = null; return render(); }
  if (act === 'slot') { m.start = Number(v); return render(); }
  if (act === 'm-confirm' && m.date && m.start != null) { const r = store.rescheduleOnline(m.token, m.date as DateStr, m.start); if (!r.ok) { m.error = ERR[r.error]; m.start = null; m.avail = computeAvail(b.serviceIds, b.employeeId, m.days, b.id); } else m.mode = 'moved'; return render(); }
}
