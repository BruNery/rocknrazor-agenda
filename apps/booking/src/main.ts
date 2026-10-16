import { addDays, todayLocal, weekday, localToEpochMs } from '@rr/domain';

/** Booking do cliente da Rock n' Razor: fala com o servidor verdadeiro (mesmas horas e regras do HQ). Sem contas nem SMS por agora: marca com nome e telemóvel. */
type DateStr = string;
interface Catalog {
  rules: { maxWeeksAhead: number; holdMin: number; cancelLeadMin: number; gridMin: number };
  employees: { id: string; name: string; nickname: string | null; specialties?: string }[];
  services: { id: string; name: string; durationMin: number; priceCents: number }[];
  offers: { employeeId: string; serviceId: string; durationMin: number | null }[];
}
interface Booking { id: string; date: DateStr; startMin: number; endMin: number; status: string; customerName: string; employee: { id: string; name: string; nickname: string | null }; services: { id: string; name: string; durationMin: number; priceCents: number }[]; canChange: boolean; cancelLeadMin: number }
/** Faixa de dias + horas livres (serve à marcação nova e a mudar a hora). */
interface Picker { svcs: string[]; emp: string; ignore?: string; date: DateStr; start: number | null; days: number; counts: Record<string, number>; slots: number[]; busy: boolean; seq: number }
type Step = 'barber' | 'services' | 'time' | 'details' | 'done';
interface W { step: Step; emp: string; svcs: string[]; p: Picker; name: string; cc: string; phone: string; email: string; consent: boolean; hold?: { id: string; emp: string; until: number }; error: string; done?: { id: string; memberCode?: string; emp: string; date: DateStr; start: number; svcs: string[] } }
interface Mg { id: string; b?: Booking; loading: boolean; mode: 'view' | 'resched' | 'cancelled' | 'moved'; p: Picker; confirmCancel: boolean; error: string; notFound?: boolean }

const COUNTRY_CODES = ['+351', '+55', '+34', '+33', '+44', '+49', '+39', '+41', '+32', '+31', '+352', '+244', '+238', '+1'];
const ERR: Record<string, string> = {
  indisponivel: 'Esse horário acabou de ser ocupado. Escolhe outro, por favor.', sem_disponibilidade: 'Esse horário acabou de ser ocupado. Escolhe outro, por favor.', conflito: 'Esse horário já não está livre. Escolhe outro, por favor.',
  limite_marcacoes_abertas: 'Já tens o máximo de marcações em aberto com este número. Cancela uma ou fala com a barbearia.',
  fora_do_prazo: 'Já não é possível alterar online (falta pouco tempo para a marcação). Fala com a barbearia.',
  nao_encontrada: 'Não encontrámos esta marcação.', ja_cancelada: 'Esta marcação já foi cancelada.',
  nome_e_telefone_obrigatorios: 'Confirma o nome e o telefone.', rede: 'Sem ligação à internet. Tenta outra vez.',
};
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const euro = (cents: number) => `€ ${(cents / 100).toFixed(2).replace('.', ',')}`;
const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const dayLong = (d: DateStr) => new Intl.DateTimeFormat('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z'));
const wk = (d: DateStr) => new Intl.DateTimeFormat('pt-PT', { weekday: 'short', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z')).replace('.', '').slice(0, 3);
const empLabel = (e: { name: string; nickname: string | null }) => e.nickname ? `${e.name} (${e.nickname})` : e.name;

// ---------- guardado só neste telemóvel ----------
const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* modo privado */ } },
};
interface Me { name: string; cc: string; phone: string; email: string; memberCode?: string }
const getMe = () => store.get<Me>('rr-me', { name: '', cc: '+351', phone: '', email: '' });
const getIds = () => store.get<string[]>('rr-ids', []);
const addId = (id: string) => store.set('rr-ids', [id, ...getIds().filter(x => x !== id)].slice(0, 30));

// ---------- servidor ----------
async function api<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; json: T }> {
  try {
    const r = await fetch(url, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json: any = null; try { json = await r.json(); } catch { /* sem corpo */ }
    return { status: r.status, json };
  } catch { return { status: 0, json: { ok: false, error: 'rede' } as any }; }
}
const errText = (j: any, fallback = 'Não foi possível concluir. Tenta outra vez.') => ERR[j?.error] ?? fallback;

let C: Catalog | null = null, catErr = false;
let root: HTMLElement, w: W, mg: Mg | null = null, view: 'wizard' | 'mine' | 'manage' = 'wizard', mine: { b?: Booking; id: string }[] | null = null, ticker = 0, renderedKey = '';
const now = () => Date.now();
const today = () => todayLocal(now());
const maxDays = () => (C?.rules.maxWeeksAhead ?? 8) * 7 + 1;

const offered = (emp: string) => C!.offers.filter(o => emp === 'any' || o.employeeId === emp).map(o => o.serviceId);
const dur = (sid: string, emp: string) => { const s = C!.services.find(x => x.id === sid)!; const o = C!.offers.find(x => x.serviceId === sid && x.employeeId === emp); return o?.durationMin ?? s.durationMin; };
const total = (svcs: string[], emp: string) => ({ min: svcs.reduce((t, i) => t + dur(i, emp), 0), cents: svcs.reduce((t, i) => t + (C!.services.find(s => s.id === i)?.priceCents ?? 0), 0) });
const svcNames = (ids: string[]) => ids.map(i => C!.services.find(s => s.id === i)?.name ?? i).join(' + ');
const empById = (id: string) => C!.employees.find(e => e.id === id);
const empName = (id: string) => { const e = empById(id); return e ? empLabel(e) : id; };

const newPicker = (svcs: string[], emp: string, ignore?: string): Picker => ({ svcs, emp, ignore, date: '', start: null, days: 14, counts: {}, slots: [], busy: false, seq: 0 });
const fresh = (): W => { const me = getMe(); return { step: 'barber', emp: 'any', svcs: [], p: newPicker([], 'any'), name: me.name, cc: me.cc, phone: me.phone, email: me.email, consent: false, error: '' }; };
const q = (p: Picker) => `services=${encodeURIComponent(p.svcs.join(','))}${p.emp !== 'any' ? `&employeeId=${encodeURIComponent(p.emp)}` : ''}${p.ignore ? `&ignore=${encodeURIComponent(p.ignore)}` : ''}`;

/** Quantas horas livres há em cada dia da faixa (em blocos de 28 dias). */
async function loadCounts(p: Picker, then: () => void) {
  const seq = ++p.seq, t = today(), n = Math.min(p.days, maxDays()); p.busy = true;
  const jobs: Promise<void>[] = [];
  for (let off = 0; off < n; off += 28) {
    const from = addDays(t, off);
    if (Array.from({ length: Math.min(28, n - off) }, (_, i) => addDays(from, i)).every(d => d in p.counts)) continue;
    jobs.push(api('GET', `/public/availability/days?from=${from}&days=${Math.min(28, n - off)}&${q(p)}`).then(r => { if (seq === p.seq && r.json?.days) Object.assign(p.counts, r.json.days); }));
  }
  await Promise.all(jobs); if (seq !== p.seq) return; p.busy = false; then();
}
async function loadSlots(p: Picker, then: () => void) {
  const seq = ++p.seq; p.busy = true; p.slots = [];
  const r = await api('GET', `/public/availability?date=${p.date}&${q(p)}`); if (seq !== p.seq) return;
  p.busy = false; p.slots = [...new Set<number>((r.json?.slots ?? []).map((s: { startMin: number }) => s.startMin))].sort((a, b) => a - b); then();
}
const resetCounts = (p: Picker) => { p.counts = {}; p.date = ''; p.start = null; p.slots = []; };

// ---------- páginas ----------
function shell(inner: string, bar = ''): string {
  const n = getIds().length;
  return `<header class="bk-top"><a class="brand" href="#/" style="text-decoration:none;color:inherit">ROCK N' RAZOR<small>MARCAÇÕES</small></a><nav class="bk-nav" aria-label="Menu"><a class="bk-theme bk-mine" href="#/minhas">Minhas marcações${n ? `<span class="bk-badge">${n}</span>` : ''}</a><button type="button" class="bk-theme" data-act="theme" aria-label="Mudar tema">Tema</button></nav></header><main class="bk-main">${inner}</main>${bar}<footer class="bk-foot">Rock n' Razor · Loures</footer>`;
}
const bar = (left: string, btn: string) => `<div class="bk-bar"><div>${left}</div>${btn}</div>`;
const stepNav = () => {
  const order: [Step, string][] = [['barber', 'Barbeiro'], ['services', 'Serviços'], ['time', 'Hora'], ['details', 'Dados']]; const idx = order.findIndex(o => o[0] === w.step);
  return `<ol class="bk-steps" aria-label="Passos">${order.map((o, i) => `<li ${i === idx ? 'aria-current="step"' : ''} class="${i < idx ? 'done' : ''}"><span>${i + 1}</span>${o[1]}</li>`).join('')}</ol>`;
};
const summary = (svcs: string[], emp: string, date?: DateStr, start?: number | null) => {
  const t = total(svcs, emp);
  return `<dl class="bk-sum"><div><dt>Serviços</dt><dd>${esc(svcNames(svcs))}</dd></div>${emp !== 'any' ? `<div><dt>Barbeiro</dt><dd>${esc(empName(emp))}</dd></div>` : ''}${date && start != null ? `<div><dt>Quando</dt><dd>${esc(dayLong(date))}, ${fmt(start)}</dd></div>` : ''}<div><dt>Duração e preço</dt><dd>${t.min} min · ${euro(t.cents)}</dd></div></dl>`;
};

function picker(p: Picker): string {
  const t = today(), n = Math.min(p.days, maxDays());
  const strip = Array.from({ length: n }, (_, i) => addDays(t, i)).map(d => {
    const c = p.counts[d]; const closed = weekday(d) === 0;
    return `<button type="button" class="bk-day" data-act="day" data-v="${d}" aria-pressed="${p.date === d}" ${c ? '' : 'disabled'} aria-label="${esc(dayLong(d))}${c ? '' : closed ? ', fechado' : c === undefined ? '' : ', sem horas livres'}"><small>${wk(d)}</small><b>${Number(d.slice(8))}</b></button>`;
  }).join('');
  const more = p.days < maxDays() ? `<button type="button" class="bk-more" data-act="more">Mais dias ›</button>` : '';
  let slots = '';
  if (p.date) {
    const groups: [string, number, number][] = [['Manhã', 0, 720], ['Tarde', 720, 1020], ['Fim do dia', 1020, 1441]];
    slots = `<h2 class="bk-h2">${esc(dayLong(p.date))}</h2>` + (p.busy ? '<p class="bk-muted">A procurar horas livres…</p>' : p.slots.length
      ? groups.map(([g, a, b]) => { const l = p.slots.filter(s => s >= a && s < b); return l.length ? `<h3 class="bk-h3">${g}</h3><div class="bk-slots">${l.map(s => `<button type="button" class="bk-slot" data-act="slot" data-v="${s}" aria-pressed="${p.start === s}">${fmt(s)}</button>`).join('')}</div>` : ''; }).join('')
      : '<p class="bk-muted">Sem horas livres neste dia. Escolhe outro.</p>');
  } else if (p.busy && !Object.keys(p.counts).length) slots = '<p class="bk-muted">A procurar horas livres…</p>';
  else {
    const nextD = Array.from({ length: n }, (_, i) => addDays(t, i)).find(d => (p.counts[d] ?? 0) > 0);
    slots = nextD ? `<p class="bk-muted">Próximo dia com horas livres: <button type="button" class="bk-link" data-act="day" data-v="${nextD}">${esc(dayLong(nextD))}</button></p>` : '<p class="bk-muted">Sem horas livres nas próximas semanas. Fala com a barbearia.</p>';
  }
  return `<div class="bk-strip" role="group" aria-label="Dias">${strip}${more}</div>${slots}`;
}

function renderWizard() {
  const err = w.error ? `<p class="bk-err" role="alert">${esc(w.error)}</p>` : '';
  if (w.step === 'barber') {
    const opt = (id: string, name: string, sub: string) => `<label class="bk-card ${w.emp === id ? 'on' : ''}"><input type="radio" name="emp" value="${id}" ${w.emp === id ? 'checked' : ''}><span class="grow"><b>${esc(name)}</b><small>${esc(sub)}</small></span></label>`;
    root.innerHTML = shell(`${stepNav()}<h1 class="bk-h1">Com quem queres marcar?</h1>${err}<div class="bk-list">${opt('any', 'Qualquer barbeiro', 'Mostramos todas as horas livres da equipa')}${C!.employees.map(e => opt(e.id, empLabel(e), e.specialties || 'Barbeiro')).join('')}</div>`,
      bar('<span class="bk-muted">Passo 1 de 4</span>', `<button class="bk-btn" data-act="to-services">Continuar</button>`));
  } else if (w.step === 'services') {
    const ids = offered(w.emp); const list = C!.services.filter(s => ids.includes(s.id)); const t = total(w.svcs, w.emp);
    root.innerHTML = shell(`${stepNav()}<button class="bk-back" data-act="back">‹ Voltar</button><h1 class="bk-h1">Escolhe os serviços</h1>${err}<p class="bk-muted">${w.emp === 'any' ? 'Qualquer barbeiro' : esc(empName(w.emp))}</p><div class="bk-list">${list.map(s => `<label class="bk-card ${w.svcs.includes(s.id) ? 'on' : ''}"><input type="checkbox" name="svc" value="${s.id}" ${w.svcs.includes(s.id) ? 'checked' : ''}><span class="grow"><b>${esc(s.name)}</b><small>${dur(s.id, w.emp)} min</small></span><span class="price">${euro(s.priceCents)}</span></label>`).join('') || '<p class="bk-muted">Este barbeiro não tem serviços disponíveis online. Escolhe outro barbeiro.</p>'}</div>`,
      bar(w.svcs.length ? `<b>${t.min} min · ${euro(t.cents)}</b>` : '<span class="bk-muted">Escolhe pelo menos um serviço</span>', `<button class="bk-btn" data-act="to-time" ${w.svcs.length ? '' : 'disabled'}>Continuar</button>`));
  } else if (w.step === 'time') {
    root.innerHTML = shell(`${stepNav()}<button class="bk-back" data-act="back">‹ Voltar</button><h1 class="bk-h1">Escolhe o dia e a hora</h1>${err}<p class="bk-muted">${esc(svcNames(w.svcs))} · ${w.emp === 'any' ? 'qualquer barbeiro' : esc(empName(w.emp))}</p>${picker(w.p)}`);
  } else if (w.step === 'details') {
    const hold = w.hold ? Math.max(0, w.hold.until - now()) : 0;
    root.innerHTML = shell(`${stepNav()}<button class="bk-back" data-act="back">‹ Voltar</button><h1 class="bk-h1">Os teus dados</h1>${err}${summary(w.svcs, w.hold?.emp ?? w.emp, w.p.date, w.p.start)}<p class="bk-hold">Guardámos esta hora para ti durante <b id="hold-left">${Math.floor(hold / 60000)}:${String(Math.floor((hold % 60000) / 1000)).padStart(2, '0')}</b>.</p>
      <form id="bkf" class="bk-form" novalidate><label>Nome<input name="name" value="${esc(w.name)}" autocomplete="name" required></label>
        <label>Telemóvel<span class="bk-phone"><select name="cc" aria-label="Indicativo">${COUNTRY_CODES.map(c => `<option ${c === w.cc ? 'selected' : ''}>${c}</option>`).join('')}</select><input name="phone" inputmode="tel" autocomplete="tel-national" value="${esc(w.phone)}" required></span></label>
        <label>E-mail <small>(opcional)</small><input name="email" type="email" autocomplete="email" value="${esc(w.email)}"></label>
        <label class="bk-check"><input type="checkbox" name="consent" ${w.consent ? 'checked' : ''}><span>Autorizo a Rock n' Razor a guardar o meu nome e telefone para gerir esta marcação e avisar-me sobre ela.</span></label>
        <button class="bk-btn wide" type="submit">Confirmar marcação</button></form>`);
  } else {
    const d = w.done!; const me = getMe();
    root.innerHTML = shell(`<div class="bk-ok" role="status"><span class="tick" aria-hidden="true">✓</span><h1 class="bk-h1">Marcação confirmada</h1></div>${summary(d.svcs, d.emp, d.date, d.start)}<p class="bk-muted">Barbeiro: <b>${esc(empName(d.emp))}</b>. Guardámos esta marcação neste telemóvel, em “Minhas marcações”.</p>
      ${d.memberCode ? `<div class="bk-member"><small>O teu ID de membro</small><b>${esc(d.memberCode)}</b></div>` : me.memberCode ? `<div class="bk-member"><small>O teu ID de membro</small><b>${esc(me.memberCode)}</b></div>` : ''}
      <div class="row"><a class="bk-btn" href="#/marcacao/${d.id}">Ver ou alterar</a><a class="bk-btn ghost" href="${icsHref(d.date, d.start, total(d.svcs, d.emp).min, `Rock n' Razor · ${svcNames(d.svcs)}`)}" download="marcacao-rock-n-razor.ics">Adicionar ao calendário</a><button class="bk-btn ghost" data-act="again">Nova marcação</button></div>
      <p class="bk-tip">Dica: no iPhone, toca em Partilhar → “Adicionar ao ecrã principal” para teres a app à mão.</p>`);
  }
}

function icsHref(date: DateStr, start: number, min: number, title: string): string {
  const z = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const s = localToEpochMs(date, start), e = localToEpochMs(date, start + min);
  const txt = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Rock n Razor//Marcacoes//PT', 'BEGIN:VEVENT', `UID:${s}-${start}@rockandrazor.com`, `DTSTAMP:${z(now())}`, `DTSTART:${z(s)}`, `DTEND:${z(e)}`, `SUMMARY:${title.replace(/[,;\n]/g, ' ')}`, 'LOCATION:Rock n Razor\\, Loures', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  return 'data:text/calendar;charset=utf-8,' + encodeURIComponent(txt);
}

function renderMine() {
  if (!mine) { root.innerHTML = shell('<h1 class="bk-h1">Minhas marcações</h1><p class="bk-load">A abrir…</p>'); return; }
  const nowMs = now(); const rows = mine.filter(x => x.b) as { b: Booking; id: string }[];
  const up = rows.filter(x => x.b.status === 'confirmed' && localToEpochMs(x.b.date, x.b.endMin) > nowMs).sort((a, b) => (a.b.date + String(a.b.startMin).padStart(4, '0')).localeCompare(b.b.date + String(b.b.startMin).padStart(4, '0')));
  const past = rows.filter(x => !up.includes(x)).sort((a, b) => (b.b.date + String(b.b.startMin).padStart(4, '0')).localeCompare(a.b.date + String(a.b.startMin).padStart(4, '0')));
  const me = getMe();
  const item = (x: { b: Booking }) => { const b = x.b; const st = b.status === 'cancelled' ? ['Cancelada', 'bad'] : b.status === 'confirmed' && localToEpochMs(b.date, b.endMin) > nowMs ? ['Confirmada', 'ok'] : ['Concluída', '']; return `<a class="bk-item" href="#/marcacao/${b.id}"><b>${esc(dayLong(b.date))}, ${fmt(b.startMin)}</b><small>${esc(b.services.map(s => s.name).join(' + '))} · ${esc(empLabel(b.employee))}</small><span class="st ${st[1]}">${st[0]}</span></a>`; };
  root.innerHTML = shell(`<h1 class="bk-h1">Minhas marcações</h1>${me.memberCode ? `<div class="bk-member"><small>O teu ID de membro</small><b>${esc(me.memberCode)}</b></div>` : ''}
    ${!rows.length ? `<div class="bk-empty"><p>Ainda não tens marcações neste telemóvel.</p><a class="bk-btn" href="#/">Marcar agora</a></div>` : `${up.length ? `<h2 class="bk-h3">Próximas</h2><div class="bk-list">${up.map(item).join('')}</div>` : '<p class="bk-muted">Não tens marcações futuras.</p>'}${past.length ? `<h2 class="bk-h3" style="margin-top:18px">Anteriores</h2><div class="bk-list">${past.map(item).join('')}</div>` : ''}<p class="bk-tip">As marcações ficam guardadas neste telemóvel. Se mudares de telemóvel, fala com a barbearia.</p><div class="row"><a class="bk-btn" href="#/">Nova marcação</a></div>`}`);
}

function renderManage() {
  const m = mg!;
  if (m.loading) { root.innerHTML = shell('<p class="bk-load">A abrir a marcação…</p>'); return; }
  const b = m.b;
  if (!b) { root.innerHTML = shell(`<h1 class="bk-h1">Marcação não encontrada</h1><p class="bk-muted">${m.notFound ? 'O link pode estar incompleto. Fala com a barbearia.' : esc(ERR.rede)}</p><p><a class="bk-link" href="#/">Fazer uma marcação</a></p>`); return; }
  const err = m.error ? `<p class="bk-err" role="alert">${esc(m.error)}</p>` : '';
  const svcIds = b.services.map(s => s.id); const t = b.services.reduce((a, s) => ({ min: a.min + s.durationMin, cents: a.cents + s.priceCents }), { min: 0, cents: 0 });
  const sum = (date: DateStr, start: number) => `<dl class="bk-sum"><div><dt>Serviços</dt><dd>${esc(b.services.map(s => s.name).join(' + '))}</dd></div><div><dt>Barbeiro</dt><dd>${esc(empLabel(b.employee))}</dd></div><div><dt>Quando</dt><dd>${esc(dayLong(date))}, ${fmt(start)}</dd></div><div><dt>Duração e preço</dt><dd>${t.min} min · ${euro(t.cents)}</dd></div></dl>`;
  if (m.mode === 'cancelled' || b.status === 'cancelled') { root.innerHTML = shell(`<h1 class="bk-h1">Marcação cancelada</h1><p class="bk-muted">Já libertámos a hora. Esperamos ver-te em breve.</p><div class="row"><a class="bk-btn" href="#/">Fazer nova marcação</a><a class="bk-btn ghost" href="#/minhas">Minhas marcações</a></div>`); return; }
  if (m.mode === 'resched') {
    root.innerHTML = shell(`<button class="bk-back" data-act="m-back">‹ Voltar</button><h1 class="bk-h1">Escolhe a nova hora</h1>${err}<p class="bk-muted">${esc(b.services.map(s => s.name).join(' + '))} · ${esc(empLabel(b.employee))}</p>${picker(m.p)}`,
      m.p.start != null && m.p.date ? bar(`<b>${esc(dayLong(m.p.date))}, ${fmt(m.p.start)}</b>`, `<button class="bk-btn" data-act="m-confirm">Confirmar nova hora</button>`) : '');
    return;
  }
  const over = localToEpochMs(b.date, b.endMin) <= now();
  root.innerHTML = shell(`<h1 class="bk-h1">${m.mode === 'moved' ? 'Hora alterada' : 'A tua marcação'}</h1>${err}${sum(b.date, b.startMin)}
    ${over ? '<p class="bk-muted">Esta marcação já passou.</p>' : b.canChange ? (m.confirmCancel ? `<div class="bk-warn" role="alertdialog" aria-label="Confirmar cancelamento"><p>Queres mesmo cancelar esta marcação?</p><div class="row"><button class="bk-btn ghost" data-act="m-keep">Manter</button><button class="bk-btn danger" data-act="m-cancel">Sim, cancelar</button></div></div>` : `<div class="row"><button class="bk-btn" data-act="m-resched">Mudar a hora</button><button class="bk-btn ghost" data-act="m-ask">Cancelar marcação</button><a class="bk-btn ghost" href="${icsHref(b.date, b.startMin, t.min, `Rock n' Razor · ${b.services.map(s => s.name).join(' + ')}`)}" download="marcacao-rock-n-razor.ics">Adicionar ao calendário</a></div>`) : `<p class="bk-muted">Já não é possível alterar online (faltam menos de ${Math.round(b.cancelLeadMin / 60)} horas). Fala com a barbearia.</p>`}
    <p style="margin-top:18px"><a class="bk-link" href="#/minhas">‹ Minhas marcações</a></p>`);
  void svcIds;
}

function render() {
  const keepY = window.scrollY;
  if (!C) { root.innerHTML = catErr ? `<div class="bk-load"><p>Não foi possível abrir as marcações.</p><button class="bk-btn" data-act="retry">Tentar outra vez</button></div>` : '<p class="bk-load">A abrir…</p>'; return; }
  if (view === 'mine') renderMine(); else if (view === 'manage' && mg) renderManage(); else renderWizard();
  const key = view === 'wizard' ? `w:${w.step}` : view === 'manage' ? `m:${mg?.mode}:${mg?.loading}` : 'mine';
  const h = root.querySelector<HTMLElement>('h1'); if (h && key !== renderedKey) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  const changed = key !== renderedKey; renderedKey = key; window.scrollTo(0, changed ? 0 : keepY);
  clearInterval(ticker); if (view === 'wizard' && w.step === 'details') ticker = window.setInterval(tick, 1000);
}
function tick() {
  if (!w.hold) return; const left = w.hold.until - now(); const e = document.getElementById('hold-left');
  if (left <= 0) { w.hold = undefined; w.p.start = null; w.step = 'time'; w.error = 'O tempo da reserva acabou. Escolhe a hora outra vez.'; resetCounts(w.p); render(); loadCounts(w.p, render); return; }
  if (e) e.textContent = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
}
const release = () => { if (w?.hold) { api('DELETE', `/public/holds/${w.hold.id}`); w.hold = undefined; } };

// ---------- navegação ----------
async function route() {
  if (!C) return;
  const h = location.hash.replace(/^#/, '') || '/';
  if (h.startsWith('/marcacao/')) {
    release(); const id = h.slice('/marcacao/'.length); view = 'manage';
    if (!mg || mg.id !== id) { mg = { id, loading: true, mode: 'view', p: newPicker([], 'any'), confirmCancel: false, error: '' }; render(); const r = await api<{ booking: Booking }>('GET', `/public/bookings/${encodeURIComponent(id)}`); if (!mg || mg.id !== id) return; mg.loading = false; mg.notFound = r.status === 404; mg.b = r.json?.booking; if (mg.b) addId(id); }
    return render();
  }
  mg = null;
  if (h === '/minhas') {
    release(); view = 'mine'; mine = null; render();
    const res = await Promise.all(getIds().map(async id => { const r = await api<{ booking: Booking }>('GET', `/public/bookings/${encodeURIComponent(id)}`); return { id, b: r.json?.booking as Booking | undefined, gone: r.status === 404 }; }));
    store.set('rr-ids', res.filter(x => !x.gone).map(x => x.id)); mine = res.filter(x => !x.gone); if (view === 'mine') render(); return;
  }
  view = 'wizard'; if (!w) w = fresh(); render();
}

// ---------- eventos ----------
const onClick = (e: Event) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]'); if (!el) return; const act = el.dataset.act!, v = el.dataset.v;
  if (act === 'theme') { const cur = store.get<string>('rr-theme', 'system'); const n = ({ system: 'light', light: 'dark', dark: 'system' } as Record<string, string>)[cur] ?? 'light'; store.set('rr-theme', n); applyTheme(); return; }
  if (act === 'retry') { catErr = false; boot(); return; }
  if (view === 'manage' && mg) return manageAct(act, v);
  if (view !== 'wizard') return;
  w.error = '';
  if (act === 'again') { release(); w = fresh(); return render(); }
  if (act === 'to-services') { w.step = 'services'; w.svcs = w.svcs.filter(s => offered(w.emp).includes(s)); return render(); }
  if (act === 'to-time') { w.step = 'time'; w.p = newPicker(w.svcs, w.emp); render(); loadCounts(w.p, render); return; }
  if (act === 'back') { if (w.step === 'details') { release(); w.p.start = null; w.step = 'time'; resetCounts(w.p); render(); loadCounts(w.p, render); return; } w.step = ({ services: 'barber', time: 'services' } as Record<string, Step>)[w.step] ?? 'barber'; return render(); }
  if (act === 'more') { w.p.days = Math.min(maxDays(), w.p.days + 14); render(); loadCounts(w.p, render); return; }
  if (act === 'day') { w.p.date = v!; w.p.start = null; render(); loadSlots(w.p, render); return; }
  if (act === 'slot') return pickSlot(Number(v));
};
async function pickSlot(start: number) {
  w.p.start = start; release(); render();
  const r = await api('POST', '/public/holds', { date: w.p.date, startMin: start, serviceIds: w.svcs, employeeId: w.emp === 'any' ? undefined : w.emp });
  if (r.status !== 200 || !r.json?.ok) { w.error = errText(r.json); w.p.start = null; render(); loadSlots(w.p, render); return; }
  w.hold = { id: r.json.holdId, emp: r.json.employeeId, until: r.json.expiresAtMs }; w.step = 'details'; render();
}
const onChange = (e: Event) => {
  const t = e.target as HTMLInputElement; if (view !== 'wizard') return;
  if (t.name === 'emp') { w.emp = t.value; return render(); }
  if (t.name === 'svc') { w.svcs = C!.services.map(s => s.id).filter(id => id === t.value ? t.checked : w.svcs.includes(id)); return render(); }
  if (t.name === 'cc') w.cc = t.value; if (t.name === 'consent') w.consent = t.checked;
};
const onInput = (e: Event) => { const t = e.target as HTMLInputElement; if (view !== 'wizard') return; if (t.name === 'name') w.name = t.value; if (t.name === 'phone') w.phone = t.value; if (t.name === 'email') w.email = t.value; };
async function onSubmit(e: Event) {
  e.preventDefault(); if ((e.target as HTMLElement).id !== 'bkf' || view !== 'wizard') return;
  const digits = w.phone.replace(/\D/g, '');
  if (w.name.trim().length < 2 || digits.length < 9) { w.error = 'Confirma o nome e o telefone (pelo menos 9 números).'; return render(); }
  if (!w.consent) { w.error = 'Para marcar, precisamos da tua autorização para guardar o nome e o telefone.'; return render(); }
  const btn = (e.target as HTMLElement).querySelector<HTMLButtonElement>('button[type=submit]'); if (btn) btn.disabled = true;
  const emp = w.hold?.emp ?? (w.emp === 'any' ? undefined : w.emp);
  const r = await api('POST', '/public/bookings', { customer: { name: w.name.trim(), phone: `${w.cc} ${w.phone.trim()}`, email: w.email.trim() || undefined }, date: w.p.date, startMin: w.p.start, serviceIds: w.svcs, employeeId: emp, holdId: w.hold?.id });
  w.hold = undefined;
  if (r.status !== 200 || !r.json?.ok) {
    w.error = errText(r.json); w.step = 'time'; w.p.start = null; resetCounts(w.p); render(); loadCounts(w.p, render); return;
  }
  const me = getMe(); store.set('rr-me', { name: w.name.trim(), cc: w.cc, phone: w.phone.trim(), email: w.email.trim(), memberCode: r.json.memberCode ?? me.memberCode });
  addId(r.json.bookingId);
  w.done = { id: r.json.bookingId, memberCode: r.json.memberCode, emp: r.json.employeeId, date: w.p.date, start: w.p.start!, svcs: [...w.svcs] }; w.step = 'done'; render();
}
async function manageAct(act: string, v?: string) {
  const m = mg!; const b = m.b; m.error = ''; if (!b) return;
  if (act === 'm-ask') { m.confirmCancel = true; return render(); }
  if (act === 'm-keep') { m.confirmCancel = false; return render(); }
  if (act === 'm-cancel') { const r = await api('POST', `/public/bookings/${b.id}/cancel`, {}); if (r.status !== 200) { m.error = errText(r.json); m.confirmCancel = false; } else m.mode = 'cancelled'; return render(); }
  if (act === 'm-resched') { m.mode = 'resched'; m.p = newPicker(b.services.map(s => s.id), b.employee.id, b.id); render(); loadCounts(m.p, render); return; }
  if (act === 'm-back') { m.mode = 'view'; return render(); }
  if (act === 'more') { m.p.days = Math.min(maxDays(), m.p.days + 14); render(); loadCounts(m.p, render); return; }
  if (act === 'day') { m.p.date = v!; m.p.start = null; render(); loadSlots(m.p, render); return; }
  if (act === 'slot') { m.p.start = Number(v); return render(); }
  if (act === 'm-confirm' && m.p.date && m.p.start != null) {
    const r = await api('POST', `/public/bookings/${b.id}/reschedule`, { date: m.p.date, startMin: m.p.start });
    if (r.status !== 200) { m.error = errText(r.json); m.p.start = null; resetCounts(m.p); render(); loadCounts(m.p, render); return; }
    const g = await api<{ booking: Booking }>('GET', `/public/bookings/${b.id}`); if (g.json?.booking) m.b = g.json.booking; m.mode = 'moved'; render();
  }
}

function applyTheme() { const t = store.get<string>('rr-theme', 'system'); t === 'system' ? document.documentElement.removeAttribute('data-theme') : document.documentElement.setAttribute('data-theme', t); }
async function boot() {
  const r = await api<Catalog & { ok: boolean }>('GET', '/public/catalog');
  if (r.status !== 200 || !r.json?.ok) { catErr = true; return render(); }
  C = r.json; w = fresh(); await route();
}
root = document.getElementById('app')!; applyTheme();
root.addEventListener('click', onClick); root.addEventListener('change', onChange); root.addEventListener('input', onInput); root.addEventListener('submit', onSubmit);
window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => { if (w?.hold) fetch(`/public/holds/${w.hold.id}`, { method: 'DELETE', keepalive: true }).catch(() => {}); });
// ao voltar à app (iPhone), as horas podem ter mudado: volta a ler
document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible' || !C) return; if (view === 'wizard' && w.step === 'time') { resetCounts(w.p); render(); loadCounts(w.p, render); } else if (view === 'mine') route(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* sem instalação */ });
(window as any).__bk = { get w() { return w; } };
boot();
