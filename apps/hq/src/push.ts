/** Avisos no telemóvel (Web Push) do lado da app. Só funciona na versão instalada/alojada em HTTPS. */
export type PushState = 'unsupported' | 'ios-install' | 'denied' | 'off' | 'on';

export const pushSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export function b64ToU8(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;

export async function pushState(): Promise<PushState> {
  if (isIos() && !standalone()) return 'ios-install'; // no iPhone só funciona depois de "Adicionar ao ecrã principal"
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration(); const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}
const post = (api: string, path: string, body: unknown) => fetch(`${api}${path}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Tem de ser chamada a partir de um toque do utilizador (o navegador exige-o para pedir a permissão). */
export async function enablePush(api: string): Promise<PushState> {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  const reg = await navigator.serviceWorker.ready;
  const k = await (await fetch(`${api}/push/key`, { credentials: 'include' })).json();
  if (!k.ok) throw new Error('push_nao_configurado');
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(k.key) as BufferSource }));
  const r = await post(api, '/push/subscribe', sub.toJSON()); if (!r.ok) throw new Error('subscribe_falhou');
  return 'on';
}
export async function disablePush(api: string): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration(); const sub = await reg?.pushManager.getSubscription();
  if (sub) { await post(api, '/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
  return 'off';
}
