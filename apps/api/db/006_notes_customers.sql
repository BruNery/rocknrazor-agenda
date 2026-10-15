-- Notas (cliente e marcação), para o HQ guardar o que o Noona guarda.
alter table customers add column notes text not null default '';
alter table bookings add column notes text not null default '';
