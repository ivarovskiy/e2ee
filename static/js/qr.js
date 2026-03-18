/**
 * static/js/qr.js
 * Модуль QR-верифікації ключів.
 *
 * Залежності (підключаються через CDN у index.html):
 *   - qrcode.min.js — генерація QR-кодів
 *   - jsQR — сканування QR-кодів через камеру
 *
 * Функції:
 *   1. Генерація QR-коду з fingerprint публічного ключа
 *   2. Сканування QR-коду партнера через камеру смартфона
 *   3. Порівняння відсканованого fingerprint з очікуваним
 */

const QRModule = (() => {
    'use strict';

    let videoStream = null;
    let scanAnimationId = null;
    let scanning = false;

    // ── Генерація QR-коду ──────────────────────────────────────────

    /**
     * Генерує QR-код і розміщує його у DOM-елементі.
     *
     * @param {string} data — дані для кодування (fingerprint або URL)
     * @param {HTMLElement} container — DOM-елемент для QR
     * @param {Object} options — додаткові опції
     */
    function generateQR(data, container, options = {}) {
        if (!container) {
            console.error('[QR] Container element not found');
            return;
        }

        // Очищуємо контейнер
        container.innerHTML = '';

        if (!data) {
            console.error('[QR] No data to encode');
            container.textContent = 'Немає даних для QR';
            return;
        }

        if (typeof QRCode === 'undefined') {
            console.error('[QR] QRCode library not loaded');
            // Fallback: показуємо дані як текст
            _renderFallbackQR(container, data);
            return;
        }

        const size = options.size || 200;

        try {
            new QRCode(container, {
                text: data,
                width: size,
                height: size,
                colorDark: '#ffffff',
                colorLight: '#111318',
                correctLevel: QRCode.CorrectLevel.M,
            });

            // Перевіряємо що QR справді створився
            setTimeout(() => {
                const canvas = container.querySelector('canvas');
                const img = container.querySelector('img');
                if (!canvas && !img) {
                    console.warn('[QR] QR code element not created, using fallback');
                    container.innerHTML = '';
                    _renderFallbackQR(container, data);
                }
            }, 500);
        } catch (err) {
            console.error('[QR] Generation error:', err);
            _renderFallbackQR(container, data);
        }
    }

    /**
     * Fallback: якщо QR-бібліотека не завантажилась,
     * рендеримо дані як текст, який можна скопіювати.
     */
    function _renderFallbackQR(container, data) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'padding:16px;text-align:center;';

        const label = document.createElement('div');
        label.textContent = 'QR не доступний. Скопіюйте дані:';
        label.style.cssText = 'font-size:0.78rem;color:#8b92a8;margin-bottom:8px;';
        wrapper.appendChild(label);

        const text = document.createElement('div');
        text.textContent = data;
        text.style.cssText = 'font-family:monospace;font-size:0.7rem;word-break:break-all;color:#6187f5;user-select:all;line-height:1.6;padding:8px;background:rgba(97,135,245,0.08);border-radius:6px;';
        wrapper.appendChild(text);

        container.appendChild(wrapper);
    }

    // ── Сканування QR-коду через камеру ────────────────────────────

    /**
     * Запускає сканування QR-коду через камеру.
     * На Android Capacitor використовує WebView getUserMedia
     * з обробкою дозволів через MainActivity.
     *
     * @param {HTMLVideoElement} videoElement
     * @param {HTMLCanvasElement} canvasElement
     * @param {Function} onFrame
     * @returns {Promise<string>}
     */
    async function startScanning(videoElement, canvasElement, onFrame) {
        if (scanning) {
            stopScanning();
        }

        scanning = true;

        // Перевіряємо підтримку
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            scanning = false;
            throw new Error('Камера не підтримується на цьому пристрої. Використайте ручну верифікацію.');
        }

        // Запитуємо доступ до камери
        try {
            // Спочатку спробуємо задню камеру (для мобільних)
            videoStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                },
                audio: false,
            });
        } catch (firstErr) {
            // Якщо задня камера не доступна, спробуємо будь-яку камеру
            try {
                videoStream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: false,
                });
            } catch (err) {
                scanning = false;
                if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                    throw new Error('Доступ до камери заборонено. Дозвольте камеру у налаштуваннях додатку.');
                }
                if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
                    throw new Error('Камера не знайдена. Використайте ручну верифікацію.');
                }
                if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
                    throw new Error('Камера зайнята іншим додатком.');
                }
                throw new Error(`Помилка камери: ${err.message}`);
            }
        }

        videoElement.srcObject = videoStream;
        videoElement.setAttribute('playsinline', 'true');
        videoElement.setAttribute('muted', 'true');

        try {
            await videoElement.play();
        } catch (playErr) {
            stopScanning();
            throw new Error('Не вдалось запустити відео з камери.');
        }

        const ctx = canvasElement.getContext('2d', { willReadFrequently: true });

        return new Promise((resolve, reject) => {
            function scanFrame() {
                if (!scanning) {
                    reject(new Error('Сканування зупинено'));
                    return;
                }

                if (videoElement.readyState !== videoElement.HAVE_ENOUGH_DATA) {
                    scanAnimationId = requestAnimationFrame(scanFrame);
                    return;
                }

                canvasElement.width = videoElement.videoWidth;
                canvasElement.height = videoElement.videoHeight;
                ctx.drawImage(videoElement, 0, 0);

                const imageData = ctx.getImageData(0, 0, canvasElement.width, canvasElement.height);

                if (onFrame) onFrame();

                // jsQR розпізнавання
                if (typeof jsQR !== 'undefined') {
                    const code = jsQR(imageData.data, imageData.width, imageData.height, {
                        inversionAttempts: 'attemptBoth',
                    });

                    if (code && code.data) {
                        console.log('[QR] Scanned:', code.data.substring(0, 16) + '...');
                        stopScanning();
                        resolve(code.data);
                        return;
                    }
                }

                scanAnimationId = requestAnimationFrame(scanFrame);
            }

            scanAnimationId = requestAnimationFrame(scanFrame);
        });
    }

    // ── Зупинка сканування ─────────────────────────────────────────

    function stopScanning() {
        scanning = false;

        if (scanAnimationId) {
            cancelAnimationFrame(scanAnimationId);
            scanAnimationId = null;
        }

        if (videoStream) {
            videoStream.getTracks().forEach(track => {
                try { track.stop(); } catch(e) {}
            });
            videoStream = null;
        }
    }

    // ── Верифікація fingerprint ────────────────────────────────────

    /**
     * Порівнює відсканований fingerprint з очікуваним.
     * Constant-time порівняння (захист від timing attack).
     */
    function verifyFingerprint(scanned, expected) {
        if (!scanned || !expected) return false;
        if (scanned.length !== expected.length) return false;

        const a = scanned.toLowerCase();
        const b = expected.toLowerCase();
        let diff = 0;
        for (let i = 0; i < a.length; i++) {
            diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
        }
        return diff === 0;
    }

    // ── Форматування fingerprint для відображення ──────────────────

    function formatFingerprint(fingerprint) {
        if (!fingerprint) return '';
        return fingerprint.match(/.{1,8}/g)?.join(' ') || fingerprint;
    }

    function shortFingerprint(fingerprint) {
        if (!fingerprint) return '';
        return fingerprint.substring(0, 16).toUpperCase();
    }

    // ── Перевірка підтримки камери ─────────────────────────────────

    function isCameraSupported() {
        return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    // ── Публічний API ──────────────────────────────────────────────

    return {
        generateQR,
        startScanning,
        stopScanning,
        verifyFingerprint,
        formatFingerprint,
        shortFingerprint,
        isCameraSupported,
    };
})();
