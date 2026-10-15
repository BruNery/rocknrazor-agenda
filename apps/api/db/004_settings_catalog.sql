-- Definições do negócio, catálogo gerido pelo HQ e pontos (livro-razão só de acrescentar).
create table shop_settings (
  id int primary key default 1 check (id = 1),
  grid_min int not null default 10 check (grid_min in (5,10,15,20,30,60)),
  max_weeks_ahead int not null default 8 check (max_weeks_ahead between 1 and 52),
  last_booking_lead_min int not null default 60 check (last_booking_lead_min between 0 and 1440),
  cancel_lead_min int not null default 180 check (cancel_lead_min between 0 and 10080),
  hold_min int not null default 5 check (hold_min between 1 and 30),
  max_open_online int not null default 3 check (max_open_online between 0 and 20),
  allow_online_overlap boolean not null default false,
  any_barber_policy text not null default 'fewest_bookings' check (any_barber_policy in ('fewest_bookings','first_in_order')),
  updated_at timestamptz not null default now()
);
insert into shop_settings default values;

alter table employees add column nickname text, add column specialties text not null default '',
  add column active boolean not null default true, add column sort_order int not null default 0;
alter table services add column price_cents int not null default 0 check (price_cents >= 0),
  add column active boolean not null default true, add column sort_order int not null default 0,
  add column points_price int check (points_price is null or points_price > 0); -- preenchido = pode ser pago com pontos
create table products (
  id text primary key, name text not null, price_cents int not null check (price_cents >= 0),
  stock int, active boolean not null default true, sort_order int not null default 0,
  points_price int check (points_price is null or points_price > 0)
);

-- Clientes: ID de membro público (RNR-XXXXXX)
alter table customers add column member_code text unique;
create table points_ledger (
  id bigserial primary key, customer_id bigint not null references customers(id),
  delta int not null check (delta <> 0),
  kind text not null check (kind in ('manual','sale','referral','redeem','refund','expire','promo')),
  note text not null default '', created_by bigint references users(id), created_at timestamptz not null default now()
);
create index points_ledger_customer on points_ledger (customer_id);
