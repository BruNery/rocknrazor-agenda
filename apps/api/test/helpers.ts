import pg from 'pg';
import { readFileSync } from 'node:fs';
export const url = process.env.DATABASE_URL ?? 'postgres://postgres@/rr?host=/tmp&port=5544';
export async function freshDb(): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: url, max: 30 });
  await pool.query('drop schema public cascade; create schema public;');
  await pool.query(readFileSync(new URL('../db/001_init.sql', import.meta.url), 'utf8'));
  await pool.query(readFileSync(new URL('../db/002_auth_sales.sql', import.meta.url), 'utf8'));
  await pool.query(readFileSync(new URL('../db/003_push.sql', import.meta.url), 'utf8'));
  await pool.query(`insert into employees(id,name) values ('a','Andre'),('b','Marcos');
    insert into services(id,name,duration_min) values ('corte','Corte',40),('barba','Barba',20);
    insert into employee_services(employee_id,service_id) values ('a','corte'),('a','barba'),('b','corte'),('b','barba');
    insert into opening_hours(weekday,open_min,close_min) select d,540,1140 from generate_series(1,6) d;`);
  return pool;
}
