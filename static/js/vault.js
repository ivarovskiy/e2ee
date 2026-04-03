/**
 * static/js/vault.js
 * Захищене локальне сховище файлів.
 *
 * Кожен файл зберігається у IndexedDB у зашифрованому вигляді (AES-256-GCM).
 * Ключ шифрування сховища генерується один раз і зберігається у localStorage.
 * Працює і в браузері (PWA), і в Capacitor (Android/iOS).
 */

const VaultModule = (() => {
    'use strict';

    const DB_NAME    = 'sft_vault_v1';
    const DB_VERSION = 1;
    const STORE      = 'files';
    const KEY_LS     = 'sft_vk';   // ключ у localStorage

    let _db  = null;
    let _key = null;   // CryptoKey (AES-GCM 256)

    // ── Ініціалізація ──────────────────────────────────────────────

    async function init() {
        _db  = await _openDB();
        _key = await _getOrCreateKey();
    }

    function _openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onerror = () => reject(new Error('Vault DB: ' + req.error));
            req.onsuccess = () => resolve(req.result);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
                    store.createIndex('by_time', 'timestamp');
                }
            };
        });
    }

    async function _getOrCreateKey() {
        const saved = _lsGet(KEY_LS);
        if (saved) {
            try {
                return await crypto.subtle.importKey(
                    'raw', _b64ToBuffer(saved),
                    { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
                );
            } catch { /* fall through and regenerate */ }
        }
        const key = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
        );
        const raw = await crypto.subtle.exportKey('raw', key);
        _lsSet(KEY_LS, _bufferToB64(raw));
        return key;
    }

    // ── Збереження ─────────────────────────────────────────────────

    async function saveFile(data, filename, contentType, direction, sessionId) {
        if (!_db || !_key) throw new Error('Vault not ready');

        const ab    = data instanceof ArrayBuffer ? data : data.buffer;
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonce }, _key, ab
        );

        return _idbAdd({
            filename:     filename     || 'file',
            contentType:  contentType  || 'application/octet-stream',
            originalSize: ab.byteLength,
            direction:    direction    || 'received',
            sessionId:    sessionId   || '',
            timestamp:    Date.now(),
            nonce:        nonce.buffer,
            data:         encrypted,
        });
    }

    // ── Відкриття / завантаження ────────────────────────────────────

    async function openFile(id) {
        const entry = await _idbGet(id);
        if (!entry) throw new Error('Файл не знайдено');

        const plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(entry.nonce) },
            _key, entry.data
        );
        return { data: plain, filename: entry.filename, contentType: entry.contentType };
    }

    // ── Список ─────────────────────────────────────────────────────

    function listFiles() {
        return new Promise((resolve, reject) => {
            const tx  = _db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).getAll();
            req.onsuccess = () => {
                resolve(req.result
                    .map(e => ({
                        id:           e.id,
                        filename:     e.filename,
                        contentType:  e.contentType,
                        originalSize: e.originalSize,
                        direction:    e.direction,
                        sessionId:    e.sessionId,
                        timestamp:    e.timestamp,
                    }))
                    .sort((a, b) => b.timestamp - a.timestamp)
                );
            };
            req.onerror = () => reject(req.error);
        });
    }

    // ── Видалення ───────────────────────────────────────────────────

    function deleteFile(id) {
        return new Promise((resolve, reject) => {
            const tx  = _db.transaction(STORE, 'readwrite');
            const req = tx.objectStore(STORE).delete(id);
            req.onsuccess = () => resolve();
            req.onerror  = () => reject(req.error);
        });
    }

    // ── Статистика ──────────────────────────────────────────────────

    async function getStats() {
        const files     = await listFiles();
        const totalSize = files.reduce((s, f) => s + f.originalSize, 0);
        return { count: files.length, totalSize };
    }

    // ── IDB helpers ─────────────────────────────────────────────────

    function _idbAdd(entry) {
        return new Promise((resolve, reject) => {
            const tx  = _db.transaction(STORE, 'readwrite');
            const req = tx.objectStore(STORE).add(entry);
            req.onsuccess = () => resolve(req.result);
            req.onerror  = () => reject(req.error);
        });
    }

    function _idbGet(id) {
        return new Promise((resolve, reject) => {
            const tx  = _db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).get(id);
            req.onsuccess = () => resolve(req.result);
            req.onerror  = () => reject(req.error);
        });
    }

    // ── Crypto helpers ──────────────────────────────────────────────

    function _bufferToB64(buf) {
        let str = '';
        new Uint8Array(buf).forEach(b => str += String.fromCharCode(b));
        return btoa(str);
    }

    function _b64ToBuffer(b64) {
        const str = atob(b64);
        const buf = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i);
        return buf.buffer;
    }

    // ── localStorage helpers ────────────────────────────────────────

    function _lsGet(key)       { try { return localStorage.getItem(key); }    catch { return null; } }
    function _lsSet(key, val)  { try { localStorage.setItem(key, val); }      catch { /* ignore */ } }

    // ── Публічний API ───────────────────────────────────────────────

    return { init, saveFile, openFile, listFiles, deleteFile, getStats };
})();
