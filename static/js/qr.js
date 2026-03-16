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
 *
 * Верифікація є ОБОВ'ЯЗКОВИМ кроком — без неї передача файлу неможлива.
 */

const QRModule = (() => {
    'use strict';

    let videoStream = null;
    let scanAnimationId = null;
    let scanning = false;

    // ── Генерація QR-коду ──────────────────────────────────────────

    /**
     * Генерує QR-код з fingerprint і розміщує його у DOM-елементі.
     *
     * @param {string} fingerprint — 64-символьний hex SHA-256
     * @param {HTMLElement} container — DOM-елемент для QR
     * @param {Object} options — додаткові опції
     */
    function generateQR(fingerprint, container, options = {}) {
        // Очищуємо контейнер
        container.innerHTML = '';

        if (typeof QRCode === 'undefined') {
            container.textContent = 'QR library not loaded';
            console.error('[QR] QRCode library not available');
            return;
        }

        const size = options.size || 200;
        const colorDark = options.colorDark || '#ffffff';
        const colorLight = options.colorLight || '#00000000';

        new QRCode(container, {
            text: fingerprint,
            width: size,
            height: size,
            colorDark: colorDark,
            colorLight: colorLight,
            correctLevel: QRCode.CorrectLevel.M,
        });
    }

    // ── Сканування QR-коду через камеру ────────────────────────────

    /**
     * Запускає сканування QR-коду через камеру.
     * Повертає Promise з розпізнаним текстом.
     *
     * @param {HTMLVideoElement} videoElement — елемент відео
     * @param {HTMLCanvasElement} canvasElement — елемент canvas (для jsQR)
     * @param {Function} onFrame — колбек на кожен кадр (для UI індикації)
     * @returns {Promise<string>} — розпізнаний текст QR-коду
     */
    async function startScanning(videoElement, canvasElement, onFrame) {
        if (scanning) {
            stopScanning();
        }

        scanning = true;

        // Запитуємо доступ до камери (задня камера для мобільних)
        try {
            videoStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'environment', // задня камера
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                },
            });
        } catch (err) {
            scanning = false;
            if (err.name === 'NotAllowedError') {
                throw new Error('Доступ до камери заборонено. Дозвольте камеру у налаштуваннях браузера.');
            }
            if (err.name === 'NotFoundError') {
                throw new Error('Камера не знайдена на цьому пристрої.');
            }
            throw new Error(`Помилка камери: ${err.message}`);
        }

        videoElement.srcObject = videoStream;
        videoElement.setAttribute('playsinline', true); // iOS Safari
        await videoElement.play();

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

                // Налаштовуємо canvas під розміри відео
                canvasElement.width = videoElement.videoWidth;
                canvasElement.height = videoElement.videoHeight;
                ctx.drawImage(videoElement, 0, 0);

                // Зчитуємо пікселі для jsQR
                const imageData = ctx.getImageData(0, 0, canvasElement.width, canvasElement.height);

                if (onFrame) onFrame();

                // jsQR розпізнавання
                if (typeof jsQR !== 'undefined') {
                    const code = jsQR(imageData.data, imageData.width, imageData.height, {
                        inversionAttempts: 'dontInvert',
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
            videoStream.getTracks().forEach(track => track.stop());
            videoStream = null;
        }
    }

    // ── Верифікація fingerprint ────────────────────────────────────

    /**
     * Порівнює відсканований fingerprint з очікуваним.
     * Порівняння у постійному часі (захист від timing attack).
     *
     * @param {string} scanned — відсканований fingerprint
     * @param {string} expected — очікуваний fingerprint партнера
     * @returns {boolean} true якщо збігається
     */
    function verifyFingerprint(scanned, expected) {
        if (!scanned || !expected) return false;
        if (scanned.length !== expected.length) return false;

        // Constant-time порівняння
        const a = scanned.toLowerCase();
        const b = expected.toLowerCase();
        let diff = 0;
        for (let i = 0; i < a.length; i++) {
            diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
        }
        return diff === 0;
    }

    // ── Форматування fingerprint для відображення ──────────────────

    /**
     * Форматує fingerprint у читабельний вигляд.
     * Наприклад: "a1b2c3d4 e5f6a7b8 ..."
     *
     * @param {string} fingerprint — 64-символьний hex
     * @returns {string} — форматований рядок
     */
    function formatFingerprint(fingerprint) {
        if (!fingerprint) return '';
        return fingerprint.match(/.{1,8}/g)?.join(' ') || fingerprint;
    }

    /**
     * Повертає скорочений fingerprint для UI.
     * @param {string} fingerprint
     * @returns {string} — перші 16 символів
     */
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
