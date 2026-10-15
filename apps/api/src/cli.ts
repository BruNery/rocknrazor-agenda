import pg from 'pg';
import { migrate } from './migrate';
import { hashPassword } from './auth';

/** Uso: tsx src/cli.ts create-admin <utilizador> <palavra-passe>  |  seed-rr  |  migrate. Precisa de DATABASE_URL. */
const [cmd, a, b] = process.argv.slice(2);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await migrate(pool);
  if (cmd === 'create-admin') {
    if (!a || !b || b.length < 10) throw new Error('Uso: create-admin <utilizador> <palavra-passe com 10+ caracteres>');
    await pool.query("insert into users(username, password_hash, role) values ($1,$2,'admin') on conflict (username) do update set password_hash = excluded.password_hash, active = true", [a.trim().toLowerCase(), await hashPassword(b)]);
    console.log(`Conta de administrador "${a}" pronta.`);
  } else if (cmd === 'seed-rr') {
    // Só o que é certo: a equipa e o horário base. Serviços e preços entram pelo HQ.
    await pool.query(`insert into employees(id, name, nickname, sort_order) values ('andre','André','Link',1),('marcos','Marcos','Gringo',2),('margarida','Margarida','Maggie',3),('emanuel','Emanuel','Tito',4),('eduardo','Eduardo','Aquaman',5) on conflict do nothing`);
    if (!(await pool.query('select 1 from opening_hours limit 1')).rowCount) await pool.query('insert into opening_hours(weekday, open_min, close_min) select d, 540, 1140 from generate_series(1,6) d');
    console.log('Equipa e horário base criados (podes mudar tudo no HQ).');
  } else if (cmd !== 'migrate') throw new Error('Comandos: migrate | create-admin | seed-rr');
} finally { await pool.end(); }
