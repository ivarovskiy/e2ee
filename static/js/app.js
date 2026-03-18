/**
 * static/js/app.js — v3
 * Головний контролер з навігацією, step indicator, circular progress.
 */
const App = (() => {
    'use strict';

    const State = {
        IDLE: 'IDLE', CREATING: 'CREATING', WAITING_PARTNER: 'WAITING_PARTNER',
        KEYS_EXCHANGED: 'KEYS_EXCHANGED', VERIFYING: 'VERIFYING', VERIFIED: 'VERIFIED',
        TRANSFERRING: 'TRANSFERRING', RECEIVING: 'RECEIVING',
        COMPLETED: 'COMPLETED', ERROR: 'ERROR',
    };

    const StateInfo = {
        [State.IDLE]:            { label: 'Головна',              hint: 'Створіть сесію або приєднайтесь до існуючої', step: 0 },
        [State.CREATING]:        { label: 'Підключення...',       hint: 'З\'єднання з сервером', step: 1 },
        [State.WAITING_PARTNER]: { label: 'Очікування партнера',  hint: 'Покажіть QR-код або надішліть посилання', step: 1 },
        [State.KEYS_EXCHANGED]:  { label: 'Верифікація ключів',   hint: 'Відскануйте QR з екрану партнера камерою', step: 3 },
        [State.VERIFYING]:       { label: 'Сканування...',        hint: 'Наведіть камеру на QR партнера', step: 3 },
        [State.VERIFIED]:        { label: 'Готово до передачі',   hint: 'Оберіть файл або очікуйте від партнера', step: 4 },
        [State.TRANSFERRING]:    { label: 'Відправка...',         hint: 'Файл шифрується та передається', step: 4 },
        [State.RECEIVING]:       { label: 'Отримання...',         hint: 'Файл завантажується', step: 4 },
        [State.COMPLETED]:       { label: 'Завершено',            hint: 'Файл успішно передано!', step: 4 },
        [State.ERROR]:           { label: 'Помилка',              hint: 'Щось пішло не так', step: 0 },
    };

    let currentState = State.IDLE;
    let sessionId = null, myRole = null, keyPair = null;
    let myPublicKeyB64 = null, myFingerprint = null;
    let partnerPublicKey = null, partnerFingerprint = null;
    let sharedKey = null, partnerVerified = false, iVerified = false;
    let chunkCollector = null, incomingFileMetadata = null, partnerConnected = false;

    const $ = (id) => document.getElementById(id);

    // ═══ INIT ═══════════════════════════════════════════════════════
    function init() {
        _bindUI();
        _registerWSHandlers();
        _setState(State.IDLE);
        _showSection('section-start');
        _injectProgressGradient();
        const path = window.location.pathname;
        if (path.startsWith('/join/')) { const sid = path.split('/join/')[1]; if (sid) _joinExistingSession(sid); }
    }

    // ═══ SVG GRADIENT FOR PROGRESS ════════════════════════════════
    function _injectProgressGradient() {
        const svg = document.querySelector('.progress-ring');
        if (!svg) return;
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
        grad.setAttribute('id', 'progress-gradient');
        grad.setAttribute('x1', '0%'); grad.setAttribute('y1', '0%');
        grad.setAttribute('x2', '100%'); grad.setAttribute('y2', '0%');
        const s1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        s1.setAttribute('offset', '0%'); s1.setAttribute('style', 'stop-color:#6187f5');
        const s2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        s2.setAttribute('offset', '100%'); s2.setAttribute('style', 'stop-color:#a78bfa');
        grad.appendChild(s1); grad.appendChild(s2);
        defs.appendChild(grad); svg.insertBefore(defs, svg.firstChild);
    }

    // ═══ UI BINDING ═════════════════════════════════════════════════
    function _bindUI() {
        $('btn-create')?.addEventListener('click', _createSession);
        $('btn-join')?.addEventListener('click', () => {
            const sid = $('input-session-id')?.value?.trim();
            if (!sid) { _showNotification('Введіть ID сесії', 'warning'); return; }
            _joinExistingSession(sid);
        });
        $('btn-scan-qr')?.addEventListener('click', _startQRVerification);
        $('btn-stop-scan')?.addEventListener('click', _stopQRScan);
        $('btn-manual-verify')?.addEventListener('click', _manualVerify);
        $('file-input')?.addEventListener('change', _onFileSelected);
        $('btn-copy-link')?.addEventListener('click', _copyJoinLink);
        $('btn-share-link')?.addEventListener('click', _shareJoinLink);
        document.querySelectorAll('.btn-back').forEach(b => b.addEventListener('click', _goBack));
        document.querySelectorAll('.btn-new-session').forEach(b => b.addEventListener('click', _resetToIdle));
        $('btn-save-url')?.addEventListener('click', () => {
            const url = $('input-server-url')?.value?.trim();
            if (url && typeof AppConfig !== 'undefined') {
                AppConfig.setServerUrl(url);
                const s = $('server-url-status'); if(s) s.textContent = 'Збережено';
                _showNotification('Сервер збережено', 'success');
            }
        });
        _initServerUrlCard();
    }

    // ═══ BACK NAVIGATION ════════════════════════════════════════════
    function _goBack() {
        try { QRModule.stopScanning(); } catch(e) {}
        if (currentState === State.TRANSFERRING || currentState === State.RECEIVING) {
            if (!confirm('Передача не завершена. Скасувати?')) return;
        }
        _resetToIdle();
    }

    // ═══ WEBSOCKET HANDLERS ═════════════════════════════════════════
    function _registerWSHandlers() {
        WSClient.onOpen(() => { _log('Підключено до сервера'); _sendMyKey(); });
        WSClient.onClose((ev) => {
            if (ev.code !== 1000 && currentState !== State.IDLE) {
                _log('З\'єднання втрачено', 'warn');
                _showNotification('З\'єднання з сервером втрачено', 'warning');
            }
        });
        WSClient.onError(() => { if (currentState !== State.IDLE) _log('Помилка з\'єднання', 'error'); });

        WSClient.on('SESSION_READY', () => { partnerConnected = true; _log('Обидва підключені'); });
        WSClient.on('PARTNER_CONNECTED', () => {
            partnerConnected = true;
            _log('Партнер приєднався');
            _showNotification('Партнер приєднався!', 'success');
        });
        WSClient.on('PARTNER_DISCONNECTED', () => {
            partnerConnected = false; _log('Партнер від\'єднався', 'warn');
            if (currentState === State.TRANSFERRING || currentState === State.RECEIVING) {
                _showNotification('Партнер від\'єднався під час передачі!', 'danger');
                chunkCollector = null; incomingFileMetadata = null;
                _setState(State.ERROR); _showSection('section-error');
            } else if (currentState === State.KEYS_EXCHANGED || currentState === State.VERIFYING) {
                _showNotification('Партнер від\'єднався', 'warning');
                _setState(State.ERROR); _showSection('section-error');
            } else if (currentState !== State.IDLE && currentState !== State.WAITING_PARTNER) {
                _showNotification('Партнер від\'єднався', 'warning');
            }
        });

        WSClient.on('KEY_RELAY', async (data) => {
            try { await _handlePartnerKey(data); }
            catch (e) { _log(`Помилка ключа: ${e.message}`, 'error'); _setState(State.ERROR); _showSection('section-error'); }
        });
        WSClient.on('VERIFICATION_STATUS', (d) => {
            partnerVerified = !!d.verified;
            _log(partnerVerified ? 'Партнер підтвердив ваш ключ' : 'Партнер відхилив', partnerVerified ? 'success' : 'warn');
            _checkBothVerified();
        });
        WSClient.on('BOTH_VERIFIED', () => {
            _setState(State.VERIFIED); _showNotification('Верифікація пройдена!', 'success');
            _showSection('section-transfer');
        });
        WSClient.on('FILE_METADATA', (d) => { try { _handleIncomingFileMetadata(d); } catch(e) { _log(`Помилка: ${e.message}`, 'error'); } });
        WSClient.on('FILE_CHUNK', (d) => { try { _handleIncomingChunk(d); } catch(e) {} });
        WSClient.on('FILE_COMPLETE', async (d) => { try { await _handleFileComplete(); } catch(e) { _log(`Помилка: ${e.message}`, 'error'); _setState(State.VERIFIED); _showSection('section-transfer'); } });
        WSClient.on('FILE_ACK', (d) => {
            if (d.success) { _log('Партнер отримав файл!', 'success'); _showNotification('Файл доставлено!', 'success'); _setState(State.COMPLETED); _showSection('section-completed'); }
            else { _log(`Помилка у партнера: ${d.error_code||'?'}`, 'error'); _showNotification('Партнер не зміг розшифрувати', 'danger'); _setState(State.VERIFIED); _showSection('section-transfer'); }
        });
        WSClient.on('SESSION_CLOSE', (d) => { _log(`Сесію закрито: ${d?.reason||''}`, 'warn'); _showNotification('Сесію закрито', 'warning'); _resetToIdle(); });
        WSClient.on('ERROR', (d) => {
            _log(`Сервер: ${d?.message||'помилка'}`, 'error'); _showNotification(d?.message||'Помилка сервера', 'danger');
            if (d?.fatal) { _setState(State.ERROR); _showSection('section-error'); }
        });
    }

    // ═══ SESSION ═════════════════════════════════════════════════════
    async function _createSession() {
        if (typeof AppConfig !== 'undefined' && AppConfig.isNative() && !AppConfig.getServerUrl()) {
            _showNotification('Спочатку вкажіть URL relay-сервера', 'warning'); return;
        }
        _setState(State.CREATING); _log('Створення сесії...');
        try {
            keyPair = await CryptoModule.generateKeyPair();
            myPublicKeyB64 = await CryptoModule.exportPublicKey(keyPair.publicKey);
            myFingerprint = await CryptoModule.computeFingerprint(keyPair.publicKey);
            const apiUrl = typeof AppConfig !== 'undefined' ? AppConfig.getApiUrl('/api/sessions') : '/api/sessions';
            const resp = await fetch(apiUrl, { method: 'POST' });
            if (!resp.ok) throw new Error(`Сервер: HTTP ${resp.status}`);
            const data = await resp.json(); sessionId = data.session_id;
            _displayJoinInfo(data); _setState(State.WAITING_PARTNER); _showSection('section-waiting');
            myRole = 'initiator'; WSClient.connect(sessionId, myRole);
        } catch (err) {
            _log(`Помилка: ${err.message}`, 'error'); _showNotification(`Не вдалось: ${err.message}`, 'danger');
            _setState(State.ERROR); _showSection('section-error');
        }
    }

    async function _joinExistingSession(sid) {
        if (typeof AppConfig !== 'undefined' && AppConfig.isNative() && !AppConfig.getServerUrl()) {
            _showNotification('Спочатку вкажіть URL relay-сервера', 'warning'); return;
        }
        _setState(State.CREATING); sessionId = sid; _log(`Приєднання до ${sid.substring(0,8)}...`);
        try {
            keyPair = await CryptoModule.generateKeyPair();
            myPublicKeyB64 = await CryptoModule.exportPublicKey(keyPair.publicKey);
            myFingerprint = await CryptoModule.computeFingerprint(keyPair.publicKey);
            myRole = 'joiner'; WSClient.connect(sessionId, myRole);
            _setState(State.WAITING_PARTNER); _showSection('section-joining');
        } catch (err) {
            _log(`Помилка: ${err.message}`, 'error'); _showNotification('Не вдалось приєднатись', 'danger');
            _setState(State.ERROR); _showSection('section-error');
        }
    }

    function _sendMyKey() { if (myPublicKeyB64 && myFingerprint) { WSClient.sendKeyExchange(myPublicKeyB64, myFingerprint); _log('Ключ відправлено'); } }

    async function _handlePartnerKey(data) {
        partnerFingerprint = data.fingerprint;
        partnerPublicKey = await CryptoModule.importPartnerKey(data.public_key);
        sharedKey = await CryptoModule.deriveSharedKey(keyPair.privateKey, partnerPublicKey, sessionId);
        _log('Ключі обмінено'); _setState(State.KEYS_EXCHANGED); _showVerificationUI();
    }

    // ═══ VERIFICATION ═══════════════════════════════════════════════
    function _showVerificationUI() {
        _showSection('section-verify');
        const qr = $('my-qr-code'); if (qr && myFingerprint) { qr.innerHTML = ''; QRModule.generateQR(myFingerprint, qr, { size: 160 }); }
        const pfp = $('partner-fingerprint'); if (pfp) pfp.textContent = QRModule.formatFingerprint(partnerFingerprint || '');
        const mfp = $('my-fingerprint'); if (mfp) mfp.textContent = QRModule.formatFingerprint(myFingerprint || '');
        _updateVerificationIndicators();
    }

    async function _startQRVerification() {
        if (!QRModule.isCameraSupported()) { _showNotification('Камера не доступна', 'warning'); return; }
        _setState(State.VERIFYING);
        _showElement('scanner-container'); _hideElement('btn-scan-qr'); _hideElement('btn-manual-verify'); _showElement('btn-stop-scan');
        try {
            const scanned = await QRModule.startScanning($('scanner-video'), $('scanner-canvas'));
            const match = QRModule.verifyFingerprint(scanned, partnerFingerprint);
            iVerified = match;
            WSClient.sendVerificationStatus(match);
            if (match) { _log('QR-верифікація пройдена', 'success'); _showNotification('Ключ підтверджено!', 'success'); try { NativeBridge.hapticSuccess(); } catch(e){} }
            else { _log('Ключі НЕ збігаються!', 'error'); _showNotification('НЕБЕЗПЕКА: ключі не збігаються!', 'danger'); try { NativeBridge.hapticError(); } catch(e){} }
            _checkBothVerified();
        } catch (err) {
            if (err.message !== 'Сканування зупинено') { _log(`Камера: ${err.message}`, 'warn'); _showNotification(err.message, 'warning'); }
        } finally {
            _hideElement('scanner-container'); _showElement('btn-scan-qr'); _showElement('btn-manual-verify'); _hideElement('btn-stop-scan');
            if (currentState === State.VERIFYING) _setState(State.KEYS_EXCHANGED);
        }
    }

    function _stopQRScan() {
        try { QRModule.stopScanning(); } catch(e) {}
        _hideElement('scanner-container'); _showElement('btn-scan-qr'); _showElement('btn-manual-verify'); _hideElement('btn-stop-scan');
        _setState(State.KEYS_EXCHANGED);
    }

    function _manualVerify() {
        const ok = confirm('Порівняйте fingerprint партнера:\n\n' + QRModule.formatFingerprint(partnerFingerprint) + '\n\nЗбігається?');
        iVerified = ok; WSClient.sendVerificationStatus(ok);
        _log(ok ? 'Верифікація пройдена' : 'Верифікація відхилена', ok ? 'success' : 'warn');
        _checkBothVerified();
    }

    function _checkBothVerified() { _updateVerificationIndicators(); if (iVerified && partnerVerified) { _setState(State.VERIFIED); _showSection('section-transfer'); } }
    function _updateVerificationIndicators() {
        const m = $('my-verify-status'), p = $('partner-verify-status');
        if (m) {
            m.className = iVerified ? 'verify-chip verify-ok' : 'verify-chip verify-pending';
            const span = m.querySelector('span'); if (span) span.textContent = iVerified ? 'Ви (ok)' : 'Ви';
        }
        if (p) {
            p.className = partnerVerified ? 'verify-chip verify-ok' : 'verify-chip verify-pending';
            const span = p.querySelector('span'); if (span) span.textContent = partnerVerified ? 'Партнер (ok)' : 'Партнер';
        }
    }

    // ═══ FILE TRANSFER ══════════════════════════════════════════════
    async function _onFileSelected(e) {
        const file = e.target.files?.[0]; if (!file) return;
        const v = FileHandler.validateFile(file); if (!v.valid) { _showNotification(v.error, 'warning'); return; }
        if (!partnerConnected) { _showNotification('Партнер не підключений', 'warning'); return; }
        _setState(State.TRANSFERRING); _showSection('section-progress'); _updateProgress(0, 'Зчитування...');
        _log(`Файл: ${file.name} (${FileHandler.formatFileSize(file.size)})`);
        try {
            const pt = await FileHandler.readFile(file, p => _updateProgress(p * 0.2, 'Зчитування...'));
            const sha = await CryptoModule.sha256Hex(pt);
            _updateProgress(0.2, 'Шифрування...'); const { nonce, ciphertext } = await CryptoModule.encryptFile(sharedKey, pt);
            _updateProgress(0.4, 'Відправка...'); const chunks = CryptoModule.splitIntoChunks(ciphertext);
            await WSClient.sendFile({ filename: file.name, originalSize: file.size, nonceB64: CryptoModule.arrayBufferToBase64(nonce), contentType: file.type }, chunks, '', sha,
                (p, s, t) => _updateProgress(0.4 + p * 0.6, `${s}/${t} фрагментів`));
            _updateProgress(1, 'Очікуємо підтвердження...'); _log('Відправлено, очікуємо...');
        } catch (err) { _log(`Помилка: ${err.message}`, 'error'); _showNotification('Помилка відправки', 'danger'); _setState(State.VERIFIED); _showSection('section-transfer'); }
        e.target.value = '';
    }

    function _handleIncomingFileMetadata(d) {
        if (!sharedKey) return;
        incomingFileMetadata = { filename: d.filename, originalSize: d.original_size, totalChunks: d.chunk_count, nonceB64: d.nonce, contentType: d.content_type };
        _setState(State.RECEIVING); _showSection('section-progress');
        _log(`Отримуємо: ${d.filename} (${FileHandler.formatFileSize(d.original_size)})`);
        chunkCollector = FileHandler.createChunkCollector(d.chunk_count, (p, r, t) => _updateProgress(p * 0.7, `${r}/${t} фрагментів`));
    }

    function _handleIncomingChunk(d) { if (chunkCollector) try { chunkCollector.addChunk(d.chunk_index, CryptoModule.base64ToArrayBuffer(d.data)); } catch(e) {} }

    async function _handleFileComplete() {
        if (chunkCollector && !chunkCollector.isComplete) {
            await new Promise(r => { let t = 0; const iv = setInterval(() => { if (chunkCollector?.isComplete || ++t > 200) { clearInterval(iv); r(); } }, 50); });
        }
        if (!chunkCollector?.isComplete) {
            _showNotification('Передача неповна', 'danger'); try { WSClient.sendFileAck(false, 'INCOMPLETE'); } catch(e) {}
            _setState(State.VERIFIED); _showSection('section-transfer'); chunkCollector = null; incomingFileMetadata = null; return;
        }
        _updateProgress(0.7, 'Розшифрування...');
        try {
            const ct = chunkCollector.getResult(), nonce = new Uint8Array(CryptoModule.base64ToArrayBuffer(incomingFileMetadata.nonceB64));
            const pt = await CryptoModule.decryptFile(sharedKey, nonce, ct);
            _updateProgress(0.95, 'Збереження...'); WSClient.sendFileAck(true);
            if (typeof NativeBridge !== 'undefined') { await NativeBridge.saveFile(pt, incomingFileMetadata.filename, incomingFileMetadata.contentType); try { NativeBridge.hapticSuccess(); } catch(e){} }
            else FileHandler.downloadFile(pt, incomingFileMetadata.filename, incomingFileMetadata.contentType);
            _updateProgress(1, 'Готово!'); _log(`«${incomingFileMetadata.filename}» отримано!`, 'success'); _showNotification('Файл збережено!', 'success');
            _setState(State.COMPLETED); _showSection('section-completed');
        } catch (err) {
            if (err.name === 'OperationError') { _log('Дані пошкоджені!', 'error'); _showNotification('Файл пошкоджено!', 'danger'); try { WSClient.sendFileAck(false, 'AUTH_TAG_MISMATCH'); } catch(e) {} }
            else { _log(`Помилка: ${err.message}`, 'error'); try { WSClient.sendFileAck(false, 'DECRYPT_ERROR'); } catch(e) {} }
            _setState(State.VERIFIED); _showSection('section-transfer');
        } finally { chunkCollector = null; incomingFileMetadata = null; }
    }

    // ═══ STATE / UI ═════════════════════════════════════════════════
    function _setState(s) {
        currentState = s;
        const info = StateInfo[s] || {};

        // Update state badge
        const el = $('current-state');
        if (el) {
            el.textContent = info.label || s;
            el.className = 'state-badge state-' + s.toLowerCase();
        }

        // Update hint
        const h = $('current-hint');
        if (h) h.textContent = info.hint || '';

        // Update step indicator
        _updateStepIndicator(info.step || 0);
    }

    function _updateStepIndicator(activeStep) {
        const indicator = $('step-indicator');
        if (!indicator) return;

        // Show/hide step indicator
        indicator.style.display = activeStep > 0 ? 'flex' : 'none';

        const steps = indicator.querySelectorAll('.step');
        const lines = indicator.querySelectorAll('.step-line');

        steps.forEach((step, i) => {
            const stepNum = i + 1;
            step.classList.remove('active', 'done');
            if (stepNum < activeStep) step.classList.add('done');
            else if (stepNum === activeStep) step.classList.add('active');
        });

        lines.forEach((line, i) => {
            line.classList.remove('done');
            if (i + 1 < activeStep) line.classList.add('done');
        });
    }

    function _resetToIdle() {
        try { QRModule.stopScanning(); } catch(e) {} try { WSClient.disconnect('user_back'); } catch(e) {}
        keyPair=null; myPublicKeyB64=null; myFingerprint=null; partnerPublicKey=null; partnerFingerprint=null;
        sharedKey=null; partnerVerified=false; iVerified=false; sessionId=null; myRole=null; partnerConnected=false;
        chunkCollector=null; incomingFileMetadata=null;
        try { if (window.location.pathname !== '/') history.pushState(null, '', '/'); } catch(e) {}
        _setState(State.IDLE); _showSection('section-start'); _updateProgress(0, '');
    }

    function _displayJoinInfo(data) {
        const qr = $('session-qr'); if (qr) { qr.innerHTML = ''; QRModule.generateQR(data.join_url, qr, { size: 180 }); }
        const url = $('join-url'); if (url) { url.textContent = data.join_url; url.dataset.url = data.join_url; }
        const sid = $('display-session-id'); if (sid) sid.textContent = data.session_id;
    }
    function _copyJoinLink() { const u = $('join-url')?.dataset?.url; if (u) { try { navigator.clipboard.writeText(u); } catch(e) { try { NativeBridge.copyToClipboard(u); } catch(e2){} } _showNotification('Скопійовано!', 'success'); } }
    function _shareJoinLink() { const u = $('join-url')?.dataset?.url; if (u && navigator.share) navigator.share({ title: 'SecureDrop', url: u }).catch(()=>{}); else _copyJoinLink(); }

    function _updateProgress(f, l) {
        const pct = Math.round(f * 100);

        // Linear bar
        const b = $('progress-bar');
        if (b) b.style.width = `${pct}%`;

        // Text label
        const t = $('progress-text');
        if (t) t.textContent = l || '';

        // Percent display
        const pp = $('progress-percent');
        if (pp) pp.textContent = `${pct}%`;

        // Circular ring
        const ring = $('progress-ring-fill');
        if (ring) {
            const circumference = 2 * Math.PI * 52; // r=52
            const offset = circumference - (f * circumference);
            ring.style.strokeDashoffset = offset;
        }
    }

    function _showSection(id) { document.querySelectorAll('.app-section').forEach(s => s.classList.remove('active')); $(id)?.classList.add('active'); }
    function _showElement(id) { const e = $(id); if (e) e.style.display = ''; }
    function _hideElement(id) { const e = $(id); if (e) e.style.display = 'none'; }
    function _showNotification(text, type) {
        const c = $('notifications'); if (!c) return;
        const el = document.createElement('div');
        el.className = `notification notification-${type||'info'}`;
        el.textContent = text;
        el.addEventListener('click', () => {
            el.style.opacity = '0';
            el.style.transform = 'translateY(-8px)';
            setTimeout(() => { try { el.remove(); } catch(e){} }, 200);
        });
        c.prepend(el);
        setTimeout(() => { try { el.style.opacity = '0'; el.style.transform = 'translateY(-8px)'; setTimeout(() => { try { el.remove(); } catch(e){} }, 200); } catch(e){} }, 5000);
    }
    function _log(msg, level) {
        const el = $('activity-log'); if (!el) return;
        const d = document.createElement('div'); d.className = `log-entry log-${level||'info'}`;
        d.innerHTML = `<span class="log-time">${new Date().toLocaleTimeString('uk-UA')}</span> ${msg.replace(/</g,'&lt;')}`;
        el.prepend(d); while (el.children.length > 50) el.removeChild(el.lastChild);
    }
    function _initServerUrlCard() {
        const native = typeof AppConfig !== 'undefined' && AppConfig.isNative();
        const card = $('card-server-url'); if (!card) return;
        if (native || window.location.protocol === 'file:' || window.location.protocol === 'capacitor:') {
            card.style.display = ''; const saved = typeof AppConfig !== 'undefined' ? AppConfig.getServerUrl() : null;
            if (saved) { const i = $('input-server-url'); if (i) i.value = saved; const s = $('server-url-status'); if (s) s.textContent = saved; }
        }
    }

    return { init, getState: () => currentState };
})();
document.addEventListener('DOMContentLoaded', App.init);
