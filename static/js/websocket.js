/**
 * static/js/websocket.js
 * WebSocket-клієнт для з'єднання з relay-сервером.
 *
 * Функції:
 *   - Підключення до relay-сервера по WSS/WS
 *   - Автоматичний reconnect при розриві
 *   - Маршрутизація вхідних повідомлень за типом
 *   - Відправка JSON-повідомлень
 *   - Chunked передача зашифрованих файлів
 */

const WSClient = (() => {
    'use strict';

    let ws = null;
    let sessionId = null;
    let role = null;
    let reconnectAttempts = 0;
    let intentionalClose = false;
    let pingInterval = null;

    const MAX_RECONNECT_ATTEMPTS = 10;
    const RECONNECT_BASE_DELAY = 800;   // мс
    const PING_INTERVAL_MS = 20_000;    // 20 секунд — keepalive

    // Колбеки для різних типів повідомлень
    const handlers = {};

    // Колбеки стану з'єднання
    let onOpenCallback = null;
    let onCloseCallback = null;
    let onErrorCallback = null;

    // ── Підключення ────────────────────────────────────────────────

    function connect(sId, sRole) {
        sessionId = sId;
        role = sRole;
        intentionalClose = false;
        reconnectAttempts = 0;

        _createConnection();
    }

    function _createConnection() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            ws.close();
        }

        // AppConfig визначає URL залежно від середовища (браузер / Capacitor)
        const url = typeof AppConfig !== 'undefined'
            ? AppConfig.getWsUrl(sessionId, role)
            : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/${sessionId}/${role}`;

        console.log(`[WS] Connecting to ${url}...`);
        ws = new WebSocket(url);

        ws.onopen = () => {
            console.log(`[WS] Connected (session=${sessionId.substring(0, 8)}..., role=${role})`);
            reconnectAttempts = 0;
            _startPing();
            if (onOpenCallback) onOpenCallback();
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                _routeMessage(data);
            } catch (e) {
                console.error('[WS] Failed to parse message:', e);
            }
        };

        ws.onclose = (event) => {
            console.log(`[WS] Disconnected (code=${event.code}, reason=${event.reason})`);
            _stopPing();

            if (onCloseCallback) onCloseCallback(event);

            // Автоматичний reconnect (якщо закриття не було навмисним)
            if (!intentionalClose && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                // Обмежуємо затримку до 5 секунд максимум
                const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(1.5, reconnectAttempts), 5000);
                reconnectAttempts++;
                console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                setTimeout(_createConnection, delay);
            }
        };

        ws.onerror = (error) => {
            console.error('[WS] Error:', error);
            if (onErrorCallback) onErrorCallback(error);
        };
    }

    // ── Маршрутизація повідомлень ──────────────────────────────────

    function _routeMessage(data) {
        const type = data.type;
        if (!type) {
            console.warn('[WS] Message without type:', data);
            return;
        }

        const handler = handlers[type];
        if (handler) {
            handler(data);
        } else {
            console.log(`[WS] Unhandled message type: ${type}`, data);
        }
    }

    // ── Реєстрація обробників ──────────────────────────────────────

    function on(messageType, callback) {
        handlers[messageType] = callback;
    }

    function onOpen(callback) { onOpenCallback = callback; }
    function onClose(callback) { onCloseCallback = callback; }
    function onError(callback) { onErrorCallback = callback; }

    // ── Відправка повідомлень ──────────────────────────────────────

    function send(data) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.error('[WS] Cannot send: not connected');
            return false;
        }

        ws.send(JSON.stringify(data));
        return true;
    }

    // ── Відправка KEY_EXCHANGE ─────────────────────────────────────

    function sendKeyExchange(publicKeyB64, fingerprint) {
        return send({
            type: 'KEY_EXCHANGE',
            public_key: publicKeyB64,
            fingerprint: fingerprint,
            key_algorithm: 'ECDH-P256',
        });
    }

    // ── Відправка VERIFICATION_STATUS ──────────────────────────────

    function sendVerificationStatus(verified) {
        return send({
            type: 'VERIFICATION_STATUS',
            verified: verified,
        });
    }

    // ── Відправка файлу (metadata + chunks + complete) ─────────────

    async function sendFile(metadata, chunks, authTagB64, sha256Plaintext, onProgress) {
        // FILE_METADATA
        send({
            type: 'FILE_METADATA',
            filename: metadata.filename,
            original_size: metadata.originalSize,
            chunk_count: chunks.length,
            nonce: metadata.nonceB64,
            content_type: metadata.contentType || 'application/octet-stream',
        });

        // FILE_CHUNK × N
        for (let i = 0; i < chunks.length; i++) {
            const chunkB64 = CryptoModule.arrayBufferToBase64(chunks[i]);
            send({
                type: 'FILE_CHUNK',
                chunk_index: i,
                total_chunks: chunks.length,
                data: chunkB64,
            });

            if (onProgress) {
                onProgress((i + 1) / chunks.length, i + 1, chunks.length);
            }

            // Невелика пауза щоб не перевантажити WS
            if (i % 10 === 9) {
                await new Promise(r => setTimeout(r, 10));
            }
        }

        // FILE_COMPLETE
        send({
            type: 'FILE_COMPLETE',
            auth_tag: authTagB64,
            sha256_plaintext: sha256Plaintext || '',
        });
    }

    // ── Відправка FILE_ACK ─────────────────────────────────────────

    function sendFileAck(success, errorCode) {
        return send({
            type: 'FILE_ACK',
            success: success,
            error_code: errorCode || null,
        });
    }

    // ── Відправка SESSION_CLOSE ────────────────────────────────────

    function sendClose(reason) {
        send({
            type: 'SESSION_CLOSE',
            reason: reason || 'user_closed',
        });
    }

    // ── Keepalive ping ─────────────────────────────────────────────

    function _startPing() {
        _stopPing();
        pingInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                try { ws.send(JSON.stringify({ type: 'PING' })); } catch(e) {}
            }
        }, PING_INTERVAL_MS);
    }

    function _stopPing() {
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    }

    // ── Закриття з'єднання ─────────────────────────────────────────

    function disconnect(reason) {
        intentionalClose = true;
        _stopPing();
        if (ws) {
            sendClose(reason);
            ws.close(1000, reason || 'user_closed');
            ws = null;
        }
    }

    // ── Стан ───────────────────────────────────────────────────────

    function isConnected() {
        return ws && ws.readyState === WebSocket.OPEN;
    }

    function getSessionId() { return sessionId; }
    function getRole() { return role; }

    // ── Публічний API ──────────────────────────────────────────────

    return {
        connect,
        disconnect,
        send,
        on,
        onOpen,
        onClose,
        onError,
        sendKeyExchange,
        sendVerificationStatus,
        sendFile,
        sendFileAck,
        sendClose,
        isConnected,
        getSessionId,
        getRole,
    };
})();
