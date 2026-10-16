-- Contas dos clientes (área marcar.*): uma conta por cliente, ligada à ficha do HQ (pontos e histórico ficam juntos).
create table client_accounts (
  customer_id bigint primary key references customers(id) on delete cascade,
  password_hash text not null,
  created_at timestamptz not null default now()
);
create table client_sessions (
  token_hash text primary key,
  customer_id bigint not null references customers(id) on delete cascade,
  expires_at timestamptz not null
);
create index client_sessions_customer on client_sessions (customer_id);
