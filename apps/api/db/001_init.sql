-- Esquema do núcleo de marcações. Datas locais (Europe/Lisbon) em `date`, horas em minutos desde a meia-noite.
create table employees (
  id text primary key, name text not null,
  available_online boolean not null default true,
  auto_assign boolean not null default true
);
create table services (
  id text primary key, name text not null,
  duration_min int not null check (duration_min > 0), pause_min int not null default 0
);
create table employee_services (
  employee_id text references employees(id), service_id text references services(id),
  online_available boolean not null default true, calendar_available boolean not null default true,
  duration_min int, primary key (employee_id, service_id)
);
create table opening_hours (
  weekday int not null check (weekday between 0 and 6),
  open_min int not null, close_min int not null check (close_min > open_min)
);
create table blocks (
  id text primary key, employee_id text not null references employees(id), date date not null,
  all_day boolean not null default false, start_min int, end_min int, reason text
);
create table customers (
  id bigserial primary key, name text not null, phone text not null, email text
);
create table bookings (
  id text primary key, employee_id text not null references employees(id), customer_id bigint references customers(id),
  date date not null, start_min int not null, end_min int not null check (end_min > start_min),
  service_ids text[] not null, source text not null check (source in ('online','hq')),
  status text not null default 'confirmed' check (status in ('confirmed','cancelled','noshow')),
  created_at timestamptz not null default now()
);
create index bookings_emp_day on bookings (employee_id, date);
create table holds (
  id text primary key, employee_id text not null references employees(id), date date not null,
  start_min int not null, end_min int not null, expires_at timestamptz not null
);
create table audit_log (
  id bigserial primary key, at timestamptz not null default now(),
  actor text not null, action text not null, booking_id text,
  before jsonb, after jsonb, notified boolean
);
