import { describe, it, expect } from 'vitest';
import { computeAvailability, findConflicts, assignEmployee, canCancelOrReschedule, expandWeekly, localToEpochMs, totalDuration, type Ctx } from '../src';

const hours = Object.fromEntries([1, 2, 3, 4, 5, 6].map(d => [d, [{ open: 540, close: 1140 }]]));
const base = (over: Partial<Ctx> = {}): Ctx => ({
  openingHours: hours,
  services: [{ id: 'corte', durationMin: 40 }, { id: 'barba', durationMin: 20 }, { id: 'pausa', durationMin: 30, pauseMin: 10 }],
  employees: [{ id: 'a', availableOnline: true, autoAssign: true }, { id: 'b', availableOnline: true, autoAssign: true }],
  employeeServices: ['a', 'b'].flatMap(e => ['corte', 'barba', 'pausa'].map(s => ({ employeeId: e, serviceId: s, onlineAvailable: true, calendarAvailable: true }))),
  blocks: [], bookings: [], holds: [],
  nowMs: localToEpochMs('2026-10-14', 8 * 60), // quarta 08:00, antes da abertura
  ...over,
});
const D = '2026-10-14'; // quarta

describe('tempo e DST', () => {
  it('dia da mudança de hora (25/10/2026) tem 25 h', () => {
    expect(localToEpochMs('2026-10-26', 0) - localToEpochMs('2026-10-25', 0)).toBe(25 * 3600_000);
  });
  it('dia da mudança de março (29/03/2026) tem 23 h', () => {
    expect(localToEpochMs('2026-03-30', 0) - localToEpochMs('2026-03-29', 0)).toBe(23 * 3600_000);
  });
});

describe('disponibilidade online', () => {
  it('grelha de 10 min dentro do horário, até caber a duração', () => {
    const s = computeAvailability(D, ['corte'], 'a', base());
    expect(s[0].startMin).toBe(540);
    expect(s.at(-1)!.startMin).toBe(1140 - 40);
    expect(s.every(x => x.startMin % 10 === 0)).toBe(true);
  });
  it('soma durações de vários serviços e pausa', () => {
    expect(totalDuration(['corte', 'pausa'], 'a', base())).toBe(40 + 30 + 10);
  });
  it('duração própria do colaborador substitui a do serviço', () => {
    const c = base(); c.employeeServices.find(x => x.employeeId === 'a' && x.serviceId === 'corte')!.durationMin = 50;
    expect(totalDuration(['corte'], 'a', c)).toBe(50);
  });
  it('bloqueio (almoço) e marcação removem horários que sobrepõem', () => {
    const c = base({ blocks: [{ id: 'almoco', employeeId: 'a', date: D, startMin: 780, endMin: 840 }], bookings: [{ id: 'm1', employeeId: 'a', date: D, startMin: 600, endMin: 640, status: 'confirmed' }] });
    const starts = computeAvailability(D, ['corte'], 'a', c).map(s => s.startMin);
    expect(starts).not.toContain(610);
    expect(starts).toContain(640);
    expect(starts).not.toContain(760); // 12:40-13:20 bate no almoço
    expect(starts).toContain(840 - 0);
    expect(starts).not.toContain(780);
  });
  it('marcação cancelada liberta o horário', () => {
    const c = base({ bookings: [{ id: 'm1', employeeId: 'a', date: D, startMin: 600, endMin: 640, status: 'cancelled' }] });
    expect(computeAvailability(D, ['corte'], 'a', c).map(s => s.startMin)).toContain(600);
  });
  it('última marcação 1 h antes: agora 10:00 => primeiro horário 11:00', () => {
    const c = base({ nowMs: localToEpochMs(D, 600) });
    expect(computeAvailability(D, ['corte'], 'a', c)[0].startMin).toBe(660);
  });
  it('limite de 8 semanas à frente (inclusivo) e datas passadas', () => {
    expect(computeAvailability('2026-12-09', ['corte'], 'a', base()).length).toBeGreaterThan(0); // dia 56
    expect(computeAvailability('2026-12-10', ['corte'], 'a', base())).toEqual([]);              // dia 57
    expect(computeAvailability('2026-10-13', ['corte'], 'a', base())).toEqual([]);              // ontem
  });
  it('domingo fechado', () => {
    expect(computeAvailability('2026-10-18', ['corte'], 'a', base())).toEqual([]);
  });
  it('colaborador que não faz o serviço online não tem horários', () => {
    const c = base(); c.employeeServices.find(x => x.employeeId === 'a' && x.serviceId === 'barba')!.onlineAvailable = false;
    expect(computeAvailability(D, ['barba'], 'a', c)).toEqual([]);
    expect(computeAvailability(D, ['barba'], 'b', c).length).toBeGreaterThan(0);
  });
  it('colaborador não disponível online é ignorado em "qualquer"', () => {
    const c = base(); c.employees[0].autoAssign = false;
    expect(new Set(computeAvailability(D, ['corte'], undefined, c).map(s => s.employeeId))).toEqual(new Set(['b']));
  });
  it('reserva temporária ativa bloqueia; expirada não', () => {
    const hold = { employeeId: 'a', date: D, startMin: 600, endMin: 640 };
    const c1 = base({ holds: [{ ...hold, expiresAtMs: localToEpochMs(D, 8 * 60) + 5 * 60_000 }] });
    const c2 = base({ holds: [{ ...hold, expiresAtMs: localToEpochMs(D, 8 * 60) - 1 }] });
    expect(computeAvailability(D, ['corte'], 'a', c1).map(s => s.startMin)).not.toContain(600);
    expect(computeAvailability(D, ['corte'], 'a', c2).map(s => s.startMin)).toContain(600);
  });
});

describe('conflitos (HQ pode confirmar sobreposição, público não)', () => {
  it('deteta sobreposição, bloqueio e fora de horas', () => {
    const c = base({ blocks: [{ id: 'bl', employeeId: 'a', date: D, allDay: true }], bookings: [{ id: 'm1', employeeId: 'b', date: D, startMin: 600, endMin: 640, status: 'confirmed' }] });
    expect(findConflicts({ employeeId: 'a', date: D, startMin: 600, endMin: 640 }, c)).toEqual([{ kind: 'blocked', with: 'bl' }]);
    expect(findConflicts({ employeeId: 'b', date: D, startMin: 630, endMin: 670 }, c)).toEqual([{ kind: 'overlap', with: 'm1' }]);
    expect(findConflicts({ employeeId: 'b', date: D, startMin: 1130, endMin: 1170 }, c)).toEqual([{ kind: 'outside_hours' }]);
  });
  it('encostar (fim = início) não é sobreposição', () => {
    const c = base({ bookings: [{ id: 'm1', employeeId: 'a', date: D, startMin: 600, endMin: 640, status: 'confirmed' }] });
    expect(findConflicts({ employeeId: 'a', date: D, startMin: 640, endMin: 680 }, c)).toEqual([]);
  });
  it('reagendar ignora a própria marcação', () => {
    const c = base({ bookings: [{ id: 'm1', employeeId: 'a', date: D, startMin: 600, endMin: 640, status: 'confirmed' }] });
    expect(findConflicts({ employeeId: 'a', date: D, startMin: 610, endMin: 650, ignoreBookingId: 'm1' }, c)).toEqual([]);
  });
});

describe('atribuição, cancelamento e recorrência', () => {
  it('atribui quem tem menos marcações no dia; desempate por id', () => {
    const c = base({ bookings: [{ id: 'm1', employeeId: 'a', date: D, startMin: 540, endMin: 580, status: 'confirmed' }] });
    expect(assignEmployee(D, 600, ['corte'], c)).toBe('b');
    expect(assignEmployee(D, 600, ['corte'], base())).toBe('a');
  });
  it('não atribui se ninguém está livre', () => {
    const bookings = ['a', 'b'].map(e => ({ id: e, employeeId: e, date: D, startMin: 600, endMin: 640, status: 'confirmed' as const }));
    expect(assignEmployee(D, 610, ['corte'], base({ bookings }))).toBeUndefined();
  });
  it('cancelar online só até 3 h antes', () => {
    const b = { date: D, startMin: 14 * 60 };
    expect(canCancelOrReschedule(b, localToEpochMs(D, 11 * 60))).toBe(true);
    expect(canCancelOrReschedule(b, localToEpochMs(D, 11 * 60 + 1))).toBe(false);
  });
  it('repetição semanal e a cada 2 semanas', () => {
    expect(expandWeekly('2026-10-14', 1, 3)).toEqual(['2026-10-14', '2026-10-21', '2026-10-28']);
    expect(expandWeekly('2026-10-14', 2, 2)).toEqual(['2026-10-14', '2026-10-28']);
  });
});
