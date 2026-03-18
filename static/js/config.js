/**
 * static/js/config.js
 * Конфігурація клієнта.
 *
 * Визначає URL relay-сервера залежно від середовища:
 *   - Браузер (PWA): той самий origin (сервер і клієнт на одному хості)
 *   - Capacitor (нативна апка): зовнішній URL relay-сервера
 *
 * Для нативної апки URL сервера задається через:
 *   1. localStorage (якщо раніше збережено)
 *   2. prompt при першому запуску
 *   3. Або змінну SFT_SERVER_URL нижче
 */

const AppConfig = (() => {
    'use strict';

    // ═══ Встановіть URL вашого relay-сервера тут ═══
    // (використовується лише в нативній апці, не в браузері)
    const DEFAULT_SERVER_URL = 'https://e2ee-7zis.onrender.com';  // напр.: 'https://sft.yourdomain.com'

    // ── Визначення середовища ──────────────────────────────────────

    function isNative() {
        return typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform();
    }

    function getPlatform() {
        if (isNative()) {
            return window.Capacitor.getPlatform(); // 'android' | 'ios'
        }
        return 'web';
    }

    // ── URL сервера ────────────────────────────────────────────────

    function getServerUrl() {
        // У браузері — той самий origin
        if (!isNative()) {
            return window.location.origin;
        }

        // У нативній апці — зовнішній URL
        // Спробуємо з localStorage
        const saved = _safeGetItem('sft_server_url');
        if (saved) return saved;

        // Якщо задано за замовчуванням
        if (DEFAULT_SERVER_URL) return DEFAULT_SERVER_URL;

        // Запитуємо у користувача
        return null; // app.js обробить відсутність URL
    }

    function setServerUrl(url) {
        _safeSetItem('sft_server_url', url.replace(/\/+$/, ''));
    }

    function getApiUrl(path) {
        const base = getServerUrl();
        if (!base) return null;
        return `${base}${path}`;
    }

    function getWsUrl(sessionId, role) {
        const base = getServerUrl();
        if (!base) return null;
        const wsProtocol = base.startsWith('https') ? 'wss:' : 'ws:';
        const host = base.replace(/^https?:\/\//, '');
        return `${wsProtocol}//${host}/ws/${sessionId}/${role}`;
    }

    // ── Конфігурація ───────────────────────────────────────────────

    const MAX_FILE_SIZE = 104857600; // 100 МБ
    const CHUNK_SIZE = 256 * 1024;   // 256 КБ

    // ── Безпечний доступ до localStorage ───────────────────────────

    function _safeGetItem(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    }

    function _safeSetItem(key, value) {
        try { localStorage.setItem(key, value); } catch { /* ігноруємо */ }
    }

    // ── Публічний API ──────────────────────────────────────────────

    return {
        isNative,
        getPlatform,
        getServerUrl,
        setServerUrl,
        getApiUrl,
        getWsUrl,
        MAX_FILE_SIZE,
        CHUNK_SIZE,
    };
})();
