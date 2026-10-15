import type { Pool } from 'pg';
import { readdirSync, readFileSync } from 'node:fs';

/** Aplica, por ordem, os ficheiros db/NNN_*.sql que ainda não correram. Seguro de repetir: arranque do servidor e testes usam o mesmo caminho. */
export async function migrate(pool: Pool, dir: URL = new URL('../db/', import.meta.url)): Promise<string[]> {
  await pool.query('create table if not exists schema_migrations (name text primary key, at timestamptz not null default now())');
  const done = new Set((await pool.query('select name from schema_migrations')).rows.map(r => r.name as string));
  const applied: string[] = [];
  for (const f of readdirSync(dir).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) {
    if (done.has(f)) continue;
    const c = await pool.connect();
    try { await c.query('begin'); await c.query(readFileSync(new URL(f, dir), 'utf8')); await c.query('insert into schema_migrations(name) values ($1)', [f]); await c.query('commit'); applied.push(f); }
    catch (e) { await c.query('rollback'); throw new Error(`Migração ${f} falhou: ${(e as Error).message}`); } finally { c.release(); }
  }
  return applied;
}
