# SecureDrop — Технічна архітектура

> Повний технічний опис системи для написання звіту.  
> Версія: 4.0 | Дата: 2026-04-30

---

## Зміст

1. [Загальний огляд системи](#1-загальний-огляд)
2. [Криптографічний протокол](#2-криптографічний-протокол)
3. [Серверна частина](#3-серверна-частина)
4. [Клієнтська частина](#4-клієнтська-частина)
5. [Захищене сховище (Vault)](#5-захищене-сховище)
6. [Android-застосунок (Capacitor)](#6-android-застосунок)
7. [Протокол WebSocket](#7-протокол-websocket)
8. [Безпека та аналіз загроз](#8-безпека-та-аналіз-загроз)
9. [Стійкість з'єднання](#9-стійкість-зєднання)
10. [Тестування](#10-тестування)
11. [Розгортання](#11-розгортання)
12. [Відомі обмеження](#12-відомі-обмеження)

---

## 1. Загальний огляд

### 1.1 Мета системи

SecureDrop — система для передачі файлів між двома пристроями з гарантією конфіденційності навіть за умови компрометації relay-сервера. Основна інновація: **сервер є математично нездатним розшифрувати трафік**, бо не отримує жодних ключів або незашифрованих даних.

### 1.2 Учасники та ролі

| Роль | Опис | Технічна назва |
|------|------|----------------|
| Ініціатор | Створює сесію, генерує QR для запрошення | `initiator` |
| Joiner | Приєднується за QR або ID сесії | `joiner` |
| Relay-сервер | Сліпий ретранслятор зашифрованих пакетів | zero-trust relay |

Після завершення верифікації ролі симетричні — будь-хто може відправляти файли.

### 1.3 Модель загроз (Threat Model)

| Загроза | Захист |
|---------|--------|
| Компрометований relay-сервер | E2EE: сервер ніколи не отримує ключ |
| MITM між клієнтом і сервером | TLS 1.3 + QR-верифікація fingerprint |
| MITM на рівні ключового обміну | QR-верифікація публічних ключів |
| Replay-атака | Per-session nonce tracking |
| DDoS / abuse | Rate limiting, session TTL, chunk count limit |
| Перехоплення трафіку | AES-256-GCM з аутентифікацією |
| Компрометація пристрою | Vault ключ у localStorage (sandbox) |

---

## 2. Криптографічний протокол

### 2.1 Генерація ключової пари

```
generateKeyPair()  →  { privateKey, publicKey }

Алгоритм: ECDH P-256 (secp256r1)
Extractable: true (для exportKey)
Key usages: ['deriveKey', 'deriveBits']
```

Кожна сесія генерує нову ключову пару. Ключ ніколи не зберігається між сесіями.

### 2.2 Fingerprint публічного ключа

```
exportKey('spki', publicKey)  →  spkiBuffer  (91 байт)
SHA-256(spkiBuffer)           →  fingerprint  (32 байти = 64 hex символи)
```

Fingerprint використовується для QR-верифікації та відображення у UI. Constant-time порівняння захищає від timing-attack.

### 2.3 Деривація спільного ключа

```
Крок 1: ECDH
  sharedBits = deriveBits({ name: 'ECDH', public: partnerPublicKey }, privateKey, 256)
  → 32 байти raw shared secret

Крок 2: HKDF-SHA256
  ikm   = importKey('raw', sharedBits, 'HKDF', false, ['deriveKey'])
  salt  = TextEncoder.encode(sessionId)   ← унікалізує ключ per-сесія
  info  = TextEncoder.encode('sft-v1-aes-gcm')
  aesKey = deriveKey(HKDF, ikm, salt, info, 'SHA-256', AES-GCM-256)
  → AES-256-GCM CryptoKey (non-extractable)
```

**Властивість:** Обидва учасники незалежно обчислюють однаковий `aesKey` без передачі його по мережі. Сервер не має жодного з проміжних значень.

### 2.4 Шифрування файлу

```
nonce    = crypto.getRandomValues(Uint8Array[12])  ← CSPRNG, 96 біт
ciphertext || authTag = AES-GCM-256.encrypt(aesKey, nonce, plaintext)

Параметри:
  tagLength: 128 біт (GCM auth tag)
  iv:        nonce (96 біт, унікальний per-файл)
```

Web Crypto API конкатенує `ciphertext || authTag` в один буфер. При розшифруванні автоматично перевіряє цілісність — `OperationError` якщо tag не збіглась.

### 2.5 Передача по мережі

```
plaintext (ArrayBuffer)
    ↓ encryptFile()
ciphertext (Uint8Array, довжина = plaintext + 16 байт authTag)
    ↓ splitIntoChunks(256 КБ)
chunks[0..N] (Uint8Array[])
    ↓ arrayBufferToBase64()
chunks_b64[0..N] (string[])
    ↓ WS → relay → WS
    ↓ base64ToArrayBuffer()
    ↓ assembleChunks()
ciphertext_reassembled
    ↓ decryptFile()
plaintext_restored
```

### 2.6 QR-верифікація (захист від MITM)

```
Ініціатор показує:   QR(fingerprintA)  →  Joiner сканує   →  perifyFingerprint(scanned, expectedA)
Joiner показує:      QR(fingerprintB)  →  Ініціатор сканує →  verifyFingerprint(scanned, expectedB)

verifyFingerprint(a, b):
  constant-time XOR порівняння (захист від timing-attack)
  return diff === 0
```

Якщо обидва підтвердили → сервер надсилає `BOTH_VERIFIED` → дозволена передача файлів.

**Чому QR не можна підробити:** Fingerprint — SHA-256 від SPKI публічного ключа. Підмінити fingerprint на QR-коді означає підмінити публічний ключ, що унеможливить подальше шифрування.

---

## 3. Серверна частина

### 3.1 Стек технологій

| Компонент | Технологія | Версія |
|-----------|-----------|--------|
| Web framework | FastAPI | 0.110+ |
| ASGI server | Uvicorn | 0.29+ |
| Валідація даних | Pydantic v2 | 2.7+ |
| Конфігурація | pydantic-settings | 2.2+ |
| QR генерація | qrcode[pil] | 7.4+ |
| Python | CPython | 3.11+ |

### 3.2 Модуль `session_manager.py`

**SessionData** — датаклас з повним станом однієї сесії:

```python
@dataclass
class SessionData:
    session_id: str          # CSPRNG 128-bit hex
    token: str               # CSPRNG 256-bit hex (резерв)
    state: SessionState      # CREATED → CONNECTED → KEYS_EXCHANGED → VERIFIED → TRANSFERRING
    initiator_ws: WebSocket  # може бути None (відключений)
    joiner_ws: WebSocket
    initiator_pubkey: str    # Base64 SPKI (зберігається для key replay)
    joiner_pubkey: str
    initiator_fingerprint: str
    joiner_fingerprint: str
    initiator_verified: bool
    joiner_verified: bool
    seen_nonces: set         # захист від replay
    current_file_metadata: dict
```

**Lifecycle сесії:**

```
create_session()
    → SessionData (state=CREATED, TTL=10хв)

join_session(role, ws)
    → якщо existing_ws: reconnect (скасовує grace timer)
    → both_connected → state=CONNECTED, TTL=30хв

disconnect(role)
    → asyncio.create_task(_delayed_disconnect_notify, delay=10s)
    → якщо reconnect відбувся за 10s → task скасовується, партнер не повідомляється
    → інакше → PARTNER_DISCONNECTED до партнера

close_session(reason)
    → SESSION_CLOSE до обох
    → clear_sensitive_data()
    → del _sessions[session_id]
```

**Key Replay механізм** (виправлено в v4):

При підключенні нового учасника сервер перевіряє чи партнер вже надіслав ключ раніше (до підключення цього учасника). Якщо так — негайно ретранслює збережений ключ. Це вирішує класичну race condition "initiator sent key before joiner connected".

### 3.3 Модуль `rate_limiter.py`

Алгоритм: **Sliding Window Counter**

```python
RateLimiter(max_requests, window_seconds)

is_allowed(ip):
    entry.cleanup(window_seconds)   # видаляємо старі timestamps
    if entry.count >= max_requests:
        return False
    entry.add()                     # додаємо поточний timestamp
    return True
```

Значення беруться з конфігурації:
- HTTP: `SFT_HTTP_RATE_LIMIT` req/s (default: 10)
- WS: `SFT_WS_CONNECT_RATE_LIMIT` connections/хв (default: 5)

Глобальне очищення застарілих IP-записів кожні 60 секунд.

### 3.4 Модуль `middleware.py`

```python
class SecurityHeadersMiddleware:
    SECURITY_HEADERS = {
        "Content-Security-Policy": "default-src 'self'; ...",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy": "camera=(self), microphone=()",
        "X-Permitted-Cross-Domain-Policies": "none",
    }
    # HSTS виставляється ЛИШЕ для HTTPS
    if request.url.scheme == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
```

### 3.5 Діаграма стану сесії (сервер)

```
              POST /api/sessions
                      │
                  [CREATED]
                  TTL: 10 хв
                      │
          initiator + joiner connected
                      │
               [CONNECTED]
               TTL: 30 хв
                      │
          both KEY_EXCHANGE received
                      │
           [KEYS_EXCHANGED]
                      │
          both VERIFICATION_STATUS(true)
                      │
              [VERIFIED]
                      │
           FILE_METADATA received
                      │
            [TRANSFERRING]
                      │
           FILE_ACK(success=true)
                      │
              [VERIFIED]           ← готово до наступного файлу
                      │
           SESSION_CLOSE / TTL
                      │
               [CLOSED]
```

---

## 4. Клієнтська частина

### 4.1 Стан машини (`app.js`)

```javascript
const State = {
    IDLE, CREATING, WAITING_PARTNER,
    KEYS_EXCHANGED, VERIFYING, VERIFIED,
    TRANSFERRING, RECEIVING, COMPLETED, ERROR
}
```

**Переходи стану:**

```
IDLE
 └── [btn-create] → CREATING → WAITING_PARTNER
 └── [btn-join / QR scan] → CREATING → WAITING_PARTNER

WAITING_PARTNER
 └── [KEY_RELAY received] → KEYS_EXCHANGED

KEYS_EXCHANGED
 └── [QR scan success] → VERIFYING → KEYS_EXCHANGED (якщо партнер не підтвердив)
 └── [BOTH_VERIFIED] → VERIFIED

VERIFIED
 └── [file selected] → TRANSFERRING → COMPLETED
 └── [FILE_METADATA received] → RECEIVING → COMPLETED

COMPLETED / ERROR → [new session] → IDLE
```

### 4.2 Модуль `crypto.js`

Повністю базується на **Web Crypto API** (`window.crypto.subtle`). Зовнішні криптографічні бібліотеки не використовуються.

```javascript
CryptoModule = {
    generateKeyPair()          → Promise<{privateKey, publicKey}>
    exportPublicKey(pk)        → Promise<string>   // Base64 SPKI
    computeFingerprint(pk)     → Promise<string>   // 64 hex
    importPartnerKey(b64)      → Promise<CryptoKey>
    deriveSharedKey(priv, pub, sessionId) → Promise<CryptoKey>  // AES-256-GCM
    encryptFile(key, buffer)   → Promise<{nonce, ciphertext}>
    decryptFile(key, nonce, ct) → Promise<ArrayBuffer>
    sha256Hex(buffer)          → Promise<string>
    splitIntoChunks(uint8Array) → Uint8Array[]     // 256 КБ кожен
    arrayBufferToBase64(buf)   → string
    base64ToArrayBuffer(b64)   → ArrayBuffer
}
```

### 4.3 Модуль `websocket.js`

```javascript
WSClient = {
    connect(sessionId, role)   // створює WS, скасовує попередній reconnect timer
    disconnect(reason)         // intentionalClose=true, скасовує timer, закриває WS
    send(data)                 → bool  // false якщо WS не відкритий
    sendKeyExchange(pubKey, fingerprint)
    sendVerificationStatus(verified)
    sendFile(metadata, chunks, authTag, sha256, onProgress)  // кидає Error якщо send() → false
    sendFileAck(success, errorCode)
    on(messageType, callback)  // реєстрація обробника
    isConnected()              → bool
}
```

**Reconnect стратегія:**

```
Затримка = min(800ms × 1.5^attempt, 5000ms)

attempt 0: 800ms
attempt 1: 1200ms
attempt 2: 1800ms
attempt 3: 2700ms
attempt 4: 4050ms
attempt 5-10: 5000ms (cap)
```

`reconnectTimer` зберігається і скасовується при `connect()` або `disconnect()`, щоб уникнути дублікату WS після reset стану.

**Keepalive:** PING кожні 20 секунд → сервер ігнорує мовчки.

**FILE_ACK timeout:** Якщо партнер не відповів за 30 секунд після `sendFile()` — показується попередження і UI повертається до стану VERIFIED.

### 4.4 Модуль `qr.js`

```javascript
QRModule = {
    generateQR(data, container, options)  // QRCode.js → canvas/img
    startScanning(video, canvas)          // → Promise<string> (scanned data)
    stopScanning()                        // зупиняє камеру + rAF
    verifyFingerprint(scanned, expected)  // constant-time XOR
    formatFingerprint(fp)                 // "abcd1234 ef567890 ..."
    isCameraSupported()                   → bool
}
```

**Scanning loop:**

```javascript
requestAnimationFrame(scanFrame)
  if (videoElement.readyState === HAVE_ENOUGH_DATA)
    ctx.drawImage(video)
    imageData = ctx.getImageData()
    code = jsQR(imageData.data, width, height)
    if (code) → resolve(code.data)
```

Перевірка `typeof jsQR === 'undefined'` відбувається **до** відкриття камери — якщо бібліотека не завантажена, кидається Error одразу (раніше UI зависав).

### 4.5 Модуль `file-handler.js`

```javascript
FileHandler = {
    readFile(file, onProgress)          → Promise<ArrayBuffer>
    downloadFile(data, filename, mime)  // Blob URL → <a>.click()
    createChunkCollector(totalChunks, onProgress) → {
        addChunk(index, data),   // idempotent: дубль не рахується двічі
        getResult(),             → Uint8Array | null
        get isComplete()         → bool
        get receivedCount()      → int
    }
    formatFileSize(bytes)       → string  // "1.5 МБ"
    validateFile(file, maxSize) → {valid, error}
}
```

### 4.6 Модуль `config.js`

Визначає URL сервера залежно від середовища:

```javascript
// Браузер (PWA): той самий origin
getServerUrl() → window.location.origin

// Capacitor (Android/iOS): зовнішній URL з localStorage або DEFAULT_SERVER_URL
getServerUrl() → localStorage.getItem('sft_server_url') || DEFAULT_SERVER_URL

getWsUrl(sessionId, role):
    protocol = base.startsWith('https') ? 'wss:' : 'ws:'
    return `${protocol}//${host}/ws/${sessionId}/${role}`
```

### 4.7 Модуль `native-bridge.js`

Мост між Web API та Capacitor плагінами:

```javascript
NativeBridge = {
    init()              // StatusBar, SplashScreen, back button
    saveFile(data, filename, mime)  // Capacitor Filesystem або Blob download
    shareUrl(title, url)            // navigator.share або clipboard
    copyToClipboard(text)
    hapticSuccess()     // Haptics.notification('SUCCESS')
    hapticError()       // Haptics.notification('ERROR')
    isNative()          → bool
}
```

Base64 конвертація для `saveFile` використовує блоковий підхід (8 КБ блоки) замість O(n²) string concatenation — критично для файлів 10+ МБ.

---

## 5. Захищене сховище

### 5.1 Архітектура Vault

```
VaultModule (vault.js)
    │
    ├── IndexedDB: 'sft_vault_v1'
    │     └── objectStore: 'files'
    │           ├── index: 'by_time' (timestamp)
    │           └── records: {id, filename, contentType, originalSize,
    │                         direction, sessionId, timestamp, nonce, data}
    │
    └── localStorage: 'sft_vk'  ← Base64(AES-256-GCM raw key)
```

### 5.2 Шифрування записів

```javascript
saveFile(data, filename, ...):
    nonce     = crypto.getRandomValues(Uint8Array[12])  // унікальний per-файл
    encrypted = AES-GCM-256.encrypt(_key, nonce, ab)
    IDB.add({ ..., nonce: nonce.buffer, data: encrypted })

openFile(id):
    entry = IDB.get(id)
    plain = AES-GCM-256.decrypt(_key, entry.nonce, entry.data)
    return { data: plain, filename, contentType }
```

### 5.3 Управління ключем Vault

При першому запуску:
```
generateKey(AES-GCM-256, extractable=true) → vaultKey
exportKey('raw', vaultKey) → rawBytes
localStorage.setItem('sft_vk', Base64(rawBytes))
```

При наступних запусках:
```
raw = localStorage.getItem('sft_vk')
importKey('raw', Base64.decode(raw), AES-GCM, extractable=false) → _key
```

**Примітка щодо безпеки:** Ключ сховища зберігається в `localStorage` — прийнятно для sandbox-середовища браузера/WebView, де іншим вкладкам/додаткам немає доступу. В Android Capacitor WebView ізольований від інших застосунків на рівні ОС.

### 5.4 Публічний API

```javascript
VaultModule.init()                           // → Promise (ініціалізація DB + key)
VaultModule.saveFile(data, name, mime, dir, sid)  // direction: 'sent'|'received'
VaultModule.openFile(id)                     // → { data, filename, contentType }
VaultModule.listFiles()                      // → [{id, filename, originalSize, ...}]
VaultModule.deleteFile(id)
VaultModule.getStats()                       // → { count, totalSize }
```

---

## 6. Android-застосунок (Capacitor)

### 6.1 Конфігурація Capacitor

```json
// capacitor.config.json
{
    "appId": "com.securedrop.app",
    "appName": "SecureDrop",
    "webDir": "static",
    "plugins": {
        "SplashScreen": { "launchShowDuration": 0 }
    }
}
```

### 6.2 Дозволи Android

```xml
<!-- AndroidManifest.xml -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE"
    android:maxSdkVersion="29" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"
    android:maxSdkVersion="32" />
<uses-feature android:name="android.hardware.camera"
    android:required="false" />
```

### 6.3 Міст дозволів камери

`MainActivity.java` містить `WebChromeClient.onPermissionRequest` — перенаправляє запит камери з JS `getUserMedia()` до Android runtime permission dialog:

```java
@Override
public void onPermissionRequest(PermissionRequest request) {
    request.grant(request.getResources());
}
```

### 6.4 Синхронізація assets

```bash
npx cap sync android
# копіює static/ → android/app/src/main/assets/public/
```

Після кожної зміни JS/CSS файлів потрібно виконати sync і перезібрати APK.

---

## 7. Протокол WebSocket

### 7.1 Формат повідомлень

Всі повідомлення — JSON об'єкти з обов'язковим полем `type: string`.

### 7.2 Повна діаграма послідовності

```
Initiator WS              Relay Server              Joiner WS
     │                         │                        │
     │── KEY_EXCHANGE ─────────►│                        │
     │   {pub_key, fingerprint} │  stored: initiator_pubkey
     │                         │                        │
     │                         │◄── connect (WS) ───────│
     │                         │◄── KEY_EXCHANGE ────────│
     │                         │    {pub_key, fingerprint}
     │◄── SESSION_READY ────────│──── SESSION_READY ─────►│
     │◄── KEY_RELAY(joiner) ────│                        │
     │   (replayed from store)  │──── KEY_RELAY(initiator)►│
     │                         │    (replayed from store) │
     │                         │                        │
     │  [ECDH → HKDF → AES key]│          [ECDH → HKDF → AES key]
     │                         │                        │
     │── VERIFICATION_STATUS ──►│──── VERIFICATION_STATUS►│
     │   {verified: true}       │    {verified: true}    │
     │◄── BOTH_VERIFIED ────────│──── BOTH_VERIFIED ─────►│
     │                         │                        │
     │── FILE_METADATA ─────────►│──── FILE_METADATA ─────►│
     │── FILE_CHUNK[0] ─────────►│──── FILE_CHUNK[0] ──────►│
     │── FILE_CHUNK[1..N] ──────►│──── FILE_CHUNK[1..N] ───►│
     │── FILE_COMPLETE ─────────►│──── FILE_COMPLETE ──────►│
     │◄── FILE_ACK(success) ─────│◄─── FILE_ACK(success) ──│
```

### 7.3 Коди помилок

| Код | Опис |
|-----|------|
| `SESSION_NOT_FOUND` | Сесія не існує або TTL вичерпано |
| `KEY_NOT_EXCHANGED` | Спроба відправити файл до обміну ключами |
| `VERIFICATION_REQUIRED` | Спроба відправити файл до верифікації |
| `PAYLOAD_TOO_LARGE` | Файл > 100 МБ або chunk > ліміт |
| `INVALID_NONCE` | Nonce вже використовувався (replay) |
| `INVALID_MESSAGE` | Некоректний формат або невідомий тип |
| `INVALID_STATE` | Дія не дозволена у поточному стані |
| `RATE_LIMITED` | Перевищено ліміт запитів |
| `INTERNAL_ERROR` | Внутрішня помилка сервера |

---

## 8. Безпека та аналіз загроз

### 8.1 Аналіз компонентів (проведений аудит)

Під час розробки проведено вертикальний та горизонтальний аналіз коду. Знайдено та виправлено 11 проблем:

| # | Серйозність | Компонент | Проблема | Статус |
|---|-------------|-----------|----------|--------|
| 1 | Критична | `rate_limiter.py` | Налаштування `config.py` ігнорувались, захардкоджені значення | Виправлено |
| 2 | Критична | `main.py` | `chunk_count` без верхньої межі — OOM вектор | Виправлено |
| 3 | Критична | `session_manager.py` | Гонка в `finally` — `pop()` видаляв нову задачу reconnect | Виправлено |
| 4 | Критична | `websocket.js` | Pending `setTimeout` від старої сесії дублював WS | Виправлено |
| 5 | Критична | `websocket.js` | `sendFile` не перевіряв `send()` → UI зависав без ACK | Виправлено |
| 6 | Середня | `main.py` | Fingerprint перевірявся лише на довжину, не на hex | Виправлено |
| 7 | Середня | `qr.js` | Якщо jsQR не завантажено — Promise ніколи не resolve | Виправлено |
| 8 | Середня | `vault.js` | `data.buffer` на зрізаному `Uint8Array` → зайві байти | Виправлено |
| 9 | Середня | `middleware.py` | HSTS виставлявся на HTTP-запитах | Виправлено |
| 10 | Низька | `session_manager.py` | Grace period = max reconnect delay → race | Збільшено до 10s |
| 11 | Низька | `native-bridge.js` | O(n²) base64 → зависання на великих файлах | Виправлено |

### 8.2 Security Headers

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline';
    style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
    font-src 'self' https://fonts.gstatic.com;
    img-src 'self' data: blob:;
    connect-src 'self' ws: wss:;
    media-src 'self' blob:;
    worker-src 'self' blob:;
    frame-ancestors 'none'

Strict-Transport-Security: max-age=31536000; includeSubDomains  (HTTPS only)
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(self), microphone=()
X-Permitted-Cross-Domain-Policies: none
```

### 8.3 Захист від конкретних атак

**Replay attack:**
- Сервер зберігає всі `nonce` використані в сесії (`seen_nonces: set`)
- Повторний FILE_METADATA з тим самим nonce → `INVALID_NONCE` error

**OOM (Out of Memory):**
- `chunk_count` обмежений: `max = ceil(100MB / 256KB) = 401`
- Перевіряється до ретрансляції партнеру

**MITM:**
- Фізична QR-верифікація — підробити неможливо без доступу до обох екранів

**Session hijacking:**
- Session ID — 128 біт CSPRNG (32 hex символи)
- Ймовірність вгадати: 1/2^128

---

## 9. Стійкість з'єднання

### 9.1 Проблеми мобільного середовища

На мобільних пристроях (особливо Android) WS з'єднання може обриватись через:
- Фонування застосунку при копіюванні/шерінгу посилання
- Перемикання між застосунками під час верифікації
- Sleep режим, зміна мережі (WiFi → LTE)

### 9.2 Тришарова система відновлення

```
Шар 1: Клієнтський keepalive
    PING → сервер (кожні 20 секунд)
    → утримує WS alive через NAT/firewall/proxy

Шар 2: Клієнтський reconnect
    При onclose → setTimeout(_createConnection, delay)
    delay = min(800ms × 1.5^attempt, 5000ms)
    max 10 спроб
    reconnectTimer зберігається → cancelable при connect()/disconnect()

Шар 3: Серверна grace period
    disconnect(role) → create_task(_delayed_disconnect_notify, delay=10s)
    якщо join_session() викликано за 10s → task.cancel()
    партнер НЕ отримує PARTNER_DISCONNECTED
    якщо reconnect не відбувся → партнер отримує PARTNER_DISCONNECTED
```

### 9.3 Key Replay при reconnect

Якщо ініціатор відключається після обміну ключами і reconnect-ується:
1. Сервер зберігає `initiator_pubkey` в `SessionData`
2. При reconnect → `join_session()` → перевірка `joiner_pubkey is not None`
3. Якщо joiner вже надіслав ключ → негайно надсилається `KEY_RELAY(joiner)` ініціатору
4. Обидва залишаються синхронізованими без повторного обміну ключами

---

## 10. Тестування

### 10.1 Тестове покриття

**Файл:** `tests/test_server.py` — 42 тести

| Клас тестів | Охоплення |
|-------------|-----------|
| `TestSessionManager` | CRUD сесій, TTL, reconnect, grace period |
| `TestRateLimiter` | HTTP та WS ліміти, sliding window |
| `TestCryptoUtils` | session_id, token, fingerprint, QR |
| `TestHTTPAPI` | POST /api/sessions, GET status, GET health |
| `TestWebSocketProtocol` | KEY_EXCHANGE, VERIFICATION, FILE_* flow |
| `TestErrorHandling` | Invalid messages, wrong state, unknown type |
| `TestMessageTypes` | Всі 15 типів повідомлень |

### 10.2 Запуск тестів

```bash
# Всі тести
pytest tests/ -v

# З покриттям
pytest tests/ -v --cov=server --cov-report=html

# Конкретний модуль
pytest tests/test_server.py::TestWebSocketProtocol -v

# Fail fast
pytest tests/ -x
```

---

## 11. Розгортання

### 11.1 Render.com (рекомендовано)

```yaml
# render.yaml
services:
  - type: web
    name: secure-file-relay
    runtime: python
    buildCommand: pip install -r requirements.txt
    startCommand: uvicorn server.main:app --host 0.0.0.0 --port $PORT
    envVars:
      - key: SFT_CORS_ORIGINS
        value: '["https://your-domain.com"]'
```

### 11.2 Docker

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### 11.3 Env vars (production)

```bash
SFT_CORS_ORIGINS='["https://your-domain.com"]'   # обмежити CORS
SFT_LOG_LEVEL=WARNING                              # менше шуму
SFT_MAX_SESSIONS=500                               # під ресурси хосту
SFT_SESSION_TTL_SECONDS=3600                       # 1 година якщо треба довше
```

### 11.4 Nginx (reverse proxy)

```nginx
location /ws/ {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600;
}
```

---

## 12. Відомі обмеження

| Обмеження | Причина | Можливе рішення |
|-----------|---------|----------------|
| Макс. 100 МБ на файл | WS буфер, RAM мобільного | Chunked streaming з розшифруванням на льоту |
| Ключ Vault у localStorage | Немає кращого API в браузері | WebAuthn / device-bound credentials (майбутнє) |
| CORS `["*"]` за замовч. | Зручність розробки | Обмежити через `SFT_CORS_ORIGINS` в production |
| `unsafe-inline` в CSP | Inline стилі/скрипти | Nonce-based CSP або окремі файли |
| 1 файл за раз | Спрощений дизайн | Черга файлів |
| Session ID в URL | UX зручність | Видалення з history після join |
| execCommand (deprecated) | Clipboard fallback для старих браузерів | navigator.clipboard universally |

---

*Останнє оновлення: 2026-04-30*  
*Версія застосунку: 4.0*  
*Версія протоколу: sft-v1*
