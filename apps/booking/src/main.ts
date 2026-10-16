import { addDays, todayLocal, weekday, localToEpochMs } from '@rr/domain';

/** Área do cliente da Rock n' Razor: conta (telemóvel + palavra-passe), Marcar, Marcações, Prémios, Sorteios e Perfil. Fala com o servidor verdadeiro (mesmas horas e regras do HQ). */
type DateStr = string;
interface Catalog {
  rules: { maxWeeksAhead: number; holdMin: number; cancelLeadMin: number; gridMin: number };
  employees: { id: string; name: string; nickname: string | null; specialties?: string }[];
  services: { id: string; name: string; durationMin: number; priceCents: number }[];
  offers: { employeeId: string; serviceId: string; durationMin: number | null }[];
}
interface Me { id: number; name: string; phone: string; email: string; memberCode: string | null; points: number }
interface Booking { id: string; date: DateStr; startMin: number; endMin: number; status: string; customerName: string; employee: { id: string; name: string; nickname: string | null }; services: { id: string; name: string; durationMin: number; priceCents: number }[]; canChange: boolean; cancelLeadMin: number }
/** Faixa de dias + horas livres (serve à marcação nova e a mudar a hora). */
interface Picker { svcs: string[]; emp: string; ignore?: string; date: DateStr; start: number | null; days: number; counts: Record<string, number>; slots: number[]; busy: boolean; seq: number }
type Step = 'home' | 'barber' | 'services' | 'time' | 'confirm' | 'done';
interface W { step: Step; emp: string; svcs: string[]; p: Picker; hold?: { id: string; emp: string; until: number }; error: string; busy: boolean; done?: { id: string; emp: string; date: DateStr; start: number; svcs: string[] } }
interface Mg { id: string; b?: Booking; loading: boolean; mode: 'view' | 'resched' | 'cancelled' | 'moved'; p: Picker; confirmCancel: boolean; error: string; notFound?: boolean }
interface Auth { mode: 'login' | 'register'; cc: string; phone: string; name: string; email: string; password: string; memberCode: string; needCode: boolean; consent: boolean; error: string; busy: boolean }
type Tab = 'marcar' | 'marcacoes' | 'premios' | 'sorteios' | 'perfil';

const COUNTRY_CODES = ['+351', '+55', '+34', '+33', '+44', '+49', '+39', '+41', '+32', '+31', '+352', '+244', '+238', '+1'];
const ERR: Record<string, string> = {
  indisponivel: 'Esse horário acabou de ser ocupado. Escolhe outro, por favor.', sem_disponibilidade: 'Esse horário acabou de ser ocupado. Escolhe outro, por favor.', conflito: 'Esse horário já não está livre. Escolhe outro, por favor.',
  limite_marcacoes_abertas: 'Já tens o máximo de marcações em aberto. Cancela uma ou fala com a barbearia.',
  fora_do_prazo: 'Já não é possível alterar online (falta pouco tempo para a marcação). Fala com a barbearia.',
  nao_encontrada: 'Não encontrámos esta marcação.', ja_cancelada: 'Esta marcação já foi cancelada.',
  rede: 'Sem ligação à internet. Tenta outra vez.', sem_sessao: 'A tua sessão terminou. Entra outra vez.',
  credenciais_invalidas: 'Telemóvel ou palavra-passe errados.', demasiadas_tentativas: 'Demasiadas tentativas. Espera uns minutos e tenta outra vez.',
  conta_existe: 'Já existe uma conta com este telemóvel. Entra com a tua palavra-passe.',
  codigo_necessario: 'Este telemóvel já é cliente da barbearia. Para ligares a conta ao teu histórico e pontos, escreve o teu ID de membro (RNR-XXXXXX). Não o sabes? Pede-o na barbearia.',
  codigo_errado: 'O ID de membro não corresponde a este telemóvel. Confirma-o ou pede-o na barbearia.',
  contactar_barbearia: 'Este telemóvel já está registado na barbearia. Fala connosco para ligarmos a tua conta.',
  palavra_passe_atual_errada: 'A palavra-passe atual está errada.', pedido_invalido: 'Confirma os dados: nome, telemóvel e palavra-passe com pelo menos 8 caracteres.',
};
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const euro = (cents: number) => `€ ${(cents / 100).toFixed(2).replace('.', ',')}`;
const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const dayLong = (d: DateStr) => new Intl.DateTimeFormat('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z'));
const wk = (d: DateStr) => new Intl.DateTimeFormat('pt-PT', { weekday: 'short', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z')).replace('.', '').slice(0, 3);
const empLabel = (e: { name: string; nickname: string | null }) => e.nickname ? `${e.name} (${e.nickname})` : e.name;
const when = (iso: string) => new Intl.DateTimeFormat('pt-PT', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Lisbon' }).format(new Date(iso));

// ---------- guardado só neste telemóvel (conveniências, nunca a palavra-passe) ----------
const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* modo privado */ } },
};

// ---------- servidor ----------
async function api<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; json: T }> {
  try {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json: any = null; try { json = await r.json(); } catch { /* sem corpo */ }
    return { status: r.status, json };
  } catch { return { status: 0, json: { ok: false, error: 'rede' } as any }; }
}
const errText = (j: any, fallback = 'Não foi possível concluir. Tenta outra vez.') => ERR[j?.error] ?? fallback;

let C: Catalog | null = null, catErr = false, me: Me | null = null, booted = false;
let root: HTMLElement, w: W, mg: Mg | null = null, tab: Tab = 'marcar', ticker = 0, renderedKey = '';
let auth: Auth = { mode: 'login', cc: '+351', phone: '', name: '', email: '', password: '', memberCode: '', needCode: false, consent: false, error: '', busy: false };
let list: Booking[] | null = null, pts: { balance: number; history: { delta: number; kind: string; note: string; at: string }[] } | null = null, pf = { name: '', email: '', msg: '', err: '', pwMsg: '', pwErr: '' };
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
const fresh = (): W => ({ step: 'home', emp: 'any', svcs: [], p: newPicker([], 'any'), error: '', busy: false });
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

// ---------- ícones (desenhados aqui, traço simples) ----------
const ic = (d: string) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  cut: ic('<circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><path d="M8 7.6 20 19M8 16.4 20 5"/>'),
  cal: ic('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17M9 15l2 2 4-4"/>'),
  gift: ic('<rect x="3.5" y="8.5" width="17" height="4" rx="1"/><path d="M5 12.5V20h14v-7.5M12 8.5V20M12 8.5C9 8.5 7.5 7 7.5 5.6S9 3.5 10.2 4.4C11.2 5.2 12 8.5 12 8.5zm0 0c3 0 4.5-1.5 4.5-2.9s-1.5-2.1-2.7-1.2C12.8 5.2 12 8.5 12 8.5z"/>'),
  ticket: ic('<path d="M3.5 8.5a2 2 0 0 0 0 7V18h17v-2.5a2 2 0 0 1 0-7V6h-17zM14 6v12" stroke-dasharray="2 2.4"/>'),
  user: ic('<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20c.8-3.6 3.8-5.5 7.5-5.5s6.7 1.9 7.5 5.5"/>'),
  spark: ic('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>'),
  arrow: ic('<path d="M5 12h14M13 6l6 6-6 6"/>'),
};

// ---------- estrutura ----------
const TABS: [Tab, string, string, string][] = [['marcar', 'Marcar', ICON.cut, '/'], ['marcacoes', 'Marcações', ICON.cal, '/marcacoes'], ['premios', 'Prémios', ICON.gift, '/premios'], ['sorteios', 'Sorteios', ICON.ticket, '/sorteios'], ['perfil', 'Perfil', ICON.user, '/perfil']];
function top(): string {
  return `<header class="bk-top"><a class="bk-logo" href="#/" aria-label="Rock n' Razor"><span class="bk-mark">${ICON.cut}</span><span class="bk-wordmark">Rock n' Razor</span></a><span class="bk-role">${me ? 'MEMBRO' : ''}</span></header>`;
}
function layout(inner: string, bar = ''): string {
  return `${top()}<main class="bk-main">${inner}</main>${bar}<nav class="bk-tabs" aria-label="Menu principal">${TABS.map(([id, label, icon, href]) => `<a class="bk-tab" href="#${href}" ${tab === id ? 'aria-current="page"' : ''}>${icon}<span>${label}</span></a>`).join('')}</nav>`;
}
const bar = (left: string, btn: string) => `<div class="bk-bar"><div>${left}</div>${btn}</div>`;
const stepNav = () => {
  const order: [Step, string][] = [['barber', 'Barbeiro'], ['services', 'Serviços'], ['time', 'Hora'], ['confirm', 'Confirmar']]; const idx = order.findIndex(o => o[0] === w.step);
  return `<ol class="bk-steps" aria-label="Passos">${order.map((o, i) => `<li ${i === idx ? 'aria-current="step"' : ''} class="${i < idx ? 'done' : ''}"><span>${i + 1}</span>${o[1]}</li>`).join('')}</ol>`;
};
const summary = (svcs: string[], emp: string, date?: DateStr, start?: number | null) => {
  const t = total(svcs, emp);
  return `<dl class="bk-sum"><div><dt>Serviços</dt><dd>${esc(svcNames(svcs))}</dd></div>${emp !== 'any' ? `<div><dt>Barbeiro</dt><dd>${esc(empName(emp))}</dd></div>` : ''}${date && start != null ? `<div><dt>Quando</dt><dd>${esc(dayLong(date))}, ${fmt(start)}</dd></div>` : ''}<div><dt>Duração e preço</dt><dd>${t.min} min · ${euro(t.cents)}</dd></div></dl>`;
};
const ccSelect = (name: string, val: string) => `<select name="${name}" aria-label="Indicativo">${COUNTRY_CODES.map(c => `<option ${c === val ? 'selected' : ''}>${c}</option>`).join('')}</select>`;

// ---------- login e registo ----------
function renderAuth() {
  const a = auth, reg = a.mode === 'register';
  root.innerHTML = `<header class="bk-top"><a class="bk-logo" href="#/" aria-label="Rock n' Razor"><span class="bk-mark">${ICON.cut}</span><span class="bk-wordmark">Rock n' Razor</span></a><span class="bk-role"></span></header>
    <main class="bk-main"><div class="bk-hero-auth"><small class="bk-eyebrow">ÁREA DO CLIENTE</small><h1 class="bk-h1">${reg ? 'Cria a tua conta' : 'Entra na tua conta'}</h1><p class="bk-muted">${reg ? 'Com a conta marcas em segundos, vês o teu histórico e juntas pontos.' : 'Marca o teu corte, vê as tuas marcações e os teus pontos.'}</p></div>
      ${a.error ? `<p class="bk-err" role="alert">${esc(a.error)}</p>` : ''}
      <form id="authf" class="bk-form" novalidate>
        ${reg ? `<label>Nome<input name="name" value="${esc(a.name)}" autocomplete="name" required></label>` : ''}
        <label>Telemóvel<span class="bk-phone">${ccSelect('cc', a.cc)}<input name="phone" inputmode="tel" autocomplete="tel-national" value="${esc(a.phone)}" required></span></label>
        ${reg ? `<label>E-mail <small>(opcional)</small><input name="email" type="email" autocomplete="email" value="${esc(a.email)}"></label>` : ''}
        <label>Palavra-passe${reg ? ' <small>(mínimo 8 caracteres)</small>' : ''}<input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" value="${esc(a.password)}" required></label>
        ${reg && a.needCode ? `<label>ID de membro<input name="memberCode" value="${esc(a.memberCode)}" placeholder="RNR-XXXXXX" autocapitalize="characters" autocomplete="off"></label>` : ''}
        ${reg ? `<label class="bk-check"><input type="checkbox" name="consent" ${a.consent ? 'checked' : ''}><span>Autorizo a Rock n' Razor a guardar o meu nome e telefone para gerir as minhas marcações e pontos.</span></label>` : ''}
        <button class="bk-btn wide" type="submit" ${a.busy ? 'disabled' : ''}>${a.busy ? 'A entrar…' : reg ? 'Criar conta' : 'Entrar'}</button>
      </form>
      <p class="bk-switch">${reg ? 'Já tens conta?' : 'Ainda não tens conta?'} <button type="button" class="bk-link" data-act="auth-mode">${reg ? 'Entrar' : 'Criar conta'}</button></p>
    </main>`;
}

// ---------- Marcar ----------
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

function renderMarcar() {
  const err = w.error ? `<p class="bk-err" role="alert">${esc(w.error)}</p>` : '';
  const first = (me?.name ?? '').split(' ')[0];
  if (w.step === 'home') {
    const next = list?.filter(b => b.status === 'confirmed' && localToEpochMs(b.date, b.endMin) > now()).sort((a, b) => (a.date + String(a.startMin).padStart(4, '0')).localeCompare(b.date + String(b.startMin).padStart(4, '0')))[0];
    root.innerHTML = layout(`<section class="bk-hero"><div class="bk-hero-art" aria-hidden="true"><span>${ICON.cut}</span></div><div class="bk-hero-body"><small class="bk-eyebrow">MARCAR O TEU CORTE</small><h1 class="bk-h1 bk-display">Pronto para o próximo corte${first ? ', ' + esc(first) : ''}?</h1><button class="bk-btn wide bk-cta" data-act="start">${ICON.cut}<span>Começar marcação</span>${ICON.arrow}</button></div></section>
      ${next ? `<a class="bk-next" href="#/marcacao/${next.id}"><small>A TUA PRÓXIMA MARCAÇÃO</small><b>${esc(dayLong(next.date))}, ${fmt(next.startMin)}</b><span>${esc(next.services.map(s => s.name).join(' + '))} · ${esc(empLabel(next.employee))}</span></a>` : ''}
      <div class="bk-note">${ICON.spark}<p>Cada marcação conta para a tua conta de membro. Os serviços registados na barbearia também ficam no teu perfil.</p></div>`);
  } else if (w.step === 'barber') {
    const opt = (id: string, name: string, sub: string) => `<label class="bk-card ${w.emp === id ? 'on' : ''}"><input type="radio" name="emp" value="${id}" ${w.emp === id ? 'checked' : ''}><span class="grow"><b>${esc(name)}</b><small>${esc(sub)}</small></span></label>`;
    root.innerHTML = layout(`${stepNav()}<button class="bk-back" data-act="back">‹ Voltar</button><h1 class="bk-h1">Com quem queres marcar?</h1>${err}<div class="bk-list">${opt('any', 'Qualquer barbeiro', 'Mostramos todas as horas livres da equipa')}${C!.employees.map(e => opt(e.id, empLabel(e), e.specialties || 'Barbeiro')).join('')}</div>`,
      bar('<span class="bk-muted">Passo 1 de 4</span>', `<button class="bk-btn" data-act="to-services">Continuar</button>`));
  } else if (w.step === 'services') {
    const ids = offered(w.emp); const l = C!.services.filter(s => ids.includes(s.id)); const t = total(w.svcs, w.emp);
    root.innerHTML = layout(`${stepNav()}<button class="bk-back" data-act="back">‹ Voltar</button><h1 class="bk-h1">Escolhe os serviços</h1>${err}<p class="bk-muted">${w.emp === 'any' ? 'Qualquer barbeiro' : esc(empName(w.emp))}</p><div class="bk-list">${l.map(s => `<label class="bk-card ${w.svcs.includes(s.id) ? 'on' : ''}"><input type="checkbox" name="svc" value="${s.id}" ${w.svcs.includes(s.id) ? 'checked' : ''}><span class="grow"><b>${esc(s.name)}</b><small>${dur(s.id, w.emp)} min</small></span><span class="price">${euro(s.priceCents)}</span></label>`).join('') || '<p class="bk-muted">Este barbeiro não tem serviços disponíveis online. Escolhe outro barbeiro.</p>'}</div>`,
      bar(w.svcs.length ? `<b>${t.min} min · ${euro(t.cents)}</b>` : '<span class="bk-muted">Escolhe pelo menos um serviço</span>', `<button class="bk-btn" data-act="to-time" ${w.svcs.length ? '' : 'disabled'}>Continuar</button>`));
  } else if (w.step === 'time') {
    root.innerHTML = layout(`${stepNav()}<button class="bk-back" data-act="back">‹ Voltar</button><h1 class="bk-h1">Escolhe o dia e a hora</h1>${err}<p class="bk-muted">${esc(svcNames(w.svcs))} · ${w.emp === 'any' ? 'qualquer barbeiro' : esc(empName(w.emp))}</p>${picker(w.p)}`);
  } else if (w.step === 'confirm') {
    const hold = w.hold ? Math.max(0, w.hold.until - now()) : 0;
    root.innerHTML = layout(`${stepNav()}<button class="bk-back" data-act="back">‹ Voltar</button><h1 class="bk-h1">Confirma a marcação</h1>${err}${summary(w.svcs, w.hold?.emp ?? w.emp, w.p.date, w.p.start)}<p class="bk-hold">Guardámos esta hora para ti durante <b id="hold-left">${Math.floor(hold / 60000)}:${String(Math.floor((hold % 60000) / 1000)).padStart(2, '0')}</b>.</p>
      <p class="bk-muted">Marcação em nome de <b>${esc(me!.name)}</b> · ${esc(me!.phone)}</p><button class="bk-btn wide" data-act="confirm" ${w.busy ? 'disabled' : ''}>${w.busy ? 'A confirmar…' : 'Confirmar marcação'}</button>`);
  } else {
    const d = w.done!;
    root.innerHTML = layout(`<div class="bk-ok" role="status"><span class="tick" aria-hidden="true">✓</span><h1 class="bk-h1">Marcação confirmada</h1></div>${summary(d.svcs, d.emp, d.date, d.start)}<p class="bk-muted">Barbeiro: <b>${esc(empName(d.emp))}</b>. Podes vê-la ou alterá-la em “Marcações”.</p>
      <div class="row"><a class="bk-btn" href="#/marcacao/${d.id}">Ver ou alterar</a><a class="bk-btn ghost" href="${icsHref(d.date, d.start, total(d.svcs, d.emp).min, `Rock n' Razor · ${svcNames(d.svcs)}`)}" download="marcacao-rock-n-razor.ics">Adicionar ao calendário</a><button class="bk-btn ghost" data-act="again">Nova marcação</button></div>`);
  }
}

function icsHref(date: DateStr, start: number, min: number, title: string): string {
  const z = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const s = localToEpochMs(date, start), e = localToEpochMs(date, start + min);
  const txt = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Rock n Razor//Marcacoes//PT', 'BEGIN:VEVENT', `UID:${s}-${start}@rockandrazor.com`, `DTSTAMP:${z(now())}`, `DTSTART:${z(s)}`, `DTEND:${z(e)}`, `SUMMARY:${title.replace(/[,;\n]/g, ' ')}`, 'LOCATION:Rock n Razor\\, Loures', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  return 'data:text/calendar;charset=utf-8,' + encodeURIComponent(txt);
}

// ---------- Marcações ----------
function renderMarcacoes() {
  if (!list) { root.innerHTML = layout('<h1 class="bk-h1">Marcações</h1><p class="bk-load">A abrir…</p>'); return; }
  const nowMs = now(); const key = (b: Booking) => b.date + String(b.startMin).padStart(4, '0');
  const up = list.filter(b => b.status === 'confirmed' && localToEpochMs(b.date, b.endMin) > nowMs).sort((a, b) => key(a).localeCompare(key(b)));
  const past = list.filter(b => !up.includes(b)).sort((a, b) => key(b).localeCompare(key(a)));
  const item = (b: Booking) => { const st = b.status === 'cancelled' ? ['Cancelada', 'bad'] : b.status === 'confirmed' && localToEpochMs(b.date, b.endMin) > nowMs ? ['Confirmada', 'ok'] : b.status === 'noshow' ? ['Faltou', 'bad'] : ['Concluída', '']; return `<a class="bk-item" href="#/marcacao/${b.id}"><b>${esc(dayLong(b.date))}, ${fmt(b.startMin)}</b><small>${esc(b.services.map(s => s.name).join(' + '))} · ${esc(empLabel(b.employee))}</small><span class="st ${st[1]}">${st[0]}</span></a>`; };
  root.innerHTML = layout(`<h1 class="bk-h1">Marcações</h1>${!list.length ? `<div class="bk-empty"><p>Ainda não tens marcações.</p><a class="bk-btn" href="#/">Marcar agora</a></div>` : `${up.length ? `<h2 class="bk-h3">Próximas</h2><div class="bk-list">${up.map(item).join('')}</div>` : '<p class="bk-muted">Não tens marcações futuras.</p><div class="row"><a class="bk-btn" href="#/">Marcar agora</a></div>'}${past.length ? `<h2 class="bk-h3" style="margin-top:18px">Anteriores</h2><div class="bk-list">${past.map(item).join('')}</div>` : ''}`}`);
}

function renderManage() {
  const m = mg!;
  if (m.loading) { root.innerHTML = layout('<p class="bk-load">A abrir a marcação…</p>'); return; }
  const b = m.b;
  if (!b) { root.innerHTML = layout(`<h1 class="bk-h1">Marcação não encontrada</h1><p class="bk-muted">${m.notFound ? 'Esta marcação não está na tua conta.' : esc(ERR.rede)}</p><p><a class="bk-link" href="#/marcacoes">‹ Marcações</a></p>`); return; }
  const err = m.error ? `<p class="bk-err" role="alert">${esc(m.error)}</p>` : '';
  const t = b.services.reduce((a, s) => ({ min: a.min + s.durationMin, cents: a.cents + s.priceCents }), { min: 0, cents: 0 });
  const sum = (date: DateStr, start: number) => `<dl class="bk-sum"><div><dt>Serviços</dt><dd>${esc(b.services.map(s => s.name).join(' + '))}</dd></div><div><dt>Barbeiro</dt><dd>${esc(empLabel(b.employee))}</dd></div><div><dt>Quando</dt><dd>${esc(dayLong(date))}, ${fmt(start)}</dd></div><div><dt>Duração e preço</dt><dd>${t.min} min · ${euro(t.cents)}</dd></div></dl>`;
  if (m.mode === 'cancelled' || b.status === 'cancelled') { root.innerHTML = layout(`<h1 class="bk-h1">Marcação cancelada</h1><p class="bk-muted">Já libertámos a hora. Esperamos ver-te em breve.</p><div class="row"><a class="bk-btn" href="#/">Fazer nova marcação</a><a class="bk-btn ghost" href="#/marcacoes">Marcações</a></div>`); return; }
  if (m.mode === 'resched') {
    root.innerHTML = layout(`<button class="bk-back" data-act="m-back">‹ Voltar</button><h1 class="bk-h1">Escolhe a nova hora</h1>${err}<p class="bk-muted">${esc(b.services.map(s => s.name).join(' + '))} · ${esc(empLabel(b.employee))}</p>${picker(m.p)}`,
      m.p.start != null && m.p.date ? bar(`<b>${esc(dayLong(m.p.date))}, ${fmt(m.p.start)}</b>`, `<button class="bk-btn" data-act="m-confirm">Confirmar nova hora</button>`) : '');
    return;
  }
  const over = localToEpochMs(b.date, b.endMin) <= now();
  root.innerHTML = layout(`<h1 class="bk-h1">${m.mode === 'moved' ? 'Hora alterada' : 'A tua marcação'}</h1>${err}${sum(b.date, b.startMin)}
    ${over ? '<p class="bk-muted">Esta marcação já passou.</p>' : b.canChange ? (m.confirmCancel ? `<div class="bk-warn" role="alertdialog" aria-label="Confirmar cancelamento"><p>Queres mesmo cancelar esta marcação?</p><div class="row"><button class="bk-btn ghost" data-act="m-keep">Manter</button><button class="bk-btn danger" data-act="m-cancel">Sim, cancelar</button></div></div>` : `<div class="row"><button class="bk-btn" data-act="m-resched">Mudar a hora</button><button class="bk-btn ghost" data-act="m-ask">Cancelar marcação</button><a class="bk-btn ghost" href="${icsHref(b.date, b.startMin, t.min, `Rock n' Razor · ${b.services.map(s => s.name).join(' + ')}`)}" download="marcacao-rock-n-razor.ics">Adicionar ao calendário</a></div>`) : `<p class="bk-muted">Já não é possível alterar online (faltam menos de ${Math.round(b.cancelLeadMin / 60)} horas). Fala com a barbearia.</p>`}
    <p style="margin-top:18px"><a class="bk-link" href="#/marcacoes">‹ Marcações</a></p>`);
}

// ---------- Prémios, Sorteios, Perfil ----------
function renderPremios() {
  const hist = pts?.history ?? [];
  root.innerHTML = layout(`<section class="bk-wallet"><small class="bk-eyebrow"># ${esc(me!.memberCode ?? '—')}</small><div class="bk-wlabel">CARTEIRA DE PRÉMIOS</div><div class="bk-points">${pts ? pts.balance : me!.points}</div><div class="bk-muted">Pontos disponíveis</div><hr><div class="bk-level"><div><small>NÍVEL DE MEMBRO</small><b>MEMBRO</b></div><span class="bk-muted">Mais níveis em breve</span></div></section>
    <h2 class="bk-eyebrow bk-sec">USA OS TEUS PONTOS</h2><div class="bk-box">Ainda não há prémios disponíveis. Volta em breve.</div>
    <h2 class="bk-eyebrow bk-sec">OS MEUS PRÉMIOS</h2><div class="bk-box">Ainda não tens vales. Troca pontos por um prémio quando estiverem disponíveis.</div>
    <h2 class="bk-eyebrow bk-sec">ATIVIDADE RECENTE</h2>${!pts ? '<div class="bk-box">A abrir…</div>' : hist.length ? `<div class="bk-list">${hist.map(h => `<div class="bk-act"><span><b>${esc(h.note || (h.delta > 0 ? 'Pontos ganhos' : 'Pontos usados'))}</b><small>${when(h.at)}</small></span><b class="${h.delta > 0 ? 'pos' : 'neg'}">${h.delta > 0 ? '+' : ''}${h.delta}</b></div>`).join('')}</div>` : '<div class="bk-box">Ainda sem atividade de pontos.</div>'}`);
}
function renderSorteios() {
  root.innerHTML = layout(`<h1 class="bk-h1">Sorteios</h1><div class="bk-box bk-soon">${ICON.ticket}<b>Em breve</b><span>Os sorteios da barbearia vão aparecer aqui. Assim que houver um aberto, podes participar com a tua conta.</span></div>`);
}
function renderPerfil() {
  const theme = store.get<string>('rr-theme', 'system');
  root.innerHTML = layout(`<h1 class="bk-h1">Perfil</h1>
    <div class="bk-member"><small>O teu ID de membro</small><b>${esc(me!.memberCode ?? '—')}</b></div>
    <h2 class="bk-h3">Os teus dados</h2>${pf.err ? `<p class="bk-err" role="alert">${esc(pf.err)}</p>` : ''}${pf.msg ? `<p class="bk-okmsg" role="status">${esc(pf.msg)}</p>` : ''}
    <form id="pff" class="bk-form" novalidate><label>Nome<input name="name" value="${esc(pf.name)}" autocomplete="name"></label><label>Telemóvel<input value="${esc(me!.phone)}" disabled></label><label>E-mail <small>(opcional)</small><input name="email" type="email" value="${esc(pf.email)}" autocomplete="email"></label><button class="bk-btn" type="submit">Guardar</button></form>
    <h2 class="bk-h3" style="margin-top:22px">Palavra-passe</h2>${pf.pwErr ? `<p class="bk-err" role="alert">${esc(pf.pwErr)}</p>` : ''}${pf.pwMsg ? `<p class="bk-okmsg" role="status">${esc(pf.pwMsg)}</p>` : ''}
    <form id="pwf" class="bk-form" novalidate><label>Palavra-passe atual<input name="current" type="password" autocomplete="current-password"></label><label>Nova palavra-passe <small>(mínimo 8 caracteres)</small><input name="next" type="password" autocomplete="new-password"></label><button class="bk-btn ghost" type="submit">Mudar palavra-passe</button></form>
    <h2 class="bk-h3" style="margin-top:22px">Aparência</h2><div class="bk-seg" role="group" aria-label="Tema">${[['system', 'Automático'], ['light', 'Claro'], ['dark', 'Escuro']].map(([v, l]) => `<button type="button" data-act="theme" data-v="${v}" aria-pressed="${theme === v}">${l}</button>`).join('')}</div>
    <div class="row" style="margin-top:26px"><button class="bk-btn ghost" data-act="logout">Sair da conta</button></div><p class="bk-tip">Rock n' Razor · Loures</p>`);
}

function render() {
  const keepY = window.scrollY;
  if (!C) { root.innerHTML = catErr ? `<div class="bk-load"><p>Não foi possível abrir as marcações.</p><button class="bk-btn" data-act="retry">Tentar outra vez</button></div>` : '<p class="bk-load">A abrir…</p>'; return; }
  if (!booted) { root.innerHTML = '<p class="bk-load">A abrir…</p>'; return; }
  if (!me) { renderAuth(); renderedKey = renderedKey === 'auth' ? 'auth' : (setFocus('auth'), 'auth'); return; }
  if (tab === 'marcar') renderMarcar(); else if (tab === 'marcacoes') mg ? renderManage() : renderMarcacoes(); else if (tab === 'premios') renderPremios(); else if (tab === 'sorteios') renderSorteios(); else renderPerfil();
  const key = tab === 'marcar' ? `m:${w.step}` : mg ? `g:${mg.mode}:${mg.loading}` : tab;
  const changed = key !== renderedKey; if (changed) setFocus(key); window.scrollTo(0, changed ? 0 : keepY);
  clearInterval(ticker); if (tab === 'marcar' && w.step === 'confirm') ticker = window.setInterval(tick, 1000);
}
function setFocus(key: string) { renderedKey = key; const h = root.querySelector<HTMLElement>('h1'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } }
function tick() {
  if (!w.hold) return; const left = w.hold.until - now(); const e = document.getElementById('hold-left');
  if (left <= 0) { w.hold = undefined; w.p.start = null; w.step = 'time'; w.error = 'O tempo da reserva acabou. Escolhe a hora outra vez.'; resetCounts(w.p); render(); loadCounts(w.p, render); return; }
  if (e) e.textContent = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
}
const release = () => { if (w?.hold) { api('DELETE', `/public/holds/${w.hold.id}`); w.hold = undefined; } };

// ---------- navegação ----------
async function loadList() { const r = await api<{ bookings: Booking[] }>('GET', '/client/bookings'); if (r.status === 401) return lostSession(); list = r.json?.bookings ?? []; }
function lostSession() { me = null; list = null; pts = null; auth.error = ERR.sem_sessao; render(); }
async function route() {
  if (!C || !booted) return;
  if (!me) return render();
  const h = location.hash.replace(/^#/, '') || '/';
  if (h.startsWith('/marcacao/')) {
    release(); tab = 'marcacoes'; const id = h.slice('/marcacao/'.length);
    if (!mg || mg.id !== id) { mg = { id, loading: true, mode: 'view', p: newPicker([], 'any'), confirmCancel: false, error: '' }; render(); const r = await api<{ booking: Booking }>('GET', `/client/bookings/${encodeURIComponent(id)}`); if (r.status === 401) return lostSession(); if (!mg || mg.id !== id) return; mg.loading = false; mg.notFound = r.status === 404; mg.b = r.json?.booking; }
    return render();
  }
  mg = null;
  if (h === '/marcacoes' || h === '/minhas') { release(); tab = 'marcacoes'; render(); await loadList(); return render(); }
  if (h === '/premios') { release(); tab = 'premios'; pts = null; render(); const r = await api('GET', '/client/points'); if (r.status === 401) return lostSession(); pts = r.json?.ok ? r.json : { balance: me.points, history: [] }; return render(); }
  if (h === '/sorteios') { release(); tab = 'sorteios'; return render(); }
  if (h === '/perfil') { release(); tab = 'perfil'; pf = { name: me.name, email: me.email, msg: '', err: '', pwMsg: '', pwErr: '' }; return render(); }
  tab = 'marcar'; if (!w) w = fresh(); render(); if (w.step === 'home' && !list) { await loadList(); if (tab === 'marcar' && w.step === 'home') render(); }
}

// ---------- eventos ----------
const onClick = (e: Event) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]'); if (!el) return; const act = el.dataset.act!, v = el.dataset.v;
  if (act === 'retry') { catErr = false; boot(); return; }
  if (act === 'theme') { store.set('rr-theme', v); applyTheme(); return render(); }
  if (act === 'auth-mode') { auth.mode = auth.mode === 'login' ? 'register' : 'login'; auth.error = ''; return render(); }
  if (act === 'logout') { release(); api('POST', '/client/logout', {}); me = null; list = null; pts = null; mg = null; w = fresh(); auth = { ...auth, mode: 'login', password: '', error: '', busy: false, needCode: false }; location.hash = '#/'; return render(); }
  if (!me) return;
  if (tab === 'marcacoes' && mg) return manageAct(act, v);
  if (tab !== 'marcar') return;
  w.error = '';
  if (act === 'start') { w.step = 'barber'; return render(); }
  if (act === 'again') { release(); w = fresh(); list = null; return route(); }
  if (act === 'to-services') { w.step = 'services'; w.svcs = w.svcs.filter(s => offered(w.emp).includes(s)); return render(); }
  if (act === 'to-time') { w.step = 'time'; w.p = newPicker(w.svcs, w.emp); render(); loadCounts(w.p, render); return; }
  if (act === 'back') { if (w.step === 'confirm') { release(); w.p.start = null; w.step = 'time'; resetCounts(w.p); render(); loadCounts(w.p, render); return; } w.step = ({ barber: 'home', services: 'barber', time: 'services' } as Record<string, Step>)[w.step] ?? 'home'; return render(); }
  if (act === 'more') { w.p.days = Math.min(maxDays(), w.p.days + 14); render(); loadCounts(w.p, render); return; }
  if (act === 'day') { w.p.date = v!; w.p.start = null; render(); loadSlots(w.p, render); return; }
  if (act === 'slot') return pickSlot(Number(v));
  if (act === 'confirm') return confirmBooking();
};
async function pickSlot(start: number) {
  w.p.start = start; release(); render();
  const r = await api('POST', '/public/holds', { date: w.p.date, startMin: start, serviceIds: w.svcs, employeeId: w.emp === 'any' ? undefined : w.emp });
  if (r.status !== 200 || !r.json?.ok) { w.error = errText(r.json); w.p.start = null; render(); loadSlots(w.p, render); return; }
  w.hold = { id: r.json.holdId, emp: r.json.employeeId, until: r.json.expiresAtMs }; w.step = 'confirm'; render();
}
async function confirmBooking() {
  if (w.busy) return; w.busy = true; render();
  const emp = w.hold?.emp ?? (w.emp === 'any' ? undefined : w.emp);
  const r = await api('POST', '/client/bookings', { date: w.p.date, startMin: w.p.start, serviceIds: w.svcs, employeeId: emp, holdId: w.hold?.id });
  w.busy = false;
  if (r.status === 401) return lostSession();
  w.hold = undefined;
  if (r.status !== 200 || !r.json?.ok) { w.error = errText(r.json); w.step = 'time'; w.p.start = null; resetCounts(w.p); render(); loadCounts(w.p, render); return; }
  w.done = { id: r.json.bookingId, emp: r.json.employeeId, date: w.p.date, start: w.p.start!, svcs: [...w.svcs] }; w.step = 'done'; list = null; render();
}
const onChange = (e: Event) => {
  const t = e.target as HTMLInputElement;
  if (!me) { if (t.name === 'cc') auth.cc = t.value; if (t.name === 'consent') auth.consent = t.checked; return; }
  if (tab !== 'marcar') return;
  if (t.name === 'emp') { w.emp = t.value; return render(); }
  if (t.name === 'svc') { w.svcs = C!.services.map(s => s.id).filter(id => id === t.value ? t.checked : w.svcs.includes(id)); return render(); }
};
const onInput = (e: Event) => {
  const t = e.target as HTMLInputElement;
  if (!me) { if (t.name === 'name') auth.name = t.value; if (t.name === 'phone') auth.phone = t.value; if (t.name === 'email') auth.email = t.value; if (t.name === 'password') auth.password = t.value; if (t.name === 'memberCode') auth.memberCode = t.value; return; }
  if (tab === 'perfil' && t.closest('#pff')) { if (t.name === 'name') pf.name = t.value; if (t.name === 'email') pf.email = t.value; }
};
async function onSubmit(e: Event) {
  e.preventDefault(); const id = (e.target as HTMLElement).id;
  if (id === 'authf') return submitAuth();
  if (id === 'pff' && me) {
    pf.msg = pf.err = ''; const r = await api('PATCH', '/client/me', { name: pf.name, email: pf.email });
    if (r.status === 401) return lostSession();
    if (r.json?.ok) { me = r.json.me; pf.msg = 'Dados guardados.'; } else pf.err = errText(r.json); return render();
  }
  if (id === 'pwf' && me) {
    pf.pwMsg = pf.pwErr = ''; const f = e.target as HTMLFormElement; const cur = (f.elements.namedItem('current') as HTMLInputElement).value, nx = (f.elements.namedItem('next') as HTMLInputElement).value;
    if (nx.length < 8) { pf.pwErr = 'A nova palavra-passe precisa de pelo menos 8 caracteres.'; return render(); }
    const r = await api('POST', '/client/password', { current: cur, next: nx });
    if (r.status === 401) return lostSession();
    if (r.json?.ok) pf.pwMsg = 'Palavra-passe alterada.'; else pf.pwErr = errText(r.json); return render();
  }
}
async function submitAuth() {
  const a = auth; if (a.busy) return; a.error = '';
  const digits = a.phone.replace(/\D/g, '');
  if (digits.length < 9 || a.password.length < 1) { a.error = 'Confirma o telemóvel e a palavra-passe.'; return render(); }
  if (a.mode === 'register') {
    if (a.name.trim().length < 2) { a.error = 'Escreve o teu nome.'; return render(); }
    if (a.password.length < 8) { a.error = 'A palavra-passe precisa de pelo menos 8 caracteres.'; return render(); }
    if (!a.consent) { a.error = 'Para criar a conta, precisamos da tua autorização para guardar o nome e o telefone.'; return render(); }
  }
  a.busy = true; render();
  const phone = `${a.cc} ${a.phone.trim()}`;
  const r = a.mode === 'login' ? await api('POST', '/client/login', { phone, password: a.password })
    : await api('POST', '/client/register', { name: a.name.trim(), phone, email: a.email.trim() || undefined, password: a.password, memberCode: a.memberCode.trim() || undefined, consent: true });
  a.busy = false;
  if (!r.json?.ok) { if (r.json?.error === 'codigo_necessario' || r.json?.error === 'codigo_errado') a.needCode = true; a.error = errText(r.json); return render(); }
  store.set('rr-phone', { cc: a.cc, phone: a.phone }); me = r.json.me; a.mode = 'login'; a.needCode = false; a.password = ''; a.memberCode = ''; w = fresh(); list = null;
  if (!location.hash || location.hash === '#') location.hash = '#/'; renderedKey = ''; await route();
}

async function manageAct(act: string, v?: string) {
  const m = mg!; const b = m.b; m.error = ''; if (!b) return;
  if (act === 'm-ask') { m.confirmCancel = true; return render(); }
  if (act === 'm-keep') { m.confirmCancel = false; return render(); }
  if (act === 'm-cancel') { const r = await api('POST', `/client/bookings/${b.id}/cancel`, {}); if (r.status === 401) return lostSession(); if (r.status !== 200) { m.error = errText(r.json); m.confirmCancel = false; } else { m.mode = 'cancelled'; list = null; } return render(); }
  if (act === 'm-resched') { m.mode = 'resched'; m.p = newPicker(b.services.map(s => s.id), b.employee.id, b.id); render(); loadCounts(m.p, render); return; }
  if (act === 'm-back') { m.mode = 'view'; return render(); }
  if (act === 'more') { m.p.days = Math.min(maxDays(), m.p.days + 14); render(); loadCounts(m.p, render); return; }
  if (act === 'day') { m.p.date = v!; m.p.start = null; render(); loadSlots(m.p, render); return; }
  if (act === 'slot') { m.p.start = Number(v); return render(); }
  if (act === 'm-confirm' && m.p.date && m.p.start != null) {
    const r = await api('POST', `/client/bookings/${b.id}/reschedule`, { date: m.p.date, startMin: m.p.start });
    if (r.status === 401) return lostSession();
    if (r.status !== 200) { m.error = errText(r.json); m.p.start = null; resetCounts(m.p); render(); loadCounts(m.p, render); return; }
    const g = await api<{ booking: Booking }>('GET', `/client/bookings/${b.id}`); if (g.json?.booking) m.b = g.json.booking; m.mode = 'moved'; list = null; render();
  }
}

function applyTheme() { const t = store.get<string>('rr-theme', 'system'); t === 'system' ? document.documentElement.removeAttribute('data-theme') : document.documentElement.setAttribute('data-theme', t); }
async function boot() {
  const [c, m] = await Promise.all([api<Catalog & { ok: boolean }>('GET', '/public/catalog'), api('GET', '/client/me')]);
  if (c.status !== 200 || !c.json?.ok) { catErr = true; return render(); }
  C = c.json; me = m.json?.ok ? m.json.me : null; w = fresh(); booted = true;
  const last = store.get<{ cc: string; phone: string }>('rr-phone', { cc: '+351', phone: '' }); auth.cc = last.cc; auth.phone = last.phone;
  await route(); if (!me) render();
}
root = document.getElementById('app')!; applyTheme();
root.addEventListener('click', onClick); root.addEventListener('change', onChange); root.addEventListener('input', onInput); root.addEventListener('submit', onSubmit);
window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => { if (w?.hold) fetch(`/public/holds/${w.hold.id}`, { method: 'DELETE', keepalive: true }).catch(() => {}); });
// ao voltar à app (iPhone), as horas podem ter mudado: volta a ler
document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible' || !C || !me) return; if (tab === 'marcar' && w.step === 'time') { resetCounts(w.p); render(); loadCounts(w.p, render); } else if (tab === 'marcacoes' && !mg) route(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* sem instalação */ });
(window as any).__bk = { get w() { return w; } };
boot();
