/**
 * static/js/crypto.js
 * Криптографічний модуль клієнта.
 *
 * Реалізує повний криптографічний pipeline (підрозділ 3.5.2 звіту):
 *   1. generateKeyPair()       → {privateKey, publicKey}
 *   2. exportPublicKey()       → Base64 SPKI
 *   3. computeFingerprint()    → hex SHA-256
 *   4. importPartnerKey()      → CryptoKey
 *   5. deriveSharedKey()       → AES-256-GCM CryptoKey (ECDH + HKDF)
 *   6. encryptFile()           → {nonce, ciphertext}
 *   7. decryptFile()           → ArrayBuffer | throw on invalid tag
 *
 * Використовує ВИКЛЮЧНО window.crypto.subtle (Web Crypto API).
 * Зовнішні бібліотеки шифрування НЕ використовуються.
 *
 * Алгоритми:
 *   - Обмін ключами: ECDH P-256 (fallback; X25519 через deriveRawKey якщо підтримується)
 *   - Деривація: HKDF-SHA256 (RFC 5869)
 *   - Шифрування: AES-256-GCM (NIST SP 800-38D)
 *   - Fingerprint: SHA-256
 */

const CryptoModule = (() => {
    'use strict';

    // ── Константи ──────────────────────────────────────────────────

    const KEY_ALGORITHM = { name: 'ECDH', namedCurve: 'P-256' };
    const AES_ALGORITHM = { name: 'AES-GCM', length: 256 };
    const HKDF_INFO = new TextEncoder().encode('sft-v1-aes-gcm');
    const NONCE_BYTES = 12;  // 96 біт для GCM
    const TAG_BITS = 128;     // GCM auth tag
    const CHUNK_SIZE = 256 * 1024; // 256 КБ per chunk

    // ── Утиліти кодування ──────────────────────────────────────────

    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    function base64ToArrayBuffer(b64) {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    function arrayBufferToHex(buffer) {
        return Array.from(new Uint8Array(buffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    // ── 1. Генерація ключової пари ECDH ────────────────────────────

    async function generateKeyPair() {
        const keyPair = await crypto.subtle.generateKey(
            KEY_ALGORITHM,
            true,  // extractable — потрібно для exportKey
            ['deriveKey', 'deriveBits']
        );
        return keyPair;
    }

    // ── 2. Експорт публічного ключа (SPKI → Base64) ───────────────

    async function exportPublicKey(publicKey) {
        const spki = await crypto.subtle.exportKey('spki', publicKey);
        return arrayBufferToBase64(spki);
    }

    // ── 3. Обчислення fingerprint (SHA-256 від SPKI) ──────────────

    async function computeFingerprint(publicKey) {
        const spki = await crypto.subtle.exportKey('spki', publicKey);
        const hash = await crypto.subtle.digest('SHA-256', spki);
        return arrayBufferToHex(hash);
    }

    // ── 4. Імпорт публічного ключа партнера ───────────────────────

    async function importPartnerKey(base64SPKI) {
        const spkiBuffer = base64ToArrayBuffer(base64SPKI);
        return await crypto.subtle.importKey(
            'spki',
            spkiBuffer,
            KEY_ALGORITHM,
            false,  // не потрібно re-export
            []      // партнерський ключ — тільки для derive
        );
    }

    // ── 5. Деривація спільного ключа (ECDH + HKDF) ───────────────

    async function deriveSharedKey(privateKey, partnerPublicKey, sessionId) {
        // Крок 1: ECDH → raw shared secret (deriveBits)
        const sharedBits = await crypto.subtle.deriveBits(
            { name: 'ECDH', public: partnerPublicKey },
            privateKey,
            256  // 32 байти
        );

        // Крок 2: Імпортуємо shared secret як HKDF input key material
        const ikm = await crypto.subtle.importKey(
            'raw',
            sharedBits,
            { name: 'HKDF' },
            false,
            ['deriveKey']
        );

        // Крок 3: HKDF-SHA256 → AES-256-GCM key
        const salt = new TextEncoder().encode(sessionId);
        const aesKey = await crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: salt,
                info: HKDF_INFO,
            },
            ikm,
            AES_ALGORITHM,
            false,  // не extractable
            ['encrypt', 'decrypt']
        );

        return aesKey;
    }

    // ── 6. Шифрування файлу (AES-256-GCM) ─────────────────────────

    async function encryptFile(aesKey, fileArrayBuffer) {
        // Генеруємо унікальний nonce (96 біт) через CSPRNG
        const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));

        // AES-256-GCM шифрування
        // Web Crypto API конкатенує ciphertext || auth_tag
        const ciphertextWithTag = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonce, tagLength: TAG_BITS },
            aesKey,
            fileArrayBuffer
        );

        return {
            nonce: nonce,
            ciphertext: new Uint8Array(ciphertextWithTag),
        };
    }

    // ── 7. Розшифрування файлу (AES-256-GCM) ──────────────────────

    async function decryptFile(aesKey, nonce, ciphertextWithTag) {
        // Web Crypto API автоматично перевіряє GCM auth tag
        // При невалідному тегу — кидає OperationError
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: nonce, tagLength: TAG_BITS },
            aesKey,
            ciphertextWithTag
        );

        return plaintext;
    }

    // ── Допоміжні: SHA-256 хеш файлу ──────────────────────────────

    async function sha256Hex(buffer) {
        const hash = await crypto.subtle.digest('SHA-256', buffer);
        return arrayBufferToHex(hash);
    }

    // ── Chunking: розбиття файлу на фрагменти ─────────────────────

    function splitIntoChunks(uint8Array) {
        const chunks = [];
        for (let offset = 0; offset < uint8Array.length; offset += CHUNK_SIZE) {
            const end = Math.min(offset + CHUNK_SIZE, uint8Array.length);
            chunks.push(uint8Array.slice(offset, end));
        }
        return chunks;
    }

    function assembleChunks(chunksArray, totalSize) {
        const result = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of chunksArray) {
            result.set(new Uint8Array(chunk), offset);
            offset += chunk.byteLength || chunk.length;
        }
        return result;
    }

    // ── Публічний API ──────────────────────────────────────────────

    return {
        generateKeyPair,
        exportPublicKey,
        computeFingerprint,
        importPartnerKey,
        deriveSharedKey,
        encryptFile,
        decryptFile,
        sha256Hex,
        splitIntoChunks,
        assembleChunks,

        // Утиліти кодування
        arrayBufferToBase64,
        base64ToArrayBuffer,
        arrayBufferToHex,

        // Константи
        CHUNK_SIZE,
        NONCE_BYTES,
    };
})();
