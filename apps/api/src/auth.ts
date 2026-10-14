import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import type { Pool } from 'pg';

const N = 16384, R = 8, P = 1, KEYLEN = 64;
const kdf = (pw: string, salt: Buffer, n = N) => new Promise<Buffer>((res, rej) => scrypt(pw, salt, KEYLEN, { N: n, r: R, p: P, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16); const k = await kdf(pw, salt);
  return `scrypt$${N}$${salt.toString('base64')}$${k.toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, s, h] = stored.split('$'); if (alg !== 'scrypt') return false;
  const want = Buffer.from(h, 'base64'); const got = await kdf(pw, Buffer.from(s, 'base64'), Number(n));
  return want.length === got.length && timingSafeEqual(want, got);
}
/** Hash falso para gastar o mesmo tempo quando o utilizador não existe (não revela quais utilizadores existem). */
export const DUMMY_HASH = `scrypt$${N}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEYLEN).toString('base64')}`;

export const SESSION_DAYS = 14, MAX_FAILURES = 5, FAILURE_WINDOW_MIN = 15;
export const sha = (t: string) => createHash('sha256').update(t).digest('hex');

export interface User { id: number; username: string; role: 'admin' | 'barber'; employeeId: string | null }

export async function createSession(pool: Pool, userId: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await pool.query("insert into sessions(token_hash, user_id, expires_at) values ($1,$2, now() + make_interval(days => $3))", [sha(token), userId, SESSION_DAYS]);
  return token;
}
export async function userFromToken(pool: Pool, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const r = await pool.query("select u.id, u.username, u.role, u.employee_id from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now() and u.active", [sha(token)]);
  const u = r.rows[0]; return u ? { id: Number(u.id), username: u.username, role: u.role, employeeId: u.employee_id } : null;
}
export const cookieToken = (header: string | undefined) => header?.split(';').map(s => s.trim()).find(s => s.startsWith('rr_session='))?.slice('rr_session='.length);
export const sessionCookie = (token: string, secure: boolean) => `rr_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
export const clearCookie = (secure: boolean) => `rr_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
