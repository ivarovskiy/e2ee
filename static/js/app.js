/**
 * static/js/app.js
 * Головний контролер застосунку.
 *
 * Реалізує State Machine клієнтської сесії (Таблиця 3.9 звіту):
 *   IDLE → KEYS_GENERATED → KEYS_EXCHANGED → VERIFIED → TRANSFERRING → COMPLETED
 *
 * Оркеструє:
 *   - CryptoModule (шифрування)
 *   - WSClient (WebSocket)
 *   - QRModule (верифікація ключів)
 *   - FileHandler (обробка файлів)
 */

const App = (() => {
    'use strict';

    // ── Стани клієнтської сесії ────────────────────────────────────

    const State = {
        IDLE: 'IDLE',
        CREATING_SESSION: 'CREATING_SESSION',
        WAITING_PARTNER: 'WAITING_PARTNER',
        KEYS_GENERATED: 'KEYS_GENERATED',
        KEYS_EXCHANGED: 'KEYS_EXCHANGED',
        VERIFYING: 'VERIFYING',
        VERIFIED: 'VERIFIED',
        TRANSFERRING: 'TRANSFERRING',
        RECEIVING: 'RECEIVING',
        COMPLETED: 'COMPLETED',
        ERROR: 'ERROR',
    };

    // ── Внутрішній стан ────────────────────────────────────────────

    let currentState = State.IDLE;
    let sessionId = null;
    let myRole = null;
    let keyPair = null;
    let myPublicKeyB64 = null;
    let myFingerprint = null;
    let partnerPublicKey = null;
    let partnerFingerprint = null;
    let sharedKey = null;
    let partnerVerified = false;
    let iVerified = false;
    let chunkCollector = null;
    let incomingFileMetadata = null;

    // ── DOM-елементи ───────────────────────────────────────────────

    const $ = (id) => document.getElementById(id);

    // ── Ініціалізація ──────────────────────────────────────────────

    function init() {
        _bindUI();
        _registerWSHandlers();
        _setState(State.IDLE);
        console.log('[App] Initialized');

        // Перевіряємо чи це join-URL
        const path = window.location.pathname;
        if (path.startsWith('/join/')) {
            const sid = path.split('/join/')[1];
            if (sid) {
                sessionId = sid;
                _joinExistingSession(sid);
            }
        }
    }

    // ── UI Binding ─────────────────────────────────────────────────

    function _bindUI() {
        // Кнопка "Створити сесію"
        $('btn-create')?.addEventListener('click', _createSession);

        // Кнопка "Приєднатись" (ввід session ID)
        $('btn-join')?.addEventListener('click', () => {
            const sid = $('input-session-id')?.value?.trim();
            if (sid) _joinExistingSession(sid);
        });

        // Кнопка "Сканувати QR партнера"
        $('btn-scan-qr')?.addEventListener('click', _startQRVerification);

        // Кнопка "Зупинити сканування"
        $('btn-stop-scan')?.addEventListener('click', _stopQRScan);

        // Input файлу
        $('file-input')?.addEventListener('change', _onFileSelected);

        // Кнопка "Нова сесія"
        $('btn-new-session')?.addEventListener('click', _resetToIdle);

        // Ручна верифікація (порівняння тексту)
        $('btn-manual-verify')?.addEventListener('click', _manualVerify);

        // Налаштування URL сервера (для нативної апки)
        $('btn-save-url')?.addEventListener('click', () => {
            const url = $('input-server-url')?.value?.trim();
            if (url && typeof AppConfig !== 'undefined') {
                AppConfig.setServerUrl(url);
                const statusEl = $('server-url-status');
                if (statusEl) statusEl.textContent = '✓ Збережено: ' + url;
                _log(`Relay-сервер: ${url}`);
            }
        });

        // Показуємо карточку URL тільки у нативній апці або коли не на сервері
        _initServerUrlCard();
    }

    function _initServerUrlCard() {
        const isNative = typeof AppConfig !== 'undefined' && AppConfig.isNative();
        const card = $('card-server-url');
        if (!card) return;

        // Показуємо на Android/iOS або якщо сторінка відкрита не з сервера
        if (isNative || window.location.protocol === 'file:' || window.location.protocol === 'capacitor:') {
            card.style.display = '';
            const input = $('input-server-url');
            const statusEl = $('server-url-status');
            if (typeof AppConfig !== 'undefined') {
                const saved = AppConfig.getServerUrl();
                if (saved && input) input.value = saved;
                if (saved && statusEl) statusEl.textContent = '✓ Підключено до: ' + saved;
            }
        }
    }

    // ── WebSocket handlers ─────────────────────────────────────────

    function _registerWSHandlers() {
        WSClient.onOpen(() => {
            _log('Підключено до relay-сервера');
            _sendMyKey();
        });

        WSClient.onClose((event) => {
            if (event.code !== 1000) {
                _log('Зʼєднання з сервером втрачено', 'warn');
            }
        });

        WSClient.onError(() => {
            _log('Помилка зʼєднання з сервером', 'error');
        });

        // SESSION_READY
        WSClient.on('SESSION_READY', (data) => {
            _log('Обидва учасники підключені');
        });

        // PARTNER_CONNECTED
        WSClient.on('PARTNER_CONNECTED', (data) => {
            _log('Партнер приєднався до сесії');
            _showSection('section-keys');
        });

        // PARTNER_DISCONNECTED
        WSClient.on('PARTNER_DISCONNECTED', (data) => {
            _log('Партнер від\'єднався', 'warn');
            _showNotification('Партнер від\'єднався від сесії', 'warning');
        });

        // KEY_RELAY — отримали публічний ключ партнера
        WSClient.on('KEY_RELAY', async (data) => {
            await _handlePartnerKey(data);
        });

        // VERIFICATION_STATUS — партнер повідомив про верифікацію
        WSClient.on('VERIFICATION_STATUS', (data) => {
            partnerVerified = data.verified;
            _log(`Партнер ${data.verified ? 'підтвердив' : 'відхилив'} верифікацію`);
            _checkBothVerified();
        });

        // BOTH_VERIFIED — обидва верифіковані
        WSClient.on('BOTH_VERIFIED', (data) => {
            _setState(State.VERIFIED);
            _log('Обидва учасники верифіковані — передача дозволена!', 'success');
            _showSection('section-transfer');
        });

        // FILE_METADATA — отримуємо метадані файлу
        WSClient.on('FILE_METADATA', (data) => {
            _handleIncomingFileMetadata(data);
        });

        // FILE_CHUNK — отримуємо фрагмент файлу
        WSClient.on('FILE_CHUNK', (data) => {
            _handleIncomingChunk(data);
        });

        // FILE_COMPLETE — передача завершена
        WSClient.on('FILE_COMPLETE', (data) => {
            _handleFileComplete(data);
        });

        // FILE_ACK — підтвердження від отримувача
        WSClient.on('FILE_ACK', (data) => {
            if (data.success) {
                _log('Файл успішно отримано партнером!', 'success');
                _setState(State.COMPLETED);
            } else {
                _log(`Помилка на стороні партнера: ${data.error_code}`, 'error');
            }
        });

        // SESSION_CLOSE
        WSClient.on('SESSION_CLOSE', (data) => {
            _log(`Сесію закрито: ${data.reason}`, 'warn');
            _setState(State.IDLE);
        });

        // ERROR
        WSClient.on('ERROR', (data) => {
            _log(`Помилка сервера: ${data.message}`, 'error');
            if (data.fatal) {
                _setState(State.ERROR);
            }
        });
    }

    // ── Створення нової сесії ──────────────────────────────────────

    async function _createSession() {
        _setState(State.CREATING_SESSION);

        // У нативній апці — перевіряємо наявність URL сервера
        if (typeof AppConfig !== 'undefined' && AppConfig.isNative() && !AppConfig.getServerUrl()) {
            const url = prompt('Введіть URL relay-сервера:', 'https://');
            if (!url) { _setState(State.IDLE); return; }
            AppConfig.setServerUrl(url);
        }

        _log('Створення нової сесії...');

        try {
            // Генеруємо ключову пару
            keyPair = await CryptoModule.generateKeyPair();
            myPublicKeyB64 = await CryptoModule.exportPublicKey(keyPair.publicKey);
            myFingerprint = await CryptoModule.computeFingerprint(keyPair.publicKey);

            _log(`Ключі згенеровано. Fingerprint: ${QRModule.shortFingerprint(myFingerprint)}`);

            // Створюємо сесію на сервері
            const apiUrl = typeof AppConfig !== 'undefined'
                ? AppConfig.getApiUrl('/api/sessions')
                : '/api/sessions';
            const resp = await fetch(apiUrl, { method: 'POST' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

            const data = await resp.json();
            sessionId = data.session_id;

            _log(`Сесія створена: ${sessionId.substring(0, 8)}...`);

            // Показуємо QR для приєднання та URL
            _displayJoinInfo(data);
            _setState(State.WAITING_PARTNER);

            // Підключаємось по WebSocket
            myRole = 'initiator';
            WSClient.connect(sessionId, myRole);

        } catch (err) {
            _log(`Помилка створення сесії: ${err.message}`, 'error');
            _setState(State.ERROR);
        }
    }

    // ── Приєднання до існуючої сесії ───────────────────────────────

    async function _joinExistingSession(sid) {
        _setState(State.CREATING_SESSION);
        sessionId = sid;
        _log(`Приєднання до сесії ${sid.substring(0, 8)}...`);

        try {
            // Генеруємо ключову пару
            keyPair = await CryptoModule.generateKeyPair();
            myPublicKeyB64 = await CryptoModule.exportPublicKey(keyPair.publicKey);
            myFingerprint = await CryptoModule.computeFingerprint(keyPair.publicKey);

            _log(`Ключі згенеровано. Fingerprint: ${QRModule.shortFingerprint(myFingerprint)}`);

            // Підключаємось як joiner
            myRole = 'joiner';
            WSClient.connect(sessionId, myRole);
            _setState(State.KEYS_GENERATED);

        } catch (err) {
            _log(`Помилка приєднання: ${err.message}`, 'error');
            _setState(State.ERROR);
        }
    }

    // ── Відправка свого ключа ──────────────────────────────────────

    function _sendMyKey() {
        if (myPublicKeyB64 && myFingerprint) {
            WSClient.sendKeyExchange(myPublicKeyB64, myFingerprint);
            _log('Публічний ключ відправлено');
        }
    }

    // ── Обробка ключа партнера ─────────────────────────────────────

    async function _handlePartnerKey(data) {
        try {
            partnerFingerprint = data.fingerprint;
            partnerPublicKey = await CryptoModule.importPartnerKey(data.public_key);

            // Деривація спільного ключа (ECDH + HKDF)
            sharedKey = await CryptoModule.deriveSharedKey(
                keyPair.privateKey,
                partnerPublicKey,
                sessionId
            );

            _log(`Ключ партнера отримано. Fingerprint: ${QRModule.shortFingerprint(partnerFingerprint)}`);
            _log('Спільний ключ шифрування деривовано (ECDH + HKDF)');

            _setState(State.KEYS_EXCHANGED);

            // Показуємо секцію верифікації
            _showVerificationUI();

        } catch (err) {
            _log(`Помилка обробки ключа партнера: ${err.message}`, 'error');
        }
    }

    // ── UI верифікації ──────────────────────────────────────────────

    function _showVerificationUI() {
        _showSection('section-verify');

        // Генеруємо QR мого fingerprint (партнер сканує)
        const qrContainer = $('my-qr-code');
        if (qrContainer && myFingerprint) {
            QRModule.generateQR(myFingerprint, qrContainer, { size: 180 });
        }

        // Відображаємо fingerprint партнера (для ручної перевірки)
        const partnerFpEl = $('partner-fingerprint');
        if (partnerFpEl && partnerFingerprint) {
            partnerFpEl.textContent = QRModule.formatFingerprint(partnerFingerprint);
        }

        // Мій fingerprint (для показу партнеру)
        const myFpEl = $('my-fingerprint');
        if (myFpEl && myFingerprint) {
            myFpEl.textContent = QRModule.formatFingerprint(myFingerprint);
        }
    }

    // ── QR-сканування ──────────────────────────────────────────────

    async function _startQRVerification() {
        if (!QRModule.isCameraSupported()) {
            _log('Камера не підтримується. Використовуйте ручну верифікацію.', 'warn');
            return;
        }

        _setState(State.VERIFYING);
        _log('Скануйте QR-код з екрану пристрою партнера...');

        _showElement('scanner-container');
        _hideElement('btn-scan-qr');
        _showElement('btn-stop-scan');

        const video = $('scanner-video');
        const canvas = $('scanner-canvas');

        try {
            const scannedData = await QRModule.startScanning(video, canvas);

            // Порівнюємо
            const match = QRModule.verifyFingerprint(scannedData, partnerFingerprint);

            if (match) {
                iVerified = true;
                WSClient.sendVerificationStatus(true);
                _log('QR-верифікація успішна! Fingerprint збігається.', 'success');
                _showNotification('Ключ партнера підтверджено!', 'success');
            } else {
                iVerified = false;
                WSClient.sendVerificationStatus(false);
                _log('УВАГА: Fingerprint НЕ збігається! Можлива MITM-атака!', 'error');
                _showNotification('НЕБЕЗПЕКА: Ключі не збігаються! Можлива атака!', 'danger');
                _setState(State.KEYS_EXCHANGED);
            }

            _checkBothVerified();

        } catch (err) {
            _log(`Помилка сканування: ${err.message}`, 'error');
            _setState(State.KEYS_EXCHANGED);
        } finally {
            _hideElement('scanner-container');
            _showElement('btn-scan-qr');
            _hideElement('btn-stop-scan');
        }
    }

    function _stopQRScan() {
        QRModule.stopScanning();
        _hideElement('scanner-container');
        _showElement('btn-scan-qr');
        _hideElement('btn-stop-scan');
        _setState(State.KEYS_EXCHANGED);
    }

    // ── Ручна верифікація ──────────────────────────────────────────

    function _manualVerify() {
        const confirmed = confirm(
            `Порівняйте fingerprint партнера через безпечний канал:\n\n` +
            `${QRModule.formatFingerprint(partnerFingerprint)}\n\n` +
            `Fingerprint збігається?`
        );

        if (confirmed) {
            iVerified = true;
            WSClient.sendVerificationStatus(true);
            _log('Ручна верифікація підтверджена', 'success');
        } else {
            iVerified = false;
            WSClient.sendVerificationStatus(false);
            _log('Ручна верифікація відхилена', 'warn');
        }
        _checkBothVerified();
    }

    // ── Перевірка обох верифікацій ──────────────────────────────────

    function _checkBothVerified() {
        if (iVerified && partnerVerified) {
            _setState(State.VERIFIED);
            _showSection('section-transfer');
            _log('Обидва учасники верифіковані!', 'success');
        }

        // Оновлюємо індикатори
        _updateVerificationIndicators();
    }

    // ── Відправка файлу ────────────────────────────────────────────

    async function _onFileSelected(e) {
        const file = e.target.files[0];
        if (!file) return;

        // Валідація
        const validation = FileHandler.validateFile(file);
        if (!validation.valid) {
            _log(validation.error, 'error');
            return;
        }

        if (currentState !== State.VERIFIED) {
            _log('Верифікація не завершена!', 'error');
            return;
        }

        _setState(State.TRANSFERRING);
        _log(`Підготовка файлу: ${file.name} (${FileHandler.formatFileSize(file.size)})...`);
        _updateProgress(0, 'Зчитування файлу...');

        try {
            // Зчитуємо файл
            const plaintext = await FileHandler.readFile(file, (p) => {
                _updateProgress(p * 0.2, 'Зчитування файлу...');
            });

            // SHA-256 оригіналу
            const sha256 = await CryptoModule.sha256Hex(plaintext);
            _log(`SHA-256 оригіналу: ${sha256.substring(0, 16)}...`);

            // Шифрування
            _updateProgress(0.2, 'Шифрування (AES-256-GCM)...');
            const { nonce, ciphertext } = await CryptoModule.encryptFile(sharedKey, plaintext);
            _log(`Зашифровано: ${FileHandler.formatFileSize(ciphertext.length)}`);

            // Розбиваємо на chunk-и
            _updateProgress(0.4, 'Відправка...');
            const chunks = CryptoModule.splitIntoChunks(ciphertext);
            const nonceB64 = CryptoModule.arrayBufferToBase64(nonce);

            // Відправляємо
            await WSClient.sendFile(
                {
                    filename: file.name,
                    originalSize: file.size,
                    nonceB64: nonceB64,
                    contentType: file.type,
                },
                chunks,
                '', // auth_tag включено в ciphertext (Web Crypto API конкатенує)
                sha256,
                (progress, sent, total) => {
                    _updateProgress(0.4 + progress * 0.6, `Відправлено ${sent}/${total} фрагментів`);
                }
            );

            _updateProgress(1, 'Файл відправлено!');
            _log('Файл відправлено, очікуємо підтвердження від партнера...', 'success');

        } catch (err) {
            _log(`Помилка відправки: ${err.message}`, 'error');
            _setState(State.VERIFIED);
        }
    }

    // ── Отримання файлу ────────────────────────────────────────────

    function _handleIncomingFileMetadata(data) {
        incomingFileMetadata = {
            filename: data.filename,
            originalSize: data.original_size,
            totalChunks: data.chunk_count,
            nonceB64: data.nonce,
            contentType: data.content_type,
        };

        _setState(State.RECEIVING);
        _log(`Отримуємо файл: ${data.filename} (${FileHandler.formatFileSize(data.original_size)})...`);

        chunkCollector = FileHandler.createChunkCollector(
            data.chunk_count,
            (progress, received, total) => {
                _updateProgress(progress * 0.7, `Отримано ${received}/${total} фрагментів`);
            }
        );
    }

    function _handleIncomingChunk(data) {
        if (!chunkCollector) return;

        const chunkData = CryptoModule.base64ToArrayBuffer(data.data);
        chunkCollector.addChunk(data.chunk_index, chunkData);
    }

    async function _handleFileComplete(data) {
        if (!chunkCollector || !chunkCollector.isComplete) {
            // Можливо ще не всі chunk-и дійшли; чекаємо
            const waitForChunks = () => new Promise((resolve) => {
                const check = setInterval(() => {
                    if (chunkCollector?.isComplete) {
                        clearInterval(check);
                        resolve();
                    }
                }, 50);
                // Таймаут 10с
                setTimeout(() => { clearInterval(check); resolve(); }, 10000);
            });
            await waitForChunks();
        }

        if (!chunkCollector?.isComplete) {
            _log('Не всі фрагменти отримані!', 'error');
            WSClient.sendFileAck(false, 'INCOMPLETE_CHUNKS');
            _setState(State.VERIFIED);
            return;
        }

        _updateProgress(0.7, 'Розшифрування...');
        _log('Усі фрагменти отримані. Розшифрування...');

        try {
            // Збираємо ciphertext
            const ciphertext = chunkCollector.getResult();
            const nonce = new Uint8Array(CryptoModule.base64ToArrayBuffer(incomingFileMetadata.nonceB64));

            // Розшифрування (GCM автоматично перевіряє auth tag)
            const plaintext = await CryptoModule.decryptFile(sharedKey, nonce, ciphertext);

            _updateProgress(0.9, 'Перевірка цілісності...');

            // Перевірка SHA-256
            const sha256 = await CryptoModule.sha256Hex(plaintext);
            _log(`SHA-256 розшифрованого: ${sha256.substring(0, 16)}...`);

            // Підтверджуємо
            WSClient.sendFileAck(true);

            // Зберігаємо файл
            _updateProgress(1, 'Збереження файлу...');
            // Зберігаємо файл (NativeBridge обирає нативний або браузерний спосіб)
            if (typeof NativeBridge !== 'undefined') {
                await NativeBridge.saveFile(plaintext, incomingFileMetadata.filename, incomingFileMetadata.contentType);
                await NativeBridge.hapticSuccess();
            } else {
                FileHandler.downloadFile(plaintext, incomingFileMetadata.filename, incomingFileMetadata.contentType);
            }

            _log(`Файл «${incomingFileMetadata.filename}» отримано та розшифровано!`, 'success');
            _setState(State.COMPLETED);

        } catch (err) {
            if (err.name === 'OperationError') {
                _log('ПОМИЛКА ЦІЛІСНОСТІ: GCM auth tag не збігається! Дані пошкоджені або підмінені!', 'error');
                _showNotification('Помилка: файл пошкоджено або підмінено під час передачі!', 'danger');
                WSClient.sendFileAck(false, 'AUTH_TAG_MISMATCH');
            } else {
                _log(`Помилка розшифрування: ${err.message}`, 'error');
                WSClient.sendFileAck(false, 'DECRYPT_ERROR');
            }
            _setState(State.VERIFIED);
        } finally {
            chunkCollector = null;
            incomingFileMetadata = null;
        }
    }

    // ── State Machine ──────────────────────────────────────────────

    function _setState(newState) {
        const prev = currentState;
        currentState = newState;
        console.log(`[App] State: ${prev} → ${newState}`);
        _updateUI();
    }

    // ── Скидання ───────────────────────────────────────────────────

    function _resetToIdle() {
        WSClient.disconnect('new_session');
        keyPair = null;
        myPublicKeyB64 = null;
        myFingerprint = null;
        partnerPublicKey = null;
        partnerFingerprint = null;
        sharedKey = null;
        partnerVerified = false;
        iVerified = false;
        sessionId = null;
        myRole = null;
        chunkCollector = null;
        incomingFileMetadata = null;

        // Скидаємо URL
        if (window.location.pathname !== '/') {
            history.pushState(null, '', '/');
        }

        _setState(State.IDLE);
        _log('Сесію завершено. Готові до нової.');
    }

    // ── UI хелпери ─────────────────────────────────────────────────

    function _displayJoinInfo(data) {
        // QR-код запрошення
        const qrContainer = $('session-qr');
        if (qrContainer) {
            qrContainer.innerHTML = '';
            QRModule.generateQR(data.join_url, qrContainer, { size: 200 });
        }

        // Join URL
        const urlEl = $('join-url');
        if (urlEl) {
            urlEl.textContent = data.join_url;
            urlEl.href = data.join_url;
        }

        // Session ID
        const sidEl = $('display-session-id');
        if (sidEl) sidEl.textContent = data.session_id;

        _showSection('section-waiting');
    }

    function _updateUI() {
        // Оновлюємо індикатор стану
        const stateEl = $('current-state');
        if (stateEl) {
            const labels = {
                [State.IDLE]: 'Очікування',
                [State.CREATING_SESSION]: 'Створення...',
                [State.WAITING_PARTNER]: 'Очікування партнера',
                [State.KEYS_GENERATED]: 'Ключі згенеровано',
                [State.KEYS_EXCHANGED]: 'Ключі обмінено',
                [State.VERIFYING]: 'Верифікація...',
                [State.VERIFIED]: 'Верифіковано ✓',
                [State.TRANSFERRING]: 'Передача...',
                [State.RECEIVING]: 'Отримання...',
                [State.COMPLETED]: 'Завершено ✓',
                [State.ERROR]: 'Помилка',
            };
            stateEl.textContent = labels[currentState] || currentState;
            stateEl.className = 'state-badge state-' + currentState.toLowerCase();
        }

        // Показуємо/ховаємо секції
        if (currentState === State.IDLE) {
            _showSection('section-start');
        }

        // Кнопка файлу — лише в стані VERIFIED
        const fileInput = $('file-input');
        if (fileInput) {
            fileInput.disabled = currentState !== State.VERIFIED;
        }

        // Кнопка нової сесії
        const btnNew = $('btn-new-session');
        if (btnNew) {
            btnNew.style.display = (currentState === State.COMPLETED || currentState === State.ERROR) ? '' : 'none';
        }
    }

    function _updateVerificationIndicators() {
        const myIndicator = $('my-verify-status');
        const partnerIndicator = $('partner-verify-status');

        if (myIndicator) {
            myIndicator.textContent = iVerified ? '✓ Ви підтвердили' : '○ Очікує';
            myIndicator.className = iVerified ? 'verify-ok' : 'verify-pending';
        }
        if (partnerIndicator) {
            partnerIndicator.textContent = partnerVerified ? '✓ Партнер підтвердив' : '○ Очікує';
            partnerIndicator.className = partnerVerified ? 'verify-ok' : 'verify-pending';
        }
    }

    function _updateProgress(fraction, label) {
        const bar = $('progress-bar');
        const text = $('progress-text');
        if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
        if (text) text.textContent = label || '';
    }

    function _showSection(sectionId) {
        document.querySelectorAll('.app-section').forEach(s => s.classList.remove('active'));
        const section = $(sectionId);
        if (section) section.classList.add('active');
    }

    function _showElement(id) { const el = $(id); if (el) el.style.display = ''; }
    function _hideElement(id) { const el = $(id); if (el) el.style.display = 'none'; }

    function _showNotification(text, type) {
        const container = $('notifications');
        if (!container) return;

        const el = document.createElement('div');
        el.className = `notification notification-${type || 'info'}`;
        el.textContent = text;
        container.prepend(el);

        setTimeout(() => el.remove(), 8000);
    }

    function _log(msg, level) {
        const logEl = $('activity-log');
        if (!logEl) return;

        const time = new Date().toLocaleTimeString('uk-UA');
        const entry = document.createElement('div');
        entry.className = `log-entry log-${level || 'info'}`;
        entry.innerHTML = `<span class="log-time">${time}</span> ${_escapeHtml(msg)}`;
        logEl.prepend(entry);

        // Обмежуємо кількість записів
        while (logEl.children.length > 50) {
            logEl.removeChild(logEl.lastChild);
        }
    }

    function _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ── Публічний API ──────────────────────────────────────────────

    return {
        init,
        getState: () => currentState,
        getSessionId: () => sessionId,
    };
})();

// Запускаємо після завантаження DOM
document.addEventListener('DOMContentLoaded', App.init);
