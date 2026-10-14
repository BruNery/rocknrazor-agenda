/** Datas locais como "YYYY-MM-DD"; horas como minutos desde a meia-noite (hora local do negócio). */
export type DateStr = string;

export interface OpeningHours { /** 0=domingo..6=sábado; sem entrada = fechado */ [weekday: number]: { open: number; close: number }[] | undefined }

export interface Service {
  id: string;
  durationMin: number;
  /** Pausa após o serviço. PRESSUPOSTO: ocupa o colaborador (comportamento no Noona não verificado). */
  pauseMin?: number;
}

export interface EmployeeService { employeeId: string; serviceId: string; onlineAvailable: boolean; calendarAvailable: boolean; durationMin?: number }

export interface Employee { id: string; availableOnline: boolean; autoAssign: boolean }

export interface Block {
  id: string; employeeId: string; date: DateStr;
  allDay?: boolean; startMin?: number; endMin?: number;
}

export interface Booking {
  id: string; employeeId: string; date: DateStr; startMin: number; endMin: number;
  status: 'confirmed' | 'cancelled' | 'noshow';
}

export interface Hold { employeeId: string; date: DateStr; startMin: number; endMin: number; expiresAtMs: number }

export interface OnlineRules {
  gridMin: number;            // 10
  maxWeeksAhead: number;      // 8
  lastBookingLeadMin: number; // 60
  cancelLeadMin: number;      // 180
}

export const DEFAULT_RULES: OnlineRules = { gridMin: 10, maxWeeksAhead: 8, lastBookingLeadMin: 60, cancelLeadMin: 180 };

export type Conflict =
  | { kind: 'overlap'; with: string }
  | { kind: 'blocked'; with: string }
  | { kind: 'outside_hours' }
  | { kind: 'service_not_offered'; serviceId: string }
  | { kind: 'held'; };
