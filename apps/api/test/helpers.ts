import pg from 'pg';
import { migrate } from '../src/migrate';
export const url = process.env.DATABASE_URL ?? 'postgres://postgres@/rr?host=/tmp&port=5544';
export async function freshDb(): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: url, max: 30 });
  await pool.query('drop schema public cascade; create schema public;');
  await migrate(pool);
  await pool.query('update shop_settings set grid_min = 10, snap_after_end = false'); // os testes gerais usam a grelha fina; a grelha de 30 tem testes próprios
  await pool.query(`insert into employees(id,name) values ('a','Andre'),('b','Marcos');
    insert into services(id,name,duration_min) values ('corte','Corte',40),('barba','Barba',20);
    insert into employee_services(employee_id,service_id) values ('a','corte'),('a','barba'),('b','corte'),('b','barba');
    insert into opening_hours(weekday,open_min,close_min) select d,540,1140 from generate_series(1,6) d;`);
  return pool;
}
