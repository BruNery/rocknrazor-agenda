-- Cada barbeiro gere a sua disponibilidade: pausas semanais repetidas + bloqueios pontuais (os bloqueios já existem).
create table employee_pauses (
  id bigserial primary key, employee_id text not null references employees(id),
  weekday int not null check (weekday between 0 and 6),
  start_min int not null, end_min int not null check (end_min > start_min), label text not null default ''
);
create index employee_pauses_emp on employee_pauses (employee_id);
alter table blocks add column created_by bigint references users(id);
