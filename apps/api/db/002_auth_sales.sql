-- Contas, sessões, limite de tentativas e vendas (atendimentos registados na app).
create table users (
  id bigserial primary key,
  username text not null unique check (username = lower(username)),
  password_hash text not null,
  role text not null check (role in ('admin','barber')),
  employee_id text references employees(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check ((role = 'barber' and employee_id is not null) or (role = 'admin'))
);
create table sessions (
  token_hash text primary key,
  user_id bigint not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user on sessions (user_id);
create table login_failures (id bigserial primary key, username text not null, at timestamptz not null default now());
create index login_failures_u on login_failures (username, at);
create table sales (
  id bigserial primary key, booking_id text not null unique references bookings(id),
  employee_id text not null references employees(id), customer_id bigint references customers(id),
  date date not null, payment text not null check (payment in ('dinheiro','cartao','mbway','outro')),
  created_by bigint references users(id), created_at timestamptz not null default now()
);
create table sale_items (
  id bigserial primary key, sale_id bigint not null references sales(id) on delete cascade,
  kind text not null check (kind in ('service','product')), ref_id text not null, name text not null,
  qty int not null check (qty between 1 and 99), unit_cents int not null check (unit_cents between 0 and 1000000)
);
create index sales_emp_date on sales (employee_id, date);
