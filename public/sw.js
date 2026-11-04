// Service worker: solo notificaciones push (sin caché offline; las páginas siempre van al servidor).
// Lo registra el Layout en todas las páginas. Los mensajes llegan en formato "Declarative Web Push"
// (src/lib/push.ts): Safari 18.4+ los muestra sin pasar por aquí; Chrome (Android) e iOS 16.4–18.3 los entregan a
// este `push`, que muestra la notificación con los mismos campos. iOS revoca el permiso si un push no muestra nada:
// siempre se muestra algo.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let msg = {};
  try { msg = e.data?.json() ?? {}; } catch { msg = { notification: { body: e.data?.text() } }; }
  const n = msg.notification ?? {};
  const url = n.navigate || '/inbox';
  const jobs = [
    self.registration.showNotification(n.title || 'ez-finance', {
      body: n.body || 'Tienes novedades en tu bandeja.',
      tag: n.tag || 'inbox',
      renotify: true, // con el mismo tag reemplaza a la anterior, pero vuelve a sonar
      lang: 'es',
      icon: '/icon-192.png',
      badge: '/badge-96.png', // silueta monocroma para la barra de estado de Android
      data: { url },
    }),
  ];
  if (typeof msg.app_badge === 'number' && self.navigator.setAppBadge) {
    jobs.push(self.navigator.setAppBadge(msg.app_badge).catch(() => {}));
  }
  e.waitUntil(Promise.all(jobs));
});

// Tocar la notificación: enfoca la app si ya está abierta (y la lleva a la bandeja) o la abre.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/inbox', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      if ('navigate' in win) return win.navigate(url).catch(() => {});
      return;
    }
    return self.clients.openWindow(url);
  })());
});

// El navegador renovó la suscripción (Chrome lo hace de vez en cuando): se reemplaza en el servidor.
// Si la sesión expiró, falla en silencio y la suscripción nueva se guarda al volver a abrir /settings.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const old = e.oldSubscription;
    const sub = e.newSubscription ?? (old && await self.registration.pushManager.subscribe(old.options));
    const post = (name, body) => fetch(`/_actions/${name}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => {});
    if (sub) await post('savePushSubscription', { ...sub.toJSON(), device: null });
    if (old) await post('deletePushSubscription', { endpoint: old.endpoint });
  })());
});
