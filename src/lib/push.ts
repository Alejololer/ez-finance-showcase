// Notificaciones push web (RFC 8030 + VAPID). Las envía scripts/parse-pending.ts cuando llega algo nuevo a la
// bandeja y la action testPush ("enviar prueba" en /settings). Sin deps de Astro: lo importa el Action de GitHub.
//
// El mensaje va en formato "Declarative Web Push" (`web_push: 8030`): Safari en iOS/iPadOS 18.4+ y macOS lo muestra
// solo, sin despertar al service worker (más confiable con la app en segundo plano). Los demás navegadores (Chrome en
// Android, iOS 16.4–18.3) lo entregan a public/sw.js, que lee los mismos campos y muestra la notificación.
// El contenido viaja cifrado de punta a punta (aes128gcm): el servicio push de Google/Apple no lo puede leer.
import webpush from 'web-push';
import { formatMoney } from './money.ts';

// Producción. Es el `subject` de VAPID (contacto para el servicio push; Apple exige https o mailto) y el destino de
// las notificaciones del parser.
export const APP_URL = 'https://ez-finance.example.com';

export type PushPayload = {
  web_push: 8030;
  notification: { title: string; body: string; navigate: string; tag: string; lang: 'es'; silent: false };
  app_badge?: number;
};
export type PushSubscriptionRow = { id: number; endpoint: string; p256dh: string; auth: string };
export type Vapid = { publicKey: string; privateKey: string; subject: string };

// Lo nuevo de una corrida del parser para un usuario: un movimiento pendiente o un aviso que quedó en revisión.
export type InboxItem =
  | { kind: 'expense' | 'income' | 'transfer'; cents: number; merchant?: string | null; currency?: string | null }
  | { kind: 'review' };

const line = (it: InboxItem) => {
  if (it.kind === 'review') return 'Un aviso necesita revisión';
  const money = formatMoney(Math.abs(it.cents), it.currency || 'USD');
  const who = it.merchant?.trim();
  if (it.kind === 'expense') return who ? `Gasto de ${money} en ${who}` : `Gasto de ${money}`;
  if (it.kind === 'income') return who ? `Ingreso de ${money} de ${who}` : `Ingreso de ${money}`;
  return `Transferencia de ${money}`;
};

// Una sola notificación por usuario y corrida (tag "inbox": la nueva reemplaza a la anterior en vez de apilarse).
export function inboxNotice(items: InboxItem[], appUrl: string, badge?: number): PushPayload {
  const n = items.length;
  const lines = items.slice(0, 3).map(line);
  if (n > 3) lines.push(`y ${n - 3} más`);
  return {
    web_push: 8030,
    notification: {
      title: n === 1 ? 'Nuevo en la bandeja' : `${n} nuevos en la bandeja`,
      body: lines.join('\n'),
      navigate: new URL('/inbox', appUrl).href,
      tag: 'inbox',
      lang: 'es',
      silent: false,
    },
    ...(badge ? { app_badge: badge } : {}),
  };
}

export function testNotice(appUrl: string): PushPayload {
  return {
    web_push: 8030,
    notification: {
      title: 'Notificaciones activas',
      body: 'Así te avisaremos cuando llegue algo nuevo a tu bandeja.',
      navigate: new URL('/settings', appUrl).href,
      tag: 'test',
      lang: 'es',
      silent: false,
    },
  };
}

// Envía a cada suscripción. Nunca lanza: un fallo de notificaciones no debe frenar al parser ni a la action.
// `gone` = suscripciones que el servicio push dio por muertas (404/410: permiso revocado, app desinstalada): borrarlas.
export async function sendPush(subs: PushSubscriptionRow[], payload: PushPayload, vapid: Vapid) {
  const gone: number[] = [];
  const failed: string[] = [];
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), {
          vapidDetails: vapid,
          TTL: 24 * 3600, // si el teléfono está apagado, el aviso espera un día
          urgency: 'high', // Android lo entrega aunque esté en reposo (Doze)
          topic: payload.notification.tag, // un aviso aún no entregado con el mismo tema se reemplaza
          timeout: 10_000,
        });
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) gone.push(s.id);
        else failed.push(`${new URL(s.endpoint).host}: ${status ?? (err as Error).message}`.slice(0, 300));
      }
    }),
  );
  return { sent, gone, failed };
}
