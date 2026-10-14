import type { DateStr } from './types';

export const TZ = 'Europe/Lisbon';

/** Instante UTC (ms) de uma data+minutos locais no fuso dado. Trata mudanças de hora. */
export function localToEpochMs(date: DateStr, min: number, tz = TZ): number {
  const [y, m, d] = date.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, min);
  let guess = naive;
  for (let i = 0; i < 2; i++) guess = naive - offsetMs(guess, tz);
  return guess;
}

function offsetMs(epoch: number, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(epoch)).reduce<Record<string, number>>((a, x) => (x.type !== 'literal' ? { ...a, [x.type]: Number(x.value) } : a), {});
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - epoch;
}

export function weekday(date: DateStr): number { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
export function addDays(date: DateStr, n: number): DateStr { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
export function todayLocal(nowMs: number, tz = TZ): DateStr { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(nowMs)); }
