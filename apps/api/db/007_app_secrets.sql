-- Segredos gerados pelo próprio servidor (ex.: chaves VAPID dos avisos no telemóvel).
create table app_secrets (key text primary key, value text not null, created_at timestamptz not null default now());
