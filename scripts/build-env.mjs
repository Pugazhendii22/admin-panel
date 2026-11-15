// Generates firebase-config.js and firebase-messaging-sw.js from environment
// variables at build time (zero dependencies; runs automatically on Vercel).
// Locally, reads .env if present while letting real process.env take priority.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const fileEnv = loadDotEnv(resolve(root, ".env"));
const env = (name) => process.env[name] ?? fileEnv[name] ?? "";

const REQUIRED = [
  "FIREBASE_CATALOG_API_KEY",
  "FIREBASE_CATALOG_AUTH_DOMAIN",
  "FIREBASE_CATALOG_PROJECT_ID",
  "FIREBASE_CATALOG_STORAGE_BUCKET",
  "FIREBASE_CATALOG_MESSAGING_SENDER_ID",
  "FIREBASE_CATALOG_APP_ID",
  "FIREBASE_SECONDHAND_API_KEY",
  "FIREBASE_SECONDHAND_AUTH_DOMAIN",
  "FIREBASE_SECONDHAND_PROJECT_ID",
  "FIREBASE_SECONDHAND_STORAGE_BUCKET",
  "FIREBASE_SECONDHAND_MESSAGING_SENDER_ID",
  "FIREBASE_SECONDHAND_APP_ID",
];

const missing = REQUIRED.filter((k) => !env(k));
if (missing.length > 0) {
  console.error(
    "Missing required environment variables for build:\n  - " +
      missing.join("\n  - ") +
      "\nAdd them in Vercel -> Project Settings -> Environment Variables (or local .env)."
  );
  process.exit(1);
}

const catalogConfig = {
  apiKey: env("FIREBASE_CATALOG_API_KEY"),
  authDomain: env("FIREBASE_CATALOG_AUTH_DOMAIN"),
  projectId: env("FIREBASE_CATALOG_PROJECT_ID"),
  storageBucket: env("FIREBASE_CATALOG_STORAGE_BUCKET"),
  messagingSenderId: env("FIREBASE_CATALOG_MESSAGING_SENDER_ID"),
  appId: env("FIREBASE_CATALOG_APP_ID"),
};

const secondHandConfig = {
  apiKey: env("FIREBASE_SECONDHAND_API_KEY"),
  authDomain: env("FIREBASE_SECONDHAND_AUTH_DOMAIN"),
  projectId: env("FIREBASE_SECONDHAND_PROJECT_ID"),
  storageBucket: env("FIREBASE_SECONDHAND_STORAGE_BUCKET"),
  messagingSenderId: env("FIREBASE_SECONDHAND_MESSAGING_SENDER_ID"),
  appId: env("FIREBASE_SECONDHAND_APP_ID"),
};

const vapidKey = env("FIREBASE_WEB_PUSH_VAPID_KEY");

const firebaseConfigJs = `// Auto-generated at build time by scripts/build-env.mjs — do not commit.
export const catalogFirebaseConfig = ${JSON.stringify(catalogConfig, null, 2)};

export const secondHandFirebaseConfig = ${JSON.stringify(secondHandConfig, null, 2)};

export const webPushVapidKey = ${JSON.stringify(vapidKey)};
`;

const messagingSwJs = `// Auto-generated at build time by scripts/build-env.mjs — do not commit.
importScripts(
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js"
);
importScripts(
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js"
);

firebase.initializeApp(${JSON.stringify(catalogConfig, null, 2)});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  const data = payload.data || {};

  self.registration.showNotification(title || "French Mobiles", {
    body: body || "",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag: data.orderId || "general",
    renotify: true,
    data,
  });
});

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
`;

writeFileSync(resolve(root, "firebase-config.js"), firebaseConfigJs, "utf8");
writeFileSync(resolve(root, "firebase-messaging-sw.js"), messagingSwJs, "utf8");

console.log(
  `Generated firebase-config.js and firebase-messaging-sw.js (${catalogConfig.projectId} + ${secondHandConfig.projectId})`
);
