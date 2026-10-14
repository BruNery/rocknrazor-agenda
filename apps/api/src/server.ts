import pg from 'pg';
import { buildApp } from './app';
import { FakeNotifier } from './service';
import { PushStaffNotifier, WebPushSender } from './push';

/** Arranque em produção. Variáveis: DATABASE_URL, PORT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:…). */
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
const staff = pub && priv ? new PushStaffNotifier(pool, new WebPushSender(pub, priv, process.env.VAPID_SUBJECT ?? 'mailto:geral@exemplo.pt'), (m, e) => console.error(m, e)) : undefined;
if (!staff) console.warn('Avisos no telemóvel desligados: faltam VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY (node scripts/vapid.mjs gera um par).');
const app = buildApp(pool, new FakeNotifier(), Date.now, { secureCookies: process.env.NODE_ENV === 'production', staff, vapidPublicKey: pub });
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
