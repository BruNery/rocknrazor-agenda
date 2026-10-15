import { addDays, type DateStr } from '@rr/domain';
import type { Live } from './live';
import { fmt } from './store';

/** Ecrãs de gestão. "Definições" é só do administrador (o servidor recusa os outros); "O meu horário" é de cada barbeiro. */
export type Tab = 'regras' | 'equipa' | 'servicos' | 'produtos' | 'horario' | 'pontos';
export interface Deps { live: Live; render(): void; toast(t: string): void; reload(): Promise<void>; isAdmin(): boolean; today(): DateStr; emp(): string }
interface PCust { id: number; name: string; phone: string; email: string; memberCode: string | null; points: number }
export const C = {
  tab: 'equipa' as Tab, users: [] as { id: number; username: string; role: string; employeeId: string | null; active: boolean }[],
  q: '', found: [] as PCust[], sel: null as null | { id: number; name: string; memberCode: string | null; balance: number; history: { delta: number; kind: string; note: string; at: string }[] },
  mineEmp: '', blocks: [] as { id: string; date: string; allDay: boolean; startMin: number | null; endMin: number | null; reason: string | null }[], pauses: [] as { id: number; weekday: number; startMin: number; endMin: number; label: string }[],
};
const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const WD = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const cents = (v: string) => Math.round(Number(String(v).replace(',', '.') || 0) * 100);
const eurIn = (c: number) => (c / 100).toFixed(2);
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const ERR: Record<string, string> = { ja_existe: 'Já existe um com esse identificador.', referencia_invalida: 'Referência inválida.', sem_permissao: 'Sem permissão.', saldo_insuficiente: 'O saldo de pontos não pode ficar negativo.', utilizador_ja_existe: 'Esse nome de utilizador já existe.', pedido_invalido: 'Dados inválidos. Confirma os campos.', nao_encontrado: 'Não encontrado.', barbeiro_precisa_de_colaborador: 'Falta o barbeiro.', palavra_passe_atual_errada: 'A palavra-passe atual não está certa.', demasiadas_tentativas: 'Demasiadas tentativas. Espera uns minutos.' };
const err = (j: any) => ERR[j?.error] ?? 'Não foi possível guardar. Tenta outra vez.';
const TABS: [Tab, string][] = [['equipa', 'Equipa'], ['servicos', 'Serviços'], ['produtos', 'Produtos'], ['horario', 'Horário da loja'], ['regras', 'Regras de marcação'], ['pontos', 'Pontos']];

export async function loadCfg(d: Deps) {
  if (d.isAdmin()) { const u = await d.live.req('GET', '/admin/users'); if (u.status === 200) C.users = u.json.users; }
  d.render();
}
export async function loadMine(d: Deps) {
  const emp = d.isAdmin() ? (C.mineEmp || d.emp()) : d.live.me!.employeeId!; C.mineEmp = emp;
  const r = await d.live.req('GET', `/hq/availability?employeeId=${emp}&from=${d.today()}&to=${addDays(d.today(), 90)}`);
  if (r.status === 200) { C.blocks = r.json.blocks; C.pauses = r.json.pauses; } d.render();
}

export function cfgHtml(d: Deps): string {
  const cat = d.live.cat;
  const tabs = `<div class="seg cfgtabs" role="group" aria-label="Definições">${TABS.map(([k, l]) => `<button data-cfg="tab" data-v="${k}" aria-pressed="${C.tab === k}">${l}</button>`).join('')}</div>`;
  let body = '';
  if (C.tab === 'regras') {
    const r = cat.rules; const h = (m: number) => String(+(m / 60).toFixed(2));
    body = `<form class="card cfgform" data-cfg="rules"><h3>Regras de marcação online</h3><p class="muted">Valem já para os novos pedidos dos clientes. O HQ continua a poder marcar fora destas regras.</p>
      <div class="two"><div class="field"><label>Reserva temporária do horário (minutos)</label><input name="holdMin" type="number" min="1" max="30" value="${r.holdMin}"></div>
      <div class="field"><label>Cliente pode cancelar/remarcar até (horas antes)</label><input name="cancelH" type="number" min="0" max="168" step="0.25" value="${h(r.cancelLeadMin)}"></div></div>
      <div class="two"><div class="field"><label>Marcar com antecedência mínima de (horas)</label><input name="leadH" type="number" min="0" max="24" step="0.25" value="${h(r.lastBookingLeadMin)}"></div>
      <div class="field"><label>Marcar até (semanas à frente)</label><input name="weeks" type="number" min="1" max="52" value="${r.maxWeeksAhead}"></div></div>
      <div class="two"><div class="field"><label>Horários que o cliente vê (de quantos em quantos minutos)</label><select name="grid">${[5, 10, 15, 20, 30, 60].map(v => `<option ${v === r.gridMin ? 'selected' : ''} value="${v}">${v} min</option>`).join('')}</select></div>
      <div class="field"><label>Máximo de marcações em aberto por telefone (0 = sem limite)</label><input name="open" type="number" min="0" max="20" value="${r.maxOpenOnline}"></div></div>
      <div class="field"><label>"Qualquer barbeiro" escolhe</label><select name="policy"><option value="fewest_bookings" ${r.anyBarberPolicy === 'fewest_bookings' ? 'selected' : ''}>o que tem menos marcações nesse dia</option><option value="first_in_order" ${r.anyBarberPolicy === 'first_in_order' ? 'selected' : ''}>o primeiro pela ordem da equipa</option></select></div>
      <label class="chk"><input name="snap" type="checkbox" ${r.snapAfterEnd !== false ? 'checked' : ''}> Mostrar também a hora logo a seguir ao fim de outra marcação (ex.: 12:40), para a agenda não ficar com buracos</label>
      <label class="chk"><input name="overlap" type="checkbox" ${r.allowOnlineOverlap ? 'checked' : ''}> Permitir que o online sobreponha outras marcações (nunca sobrepõe pausas nem bloqueios)</label>
      <div class="acts"><button class="btn primary" type="submit">Guardar regras</button></div></form>`;
  } else if (C.tab === 'equipa') {
    body = `<form class="card cfgform" data-cfg="emp-new"><h3>Adicionar barbeiro</h3><div class="two"><div class="field"><label>Nome</label><input name="name" required maxlength="80"></div><div class="field"><label>Alcunha</label><input name="nick" maxlength="40"></div></div><div class="acts"><button class="btn primary" type="submit">Adicionar</button></div></form>`
      + cat.employees.map(e => {
        const u = C.users.find(x => x.employeeId === e.id);
        const offers = cat.services.filter(s => s.active).map(s => { const o = cat.offers.find(x => x.employeeId === e.id && x.serviceId === s.id); return `<div class="line"><span>${esc(s.name)}</span><span class="offer"><label><input type="checkbox" name="do-${s.id}" ${o ? 'checked' : ''}> faz</label> <label><input type="checkbox" name="on-${s.id}" ${o?.onlineAvailable !== false ? 'checked' : ''}> online</label> <input type="number" name="du-${s.id}" min="5" max="480" placeholder="${s.durationMin}" value="${o?.durationMin ?? ''}" aria-label="Duração própria (min)" title="Duração própria em minutos (vazio = a do serviço)"></span></div>`; }).join('');
        return `<section class="card ${e.active ? '' : 'off'}"><div class="dcrow"><h3>${esc(e.name)}${e.nickname ? ` (${esc(e.nickname)})` : ''}</h3>${e.active ? '' : '<span class="pill bad">Desativado</span>'}</div>
        <form class="cfgform" data-cfg="emp-save" data-id="${e.id}"><div class="two"><div class="field"><label>Nome</label><input name="name" value="${esc(e.name)}" required></div><div class="field"><label>Alcunha</label><input name="nick" value="${esc(e.nickname ?? '')}"></div></div>
        <div class="field"><label>Especialidades (aparecem na marcação online)</label><input name="spec" value="${esc(e.specialties)}" maxlength="160"></div>
        <div class="two"><div class="field"><label>Ordem na lista</label><input name="order" type="number" min="0" max="999" value="${e.order}"></div><div class="field"><label>Estado</label><select name="active"><option value="1" ${e.active ? 'selected' : ''}>Ativo</option><option value="0" ${e.active ? '' : 'selected'}>Desativado (some da agenda e do online; o histórico fica)</option></select></div></div>
        <label class="chk"><input name="online" type="checkbox" ${e.availableOnline ? 'checked' : ''}> Aparece na marcação online</label> <label class="chk"><input name="auto" type="checkbox" ${e.autoAssign ? 'checked' : ''}> Entra em "qualquer barbeiro"</label>
        <div class="acts"><button class="btn primary" type="submit">Guardar</button></div></form>
        <details><summary>Serviços que faz</summary><form class="cfgform" data-cfg="emp-svc" data-id="${e.id}">${offers || '<p class="muted">Ainda não há serviços.</p>'}<div class="acts"><button class="btn" type="submit">Guardar serviços</button></div></form></details>
        <details><summary>Acesso à app ${u ? (u.active ? '· ativo' : '· desativado') : '· sem acesso'}</summary>${u
          ? `<p class="muted">Utilizador: <b>${esc(u.username)}</b></p><form class="cfgform" data-cfg="pw" data-uid="${u.id}"><div class="field"><label>Nova palavra-passe (mín. 10 caracteres)</label><input name="pw" type="password" minlength="10" autocomplete="new-password" required></div><div class="acts"><button class="btn" type="submit">Repor palavra-passe</button><button type="button" class="btn ${u.active ? 'danger' : ''}" data-cfg="${u.active ? 'user-off' : 'user-on'}" data-uid="${u.id}">${u.active ? 'Desativar acesso' : 'Reativar acesso'}</button></div></form>`
          : `<form class="cfgform" data-cfg="user-new" data-id="${e.id}"><div class="two"><div class="field"><label>Nome de utilizador</label><input name="user" required pattern="[a-z0-9._\-]{3,40}" placeholder="ex.: andre" autocapitalize="none"></div><div class="field"><label>Palavra-passe (mín. 10)</label><input name="pw" type="password" minlength="10" autocomplete="new-password" required></div></div><div class="acts"><button class="btn primary" type="submit">Criar acesso</button></div></form>`}</details></section>`;
      }).join('');
  } else if (C.tab === 'servicos') {
    body = `<form class="card cfgform" data-cfg="svc-new"><h3>Adicionar serviço</h3><div class="two"><div class="field"><label>Nome</label><input name="name" required></div><div class="field"><label>Preço (€)</label><input name="price" type="number" step="0.01" min="0" required></div></div><div class="two"><div class="field"><label>Duração (min)</label><input name="dur" type="number" min="5" max="480" step="5" required></div><div class="field"><label>Pausa depois (min)</label><input name="pause" type="number" min="0" max="120" value="0"></div></div><div class="acts"><button class="btn primary" type="submit">Adicionar</button></div></form>`
      + cat.services.map(s => `<form class="card cfgform ${s.active ? '' : 'off'}" data-cfg="svc-save" data-id="${s.id}"><div class="two"><div class="field"><label>Nome</label><input name="name" value="${esc(s.name)}" required></div><div class="field"><label>Preço (€)</label><input name="price" type="number" step="0.01" min="0" value="${eurIn(s.priceCents)}"></div></div>
        <div class="two"><div class="field"><label>Duração (min)</label><input name="dur" type="number" min="5" max="480" step="5" value="${s.durationMin}"></div><div class="field"><label>Pausa depois (min)</label><input name="pause" type="number" min="0" max="120" value="${s.pauseMin}"></div></div>
        <div class="two"><div class="field"><label>Preço em pontos (vazio = não se paga com pontos)</label><input name="pts" type="number" min="1" value="${s.pointsPrice ?? ''}"></div><div class="field"><label>Estado</label><select name="active"><option value="1" ${s.active ? 'selected' : ''}>Ativo</option><option value="0" ${s.active ? '' : 'selected'}>Desativado</option></select></div></div>
        <div class="acts"><button class="btn primary" type="submit">Guardar</button></div></form>`).join('');
  } else if (C.tab === 'produtos') {
    body = `<form class="card cfgform" data-cfg="prod-new"><h3>Adicionar produto</h3><div class="two"><div class="field"><label>Nome</label><input name="name" required></div><div class="field"><label>Preço (€)</label><input name="price" type="number" step="0.01" min="0" required></div></div><div class="field"><label>Stock (vazio = não controlar)</label><input name="stock" type="number" min="0"></div><div class="acts"><button class="btn primary" type="submit">Adicionar</button></div></form>`
      + cat.products.map(p => `<form class="card cfgform ${p.active ? '' : 'off'}" data-cfg="prod-save" data-id="${p.id}"><div class="two"><div class="field"><label>Nome</label><input name="name" value="${esc(p.name)}" required></div><div class="field"><label>Preço (€)</label><input name="price" type="number" step="0.01" min="0" value="${eurIn(p.priceCents)}"></div></div>
        <div class="two"><div class="field"><label>Stock (vazio = não controlar)</label><input name="stock" type="number" min="0" value="${p.stock ?? ''}"></div><div class="field"><label>Estado</label><select name="active"><option value="1" ${p.active ? 'selected' : ''}>À venda</option><option value="0" ${p.active ? '' : 'selected'}>Desativado</option></select></div></div>
        <div class="acts"><button class="btn primary" type="submit">Guardar</button></div></form>`).join('') || '<p class="muted">Ainda não há produtos.</p>';
  } else if (C.tab === 'horario') {
    body = `<form class="card cfgform" data-cfg="hours"><h3>Horário de funcionamento da loja</h3><p class="muted">A pausa de almoço de cada barbeiro define-se em "O meu horário".</p>${[1, 2, 3, 4, 5, 6, 0].map(w => { const h = cat.hours.find(x => x.weekday === w); return `<div class="line"><label><input type="checkbox" name="o${w}" ${h ? 'checked' : ''}> ${WD[w]}</label><span><input type="time" name="a${w}" step="300" value="${fmt(h?.openMin ?? 540)}"> – <input type="time" name="b${w}" step="300" value="${fmt(h?.closeMin ?? 1140)}"></span></div>`; }).join('')}<div class="acts"><button class="btn primary" type="submit">Guardar horário</button></div></form>`;
  } else if (C.tab === 'pontos') {
    const s = C.sel;
    body = `<form class="card cfgform" data-cfg="pts-search"><h3>Pontos dos clientes</h3><div class="field"><label>Procurar por nome, telefone ou ID (RNR-…)</label><input name="q" value="${esc(C.q)}" placeholder="ex.: Rui, 913357837, RNR-AB12CD"></div><div class="acts"><button class="btn primary" type="submit">Procurar</button></div>
      ${C.found.length ? `<ul class="plist">${C.found.map(c => `<li><button type="button" class="btn" data-cfg="pts-pick" data-id="${c.id}">${esc(c.name)} · ${esc(c.phone)} · <b>${c.points} pts</b>${c.memberCode ? ` · ${c.memberCode}` : ''}</button></li>`).join('')}</ul>` : C.q ? '<p class="muted">Nenhum cliente encontrado.</p>' : ''}</form>`
      + (s ? `<section class="card"><div class="dcrow"><h3>${esc(s.name)}</h3><b>${s.balance} pontos</b></div><p class="muted">${s.memberCode ? `ID de membro: <b>${s.memberCode}</b>` : 'Ainda sem ID de membro (é criado no primeiro ajuste).'}</p>
        <form class="cfgform" data-cfg="pts-adjust"><div class="two"><div class="field"><label>Ação</label><select name="dir"><option value="1">Somar pontos</option><option value="-1">Retirar pontos</option></select></div><div class="field"><label>Pontos</label><input name="n" type="number" min="1" max="100000" required></div></div><div class="field"><label>Motivo (obrigatório, fica registado)</label><input name="note" required minlength="3" maxlength="200"></div><div class="acts"><button class="btn primary" type="submit">Aplicar</button></div></form>
        <h4>Histórico</h4>${s.history.length ? `<ul class="log">${s.history.map(h => `<li>${new Date(h.at).toLocaleDateString('pt-PT')} · <b>${h.delta > 0 ? '+' : ''}${h.delta}</b> · ${esc(h.note || h.kind)}</li>`).join('')}</ul>` : '<p class="muted">Sem movimentos.</p>'}</section>` : '');
  }
  return `<div class="cfg"><h2>Definições</h2>${tabs}${body}</div>`;
}

export function mineHtml(d: Deps): string {
  const cat = d.live.cat; const emp = C.mineEmp;
  const sel = d.isAdmin() ? `<div class="field"><label>Barbeiro</label><select id="mine-emp" data-cfg="mine-emp">${cat.employees.filter(e => e.active).map(e => `<option value="${e.id}" ${e.id === emp ? 'selected' : ''}>${esc(e.name)}${e.nickname ? ` (${esc(e.nickname)})` : ''}</option>`).join('')}</select></div>` : '';
  return `<div class="cfg"><h2>O meu horário</h2><p class="muted">Aqui fechas e abres o teu horário quando quiseres. As marcações que já tens não são canceladas: tratas delas na agenda.</p>${sel}
   <section class="card"><h3>Pausas que se repetem toda a semana</h3>${C.pauses.length ? `<ul class="plist">${C.pauses.map(p => `<li>${WD[p.weekday]} · ${fmt(p.startMin)}–${fmt(p.endMin)}${p.label ? ` · ${esc(p.label)}` : ''} <button class="btn danger" data-cfg="pause-del" data-id="${p.id}">Remover</button></li>`).join('')}</ul>` : '<p class="muted">Sem pausas.</p>'}
    <form class="cfgform" data-cfg="pause-add"><div class="two"><div class="field"><label>Dia</label><select name="wd"><option value="all">Segunda a sábado</option>${[1, 2, 3, 4, 5, 6].map(w => `<option value="${w}">${WD[w]}</option>`).join('')}</select></div><div class="field"><label>Nome (opcional)</label><input name="label" placeholder="Almoço" maxlength="60"></div></div><div class="two"><div class="field"><label>Das</label><input type="time" name="a" step="300" value="13:00" required></div><div class="field"><label>Às</label><input type="time" name="b" step="300" value="14:00" required></div></div><div class="acts"><button class="btn primary" type="submit">Adicionar pausa</button></div></form></section>
   <section class="card"><h3>Fechar um dia ou uma janela</h3>${C.blocks.length ? `<ul class="plist">${C.blocks.map(b => `<li>${b.date.split('-').reverse().join('/')} · ${b.allDay ? 'dia inteiro' : `${fmt(b.startMin!)}–${fmt(b.endMin!)}`}${b.reason ? ` · ${esc(b.reason)}` : ''} <button class="btn danger" data-cfg="block-del" data-id="${b.id}">Reabrir</button></li>`).join('')}</ul>` : '<p class="muted">Nada fechado nos próximos 90 dias.</p>'}
    <form class="cfgform" data-cfg="block-add"><div class="two"><div class="field"><label>Dia</label><input type="date" name="date" min="${d.today()}" value="${d.today()}" required></div><div class="field"><label>Motivo (opcional)</label><input name="reason" maxlength="120"></div></div><label class="chk"><input type="checkbox" name="all" checked> Dia inteiro</label><div class="two"><div class="field"><label>Das</label><input type="time" name="a" step="300" value="09:00"></div><div class="field"><label>Às</label><input type="time" name="b" step="300" value="19:00"></div></div><div class="acts"><button class="btn primary" type="submit">Fechar</button></div></form></section>
   <section class="card"><h3>A minha conta</h3><form class="cfgform" data-cfg="mypw"><div class="field"><label>Palavra-passe atual</label><input name="cur" type="password" autocomplete="current-password" required></div><div class="two"><div class="field"><label>Nova palavra-passe (mín. 10 caracteres)</label><input name="pw" type="password" minlength="10" autocomplete="new-password" required></div><div class="field"><label>Repetir a nova</label><input name="pw2" type="password" minlength="10" autocomplete="new-password" required></div></div><div class="acts"><button class="btn primary" type="submit">Mudar a palavra-passe</button></div></form></section></div>`;
}

const val = (f: HTMLFormElement, n: string) => (f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '';
const chk = (f: HTMLFormElement, n: string) => !!(f.elements.namedItem(n) as HTMLInputElement | null)?.checked;

async function done(d: Deps, p: Promise<{ status: number; json: any }>, ok: string, then?: () => Promise<void> | void) {
  const r = await p; if (r.status === 200) { if (then) await then(); await d.reload(); d.toast(ok); return r; } d.toast(err(r.json)); return r;
}

/** Cliques das áreas de gestão. Devolve true se tratou o clique. */
export function cfgClick(t: HTMLElement, d: Deps): boolean {
  const el = t.closest<HTMLElement>('[data-cfg]'); if (!el || el.tagName === 'FORM') return false; const a = el.dataset.cfg!, v = el.dataset.v, id = el.dataset.id, live = d.live;
  if (a === 'tab') { C.tab = v as Tab; d.render(); if (C.tab === 'equipa') loadCfg(d); return true; }
  if (a === 'user-off' || a === 'user-on') { done(d, live.req('POST', `/admin/users/${el.dataset.uid}/${a === 'user-off' ? 'deactivate' : 'activate'}`, {}), a === 'user-off' ? 'Acesso desativado' : 'Acesso reativado', () => loadCfg(d)); return true; }
  if (a === 'pts-pick') { live.req('GET', `/admin/customers/${id}/points`).then(r => { if (r.status !== 200) return d.toast(err(r.json)); const c = C.found.find(x => String(x.id) === id)!; C.sel = { id: Number(id), name: c.name, memberCode: r.json.memberCode, balance: r.json.balance, history: r.json.history }; d.render(); }); return true; }
  if (a === 'pause-del') { const rest = C.pauses.filter(p => String(p.id) !== id).map(p => ({ weekday: p.weekday, startMin: p.startMin, endMin: p.endMin, label: p.label })); done(d, live.req('PUT', '/hq/pauses', { employeeId: C.mineEmp, pauses: rest }), 'Pausa removida', () => loadMine(d)); return true; }
  if (a === 'block-del') { done(d, live.req('DELETE', `/hq/blocks/${id}`), 'Horário reaberto', () => loadMine(d)); return true; }
  return false;
}
export function cfgChange(t: HTMLElement, d: Deps): boolean { if (t.dataset.cfg === 'mine-emp') { C.mineEmp = (t as HTMLSelectElement).value; loadMine(d); return true; } return false; }

/** Formulários das áreas de gestão. Devolve true se tratou. */
export function cfgSubmit(f: HTMLFormElement, d: Deps): boolean {
  const a = f.dataset.cfg; if (!a) return false; const id = f.dataset.id, live = d.live, cat = live.cat;
  if (a === 'rules') { done(d, live.req('PUT', '/admin/settings', { gridMin: Number(val(f, 'grid')), maxWeeksAhead: Number(val(f, 'weeks')), lastBookingLeadMin: Math.round(Number(val(f, 'leadH')) * 60), cancelLeadMin: Math.round(Number(val(f, 'cancelH')) * 60), holdMin: Number(val(f, 'holdMin')), maxOpenOnline: Number(val(f, 'open')), allowOnlineOverlap: chk(f, 'overlap'), snapAfterEnd: chk(f, 'snap'), anyBarberPolicy: val(f, 'policy') }), 'Regras guardadas'); return true; }
  if (a === 'emp-new') { const name = val(f, 'name').trim(); done(d, live.req('POST', '/admin/employees', { id: slug(name) || 'barbeiro', name, nickname: val(f, 'nick').trim() || null, order: cat.employees.length + 1 }), 'Barbeiro adicionado'); return true; }
  if (a === 'emp-save') { done(d, live.req('PATCH', `/admin/employees/${id}`, { name: val(f, 'name').trim(), nickname: val(f, 'nick').trim() || null, specialties: val(f, 'spec'), order: Number(val(f, 'order')), active: val(f, 'active') === '1', availableOnline: chk(f, 'online'), autoAssign: chk(f, 'auto') }), 'Barbeiro guardado'); return true; }
  if (a === 'emp-svc') { const services = cat.services.filter(s => s.active && chk(f, `do-${s.id}`)).map(s => ({ serviceId: s.id, onlineAvailable: chk(f, `on-${s.id}`), calendarAvailable: true, durationMin: val(f, `du-${s.id}`) ? Number(val(f, `du-${s.id}`)) : null })); done(d, live.req('PUT', `/admin/employees/${id}/services`, { services }), 'Serviços guardados'); return true; }
  if (a === 'user-new') { done(d, live.req('POST', '/admin/users', { username: val(f, 'user').trim().toLowerCase(), password: val(f, 'pw'), role: 'barber', employeeId: id }), 'Acesso criado', () => loadCfg(d)); return true; }
  if (a === 'mypw') { if (val(f, 'pw') !== val(f, 'pw2')) { d.toast('As duas palavras-passe novas não são iguais.'); return true; } done(d, live.req('POST', '/auth/password', { current: val(f, 'cur'), password: val(f, 'pw') }), 'Palavra-passe mudada', () => f.reset()); return true; }
  if (a === 'pw') { done(d, live.req('POST', `/admin/users/${f.dataset.uid}/password`, { password: val(f, 'pw') }), 'Palavra-passe reposta; as sessões abertas foram terminadas'); return true; }
  const svcBody = () => ({ name: val(f, 'name').trim(), priceCents: cents(val(f, 'price')), durationMin: Number(val(f, 'dur')), pauseMin: Number(val(f, 'pause') || 0) });
  if (a === 'svc-new') { const b = svcBody(); done(d, live.req('POST', '/admin/services', { id: slug(b.name) || 'servico', ...b, order: cat.services.length + 1 }), 'Serviço adicionado'); return true; }
  if (a === 'svc-save') { done(d, live.req('PATCH', `/admin/services/${id}`, { ...svcBody(), active: val(f, 'active') === '1', pointsPrice: val(f, 'pts') ? Number(val(f, 'pts')) : null }), 'Serviço guardado'); return true; }
  const stock = () => (val(f, 'stock') === '' ? null : Number(val(f, 'stock')));
  if (a === 'prod-new') { const name = val(f, 'name').trim(); done(d, live.req('POST', '/admin/products', { id: slug(name) || 'produto', name, priceCents: cents(val(f, 'price')), stock: stock(), order: cat.products.length + 1 }), 'Produto adicionado'); return true; }
  if (a === 'prod-save') { done(d, live.req('PATCH', `/admin/products/${id}`, { name: val(f, 'name').trim(), priceCents: cents(val(f, 'price')), stock: stock(), active: val(f, 'active') === '1' }), 'Produto guardado'); return true; }
  if (a === 'hours') { const hours = [0, 1, 2, 3, 4, 5, 6].filter(w => chk(f, `o${w}`)).map(w => ({ weekday: w, openMin: toMin(val(f, `a${w}`)), closeMin: toMin(val(f, `b${w}`)) })); if (hours.some(h => h.closeMin <= h.openMin)) { d.toast('A hora de fecho tem de ser depois da de abertura.'); return true; } done(d, live.req('PUT', '/admin/opening-hours', { hours }), 'Horário guardado'); return true; }
  if (a === 'pts-search') { C.q = val(f, 'q').trim(); live.req('GET', `/admin/customers?q=${encodeURIComponent(C.q)}`).then(r => { C.found = r.status === 200 ? r.json.customers : []; C.sel = null; d.render(); }); return true; }
  if (a === 'pts-adjust' && C.sel) { const id2 = C.sel.id; const delta = Number(val(f, 'dir')) * Math.floor(Number(val(f, 'n'))); live.req('POST', `/admin/customers/${id2}/points`, { delta, note: val(f, 'note').trim() }).then(async r => { if (r.status !== 200) return d.toast(err(r.json)); const h = await live.req('GET', `/admin/customers/${id2}/points`); if (C.sel) { C.sel.balance = h.json.balance; C.sel.memberCode = h.json.memberCode; C.sel.history = h.json.history; } const f2 = C.found.find(x => x.id === id2); if (f2) f2.points = h.json.balance; d.toast('Pontos atualizados'); d.render(); }); return true; }
  if (a === 'pause-add') { const wd = val(f, 'wd'); const s = toMin(val(f, 'a')), e = toMin(val(f, 'b')); if (e <= s) { d.toast('A hora final tem de ser depois da inicial.'); return true; }
    const add = (wd === 'all' ? [1, 2, 3, 4, 5, 6] : [Number(wd)]).map(w => ({ weekday: w, startMin: s, endMin: e, label: val(f, 'label') }));
    const all = [...C.pauses.map(p => ({ weekday: p.weekday, startMin: p.startMin, endMin: p.endMin, label: p.label })), ...add];
    done(d, live.req('PUT', '/hq/pauses', { employeeId: C.mineEmp, pauses: all }), 'Pausa adicionada', () => loadMine(d)); return true; }
  if (a === 'block-add') { const all = chk(f, 'all'); const s = toMin(val(f, 'a')), e = toMin(val(f, 'b')); if (!all && e <= s) { d.toast('A hora final tem de ser depois da inicial.'); return true; }
    live.req('POST', '/hq/blocks', { employeeId: C.mineEmp, date: val(f, 'date'), allDay: all, startMin: all ? undefined : s, endMin: all ? undefined : e, reason: val(f, 'reason') || undefined }).then(async r => { if (r.status !== 200) return d.toast(err(r.json)); await loadMine(d); await d.reload(); d.toast(r.json.bookingsInside ? `Fechado. Atenção: há ${r.json.bookingsInside} marcação(ões) nessa janela. Trata delas na agenda.` : 'Horário fechado'); }); return true; }
  return false;
}
