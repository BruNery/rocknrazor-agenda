-- Horários que o cliente vê: de 30 em 30 min, mais a hora logo a seguir ao fim de outra marcação (configurável no HQ).
alter table shop_settings add column snap_after_end boolean not null default true;
alter table shop_settings alter column grid_min set default 30;
update shop_settings set grid_min = 30 where grid_min = 10; -- 10 era o valor de origem; quem já escolheu outro mantém
