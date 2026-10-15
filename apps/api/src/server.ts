import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { FakeNotifier } from './service';
import { PushStaffNotifier, WebPushSender } from './push';
import { migrate } from './migrate';
import { firstRun, vapidKeys } from './bootstrap';

/** Arranque em produção. Variáveis: DATABASE_URL, PORT, PUBLIC_DIR (pasta da app), NODE_ENV=production, VAPID_SUBJECT (opcional), BOOTSTRAP_ADMIN_USER/BOOTSTRAP_ADMIN_PASSWORD (só no 1.º arranque), SEED_RR=1 (equipa). As chaves dos avisos geram-se sozinhas (ou VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY). */
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const applied = await migrate(pool); if (applied.length) console.log('Migrações aplicadas:', applied.join(', '));
const first = await firstRun(pool); if (first.length) console.log('Primeiro arranque:', first.join(', '));
const { publicKey: pub, privateKey: priv } = await vapidKeys(pool);
const staff = new PushStaffNotifier(pool, new WebPushSender(pub, priv, process.env.VAPID_SUBJECT ?? 'https://rockandrazor.com'), (m, e) => console.error(m, e));
const publicDir = process.env.PUBLIC_DIR ?? fileURLToPath(new URL('../../hq/dist/pwa', import.meta.url));
const app = buildApp(pool, new FakeNotifier(), Date.now, { secureCookies: process.env.NODE_ENV === 'production', staff, vapidPublicKey: pub, publicDir });
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
console.log('Rock n\' Razor a ouvir');
