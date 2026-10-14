// Service worker — מאפשר עבודה גם בלי קליטה באתר הבנייה (offline) והתקנה כאפליקציה.
const CACHE = 'bakar-v1';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'css/paper.css',
  'js/app.js', 'js/db.js', 'js/templates.js', 'js/model.js', 'js/render-html.js',
  'js/export-docx.js', 'js/export-pdf.js', 'js/signature.js',
  'vendor/docx.min.js', 'vendor/jspdf.umd.min.js', 'vendor/bidi.min.mjs',
  'vendor/fonts/LiberationSans-Regular.ttf', 'vendor/fonts/LiberationSans-Bold.ttf', 'vendor/fonts/LiberationSans-Italic.ttf', 'vendor/fonts/LiberationSans-BoldItalic.ttf', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// network-first לקבצי האפליקציה (כדי לקבל עדכונים), עם נפילה ל-cache כשאין רשת
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && (new URL(e.request.url).origin === location.origin || e.request.url.includes('fonts.g'))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
