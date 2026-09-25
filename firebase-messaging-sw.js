// Background push for the admin panel.
//
// Separate from sw.js on purpose. Firebase looks for a worker at exactly this
// filename when `getToken` is called without an explicit registration, and it
// needs the compat build because a service worker cannot use ES modules in
// every browser that matters. sw.js stays what it is — the installable shell
// cache — and neither file knows about the other.
//
// Only fires when the panel is closed or in the background. A push arriving
// while the tab is open goes to `onMessage` in app.js instead, which is why
// notifications are raised in two places.

importScripts(
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js"
);
importScripts(
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js"
);

// Duplicated from firebase-config.js rather than imported: a service worker
// has no access to the page's modules, and importScripts cannot read an ES
// module export. If the catalog project's config changes, change it here too.
firebase.initializeApp({
  apiKey: "AIzaSyBPEZYTwR5PMdJgdX_zj36Nrrrzr9oUBAY",
  authDomain: "french-mobiles-marketplace.firebaseapp.com",
  projectId: "french-mobiles-marketplace",
  storageBucket: "french-mobiles-marketplace.firebasestorage.app",
  messagingSenderId: "1086357315686",
  appId: "1:1086357315686:web:af8b68f30d6173385c4da7",
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  const data = payload.data || {};

  self.registration.showNotification(title || "French Mobiles", {
    body: body || "",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    // Grouped by order, so four updates to one pickup replace each other
    // rather than stacking into a wall of near-identical notifications.
    tag: data.orderId || "general",
    renotify: true,
    data,
  });
});

// Bring the panel forward rather than opening a second copy of it.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of all) {
        if (client.url.includes("/index.html") || client.url.endsWith("/")) {
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow("./index.html");
    })()
  );
});
