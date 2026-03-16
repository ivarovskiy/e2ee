/**
 * static/sw.js
 * Service Worker для PWA-кешування.
 *
 * Стратегія: Network First з fallback на кеш.
 * Криптографічні операції виконуються лише в основному потоці
 * (Web Crypto API недоступний у Service Worker).
 */

const CACHE_NAME = 'sft-v1';

const STATIC_ASSETS = [
    '/',
    './css/style.css',
    './js/config.js',
    './js/crypto.js',
    './js/websocket.js',
    './js/qr.js',
    './js/file-handler.js',
    './js/native-bridge.js',
    './js/app.js',
    './manifest.json',
];

// Install: кешуємо статичні ресурси
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[SW] Caching static assets');
            return cache.addAll(STATIC_ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate: видаляємо старі кеші
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            );
        })
    );
    self.clients.claim();
});

// Fetch: Network First для API, Cache First для статики
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Пропускаємо WebSocket-запити
    if (request.headers.get('upgrade') === 'websocket') return;

    // API — завжди з мережі
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
        return;
    }

    // Статика та CDN — Cache First
    event.respondWith(
        caches.match(request).then((cached) => {
            if (cached) return cached;

            return fetch(request).then((response) => {
                // Кешуємо успішні відповіді
                if (response.ok && request.method === 'GET') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
                }
                return response;
            }).catch(() => {
                // Offline fallback для HTML
                if (request.destination === 'document') {
                    return caches.match('/');
                }
            });
        })
    );
});
