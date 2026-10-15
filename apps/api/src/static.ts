import type { FastifyInstance } from 'fastify';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

/** Serve a app (HQ + Booking) a partir de uma pasta. O resto dos pedidos GET que não sejam da API dá a página principal (a app navega por #). */
export function registerStatic(app: FastifyInstance, dir: string) {
  const root = resolve(dir);
  app.setNotFoundHandler(async (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply.code(404).send({ ok: false, error: 'nao_encontrado' });
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (/^\/(admin|hq|public|auth|push)\//.test(path)) return reply.code(404).send({ ok: false, error: 'nao_encontrado' });
    let file = resolve(join(root, path === '/' ? 'index.html' : path));
    if (file !== root && !file.startsWith(root + sep)) return reply.code(404).send({ ok: false, error: 'nao_encontrado' });
    try { if (!(await stat(file)).isFile()) throw 0; } catch { if (extname(path)) return reply.code(404).send({ ok: false, error: 'nao_encontrado' }); file = join(root, 'index.html'); }
    const body = await readFile(file);
    const noCache = /(^|\/)(sw\.js|index\.html|manifest\.webmanifest)$/.test(file);
    return reply.header('content-type', TYPES[extname(file)] ?? 'application/octet-stream').header('cache-control', noCache ? 'no-cache' : 'public, max-age=86400').header('x-content-type-options', 'nosniff').send(body);
  });
}
