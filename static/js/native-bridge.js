/**
 * static/js/native-bridge.js
 * Мост між Web API та нативними можливостями Capacitor.
 *
 * Забезпечує:
 *   - Збереження файлів через Capacitor Filesystem (замість Blob URL)
 *   - Керування StatusBar на Android/iOS
 *   - Обробка кнопки "Назад" на Android
 *   - Haptic feedback при верифікації
 *
 * Якщо Capacitor не завантажено — модуль працює як no-op (PWA fallback).
 */

const NativeBridge = (() => {
    'use strict';

    let _initialized = false;

    // ── Ініціалізація ──────────────────────────────────────────────

    async function init() {
        if (_initialized) return;
        _initialized = true;

        if (!_isNative()) {
            console.log('[Native] Running in browser mode (no Capacitor)');
            return;
        }

        console.log('[Native] Capacitor detected, platform:', window.Capacitor.getPlatform());

        // Налаштовуємо StatusBar
        await _setupStatusBar();

        // Обробка кнопки "Назад" на Android
        _setupBackButton();

        // Ховаємо SplashScreen
        await _hideSplash();
    }

    // ── Перевірка середовища ───────────────────────────────────────

    function _isNative() {
        return typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform();
    }

    // ── StatusBar ──────────────────────────────────────────────────

    async function _setupStatusBar() {
        try {
            const { StatusBar } = window.Capacitor.Plugins;
            if (StatusBar) {
                await StatusBar.setStyle({ style: 'DARK' });
                await StatusBar.setBackgroundColor({ color: '#0c0e14' });
            }
        } catch (e) {
            console.log('[Native] StatusBar not available:', e.message);
        }
    }

    // ── SplashScreen ───────────────────────────────────────────────

    async function _hideSplash() {
        try {
            const { SplashScreen } = window.Capacitor.Plugins;
            if (SplashScreen) {
                await SplashScreen.hide();
            }
        } catch (e) {
            console.log('[Native] SplashScreen not available:', e.message);
        }
    }

    // ── Back button (Android) ──────────────────────────────────────

    function _setupBackButton() {
        try {
            const { App: CapApp } = window.Capacitor.Plugins;
            if (CapApp) {
                CapApp.addListener('backButton', ({ canGoBack }) => {
                    if (canGoBack) {
                        window.history.back();
                    } else {
                        CapApp.exitApp();
                    }
                });
            }
        } catch (e) {
            console.log('[Native] App plugin not available:', e.message);
        }
    }

    // ── Haptic feedback ────────────────────────────────────────────

    async function hapticSuccess() {
        if (!_isNative()) return;
        try {
            const { Haptics } = window.Capacitor.Plugins;
            if (Haptics) {
                await Haptics.notification({ type: 'SUCCESS' });
            }
        } catch (e) { /* ignore */ }
    }

    async function hapticError() {
        if (!_isNative()) return;
        try {
            const { Haptics } = window.Capacitor.Plugins;
            if (Haptics) {
                await Haptics.notification({ type: 'ERROR' });
            }
        } catch (e) { /* ignore */ }
    }

    // ── Збереження файлу (нативне) ─────────────────────────────────

    /**
     * Зберігає файл через Capacitor Filesystem.
     * У браузері — фоллбек на Blob URL download.
     *
     * @param {ArrayBuffer|Uint8Array} data - дані файлу
     * @param {string} filename - ім'я файлу
     * @param {string} contentType - MIME тип
     * @returns {Promise<boolean>} true якщо успішно
     */
    async function saveFile(data, filename, contentType) {
        if (!_isNative()) {
            // Браузерний fallback
            FileHandler.downloadFile(data, filename, contentType);
            return true;
        }

        try {
            const { Filesystem } = window.Capacitor.Plugins;
            if (!Filesystem) {
                // Fallback
                FileHandler.downloadFile(data, filename, contentType);
                return true;
            }

            // Конвертуємо ArrayBuffer у base64
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            const base64Data = btoa(binary);

            // Зберігаємо в Downloads
            const result = await Filesystem.writeFile({
                path: `Download/${filename}`,
                data: base64Data,
                directory: 'EXTERNAL_STORAGE',
                recursive: true,
            });

            console.log('[Native] File saved:', result.uri);
            await hapticSuccess();
            return true;

        } catch (e) {
            console.error('[Native] Save file error:', e);
            // Fallback на браузерний спосіб
            FileHandler.downloadFile(data, filename, contentType);
            return true;
        }
    }

    // ── Share API (нативне) ────────────────────────────────────────

    /**
     * Ділиться URL через нативний Share Sheet.
     * @param {string} title
     * @param {string} url
     */
    async function shareUrl(title, url) {
        if (navigator.share) {
            try {
                await navigator.share({ title, url });
                return true;
            } catch (e) {
                if (e.name !== 'AbortError') console.error('[Native] Share error:', e);
            }
        }
        // Fallback — копіюємо в clipboard
        return copyToClipboard(url);
    }

    // ── Clipboard ──────────────────────────────────────────────────

    async function copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (e) {
            // Fallback для старих браузерів
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            return true;
        }
    }

    // ── Публічний API ──────────────────────────────────────────────

    return {
        init,
        isNative: _isNative,
        saveFile,
        shareUrl,
        copyToClipboard,
        hapticSuccess,
        hapticError,
    };
})();

// Ініціалізуємо після завантаження DOM
document.addEventListener('DOMContentLoaded', () => NativeBridge.init());
