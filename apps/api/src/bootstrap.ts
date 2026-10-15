import type { Pool } from 'pg';
import webpush from 'web-push';
import { hashPassword } from './auth';

export async function createAdmin(pool: Pool, username: string, password: string): Promise<void> {
  if (!username.trim() || password.length < 10) throw new Error('Administrador: utilizador obrigatório e palavra-passe com 10+ caracteres');
  await pool.query("insert into users(username, password_hash, role) values ($1,$2,'admin') on conflict (username) do update set password_hash = excluded.password_hash, active = true", [username.trim().toLowerCase(), await hashPassword(password)]);
}

/** Só o que é certo: a equipa e o horário base. Serviços e preços entram pelo HQ. */
export async function seedRR(pool: Pool): Promise<void> {
  await pool.query(`insert into employees(id, name, nickname, sort_order) values ('andre','André','Link',1),('marcos','Marcos','Gringo',2),('margarida','Margarida','Maggie',3),('emanuel','Emanuel','Tito',4),('eduardo','Eduardo','Aquaman',5) on conflict do nothing`);
  if (!(await pool.query('select 1 from opening_hours limit 1')).rowCount) await pool.query('insert into opening_hours(weekday, open_min, close_min) select d, 540, 1140 from generate_series(1,6) d');
}

/** Chaves VAPID: variáveis de ambiente se existirem; senão geradas uma vez e guardadas na base de dados. */
export async function vapidKeys(pool: Pool, env: Record<string, string | undefined> = process.env): Promise<{ publicKey: string; privateKey: string }> {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const k = webpush.generateVAPIDKeys();
  await pool.query("insert into app_secrets(key, value) values ('vapid_public',$1),('vapid_private',$2) on conflict (key) do nothing", [k.publicKey, k.privateKey]);
  const rows = (await pool.query("select key, value from app_secrets where key in ('vapid_public','vapid_private')")).rows as { key: string; value: string }[];
  return { publicKey: rows.find(r => r.key === 'vapid_public')!.value, privateKey: rows.find(r => r.key === 'vapid_private')!.value };
}

/** Primeiro arranque: se não houver nenhum utilizador e BOOTSTRAP_ADMIN_USER/PASSWORD estiverem definidos, cria o administrador (e a equipa, com SEED_RR=1). */
export async function firstRun(pool: Pool, env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const did: string[] = [];
  if (env.BOOTSTRAP_ADMIN_USER && env.BOOTSTRAP_ADMIN_PASSWORD && !(await pool.query('select 1 from users limit 1')).rowCount) { await createAdmin(pool, env.BOOTSTRAP_ADMIN_USER, env.BOOTSTRAP_ADMIN_PASSWORD); did.push('administrador'); }
  if (env.SEED_RR === '1' && !(await pool.query('select 1 from employees limit 1')).rowCount) { await seedRR(pool); did.push('equipa'); }
  return did;
}
