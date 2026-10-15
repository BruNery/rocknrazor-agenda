import pg from 'pg';
import { migrate } from './migrate';
import { createAdmin, seedRR } from './bootstrap';

/** Uso: tsx src/cli.ts create-admin <utilizador> <palavra-passe>  |  seed-rr  |  migrate. Precisa de DATABASE_URL. */
const [cmd, a, b] = process.argv.slice(2);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await migrate(pool);
  if (cmd === 'create-admin') {
    if (!a || !b || b.length < 10) throw new Error('Uso: create-admin <utilizador> <palavra-passe com 10+ caracteres>');
    await createAdmin(pool, a, b);
    console.log(`Conta de administrador "${a}" pronta.`);
  } else if (cmd === 'seed-rr') {
    await seedRR(pool);
    console.log('Equipa e horário base criados (podes mudar tudo no HQ).');
  } else if (cmd !== 'migrate') throw new Error('Comandos: migrate | create-admin | seed-rr');
} finally { await pool.end(); }
