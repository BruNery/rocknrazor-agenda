-- Dispositivos (telemóveis) de cada utilizador que recebem avisos de marcações.
create table push_subscriptions (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null, auth text not null,
  created_at timestamptz not null default now(), last_ok timestamptz
);
create index push_user on push_subscriptions (user_id);
