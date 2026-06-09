# SecureDrop — Захищений обмін файлами з E2EE

> Мобільний застосунок та PWA для безпечної peer-to-peer передачі файлів між двома пристроями.  
> Наскрізне шифрування AES-256-GCM, обмін ключами ECDH P-256, QR-верифікація захисту від MITM.

---

## Огляд

**SecureDrop** вирішує задачу безпечної передачі конфіденційних файлів між двома пристроями без довіри до будь-якого посередника. Relay-сервер виконує лише функцію «сліпого» ретранслятора зашифрованих blob-ів — він **ніколи не має доступу** до ключів, відкритого тексту або метаданих вмісту.

### Ключові властивості

| Властивість | Реалізація |
|-------------|-----------|
| Наскрізне шифрування | AES-256-GCM, ключ ніколи не залишає пристрій |
| Обмін ключами | ECDH P-256 + HKDF-SHA256 (RFC 5869) |
| Захист від MITM | QR-верифікація fingerprint публічних ключів |
| Zero-trust relay | Сервер не розшифровує, не логує вміст |
| Offline-перший | PWA + Service Worker, Android нативний APK |
| Захищене сховище | Vault на IndexedDB, зашифрований AES-256-GCM |
| Стабільність з'єднання | WS keepalive PING/5s grace period/10 reconnect-спроб |

---

## Архітектура

```
┌───────────────────────────────────────────────────────────────┐
│                        КЛІЄНТ A                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐  │
│  │ crypto.js│  │  qr.js   │  │ vault.js │  │ websocket.js│  │
│  │ ECDH     │  │ QRCode   │  │ IndexedDB│  │ WSClient    │  │
│  │ HKDF     │  │ jsQR     │  │ AES-GCM  │  │ reconnect   │  │
│  │ AES-GCM  │  │ camera   │  │ keys     │  │ ping        │  │
│  └──────────┘  └──────────┘  └──────────┘  └─────────────┘  │
│                      app.js (State Machine)                   │
└───────────────────────────┬───────────────────────────────────┘
                            │ WSS / TLS 1.3
                            │ (зашифровані blob)
                ┌───────────▼──────────┐
                │    RELAY SERVER      │
                │    (FastAPI)         │
                │                     │
                │  session_manager.py  │
                │  • SessionData       │
                │  • TTL / cleanup     │
                │  • grace period      │
                │  • key replay        │
                │                     │
                │  rate_limiter.py     │
                │  middleware.py       │
                └───────────┬──────────┘
                            │ WSS / TLS 1.3
                            │ (зашифровані blob)
┌───────────────────────────▼───────────────────────────────────┐
│                        КЛІЄНТ Б                               │
│  (симетрична архітектура)                                     │
└───────────────────────────────────────────────────────────────┘
```

### Протокол обміну (5 фаз)

```
Клієнт A (ініціатор)          Relay-сервер           Клієнт Б (joiner)
       │                           │                        │
       │── POST /api/sessions ────►│                        │
       │◄── session_id, join_url ──│                        │
       │                           │                        │
  [1. ПІДКЛЮЧЕННЯ]                 │                        │
       │── WS /ws/{id}/initiator ─►│                        │
       │── KEY_EXCHANGE ──────────►│                        │
       │   {pub_key, fingerprint}  │◄─ WS /ws/{id}/joiner ─│
       │◄── SESSION_READY ─────────│──── SESSION_READY ────►│
       │◄── KEY_RELAY(B) ──────────│◄─── KEY_EXCHANGE ──────│
       │   (stored key replay)     │──── KEY_RELAY(A) ─────►│
       │                           │                        │
  [2. ОБМІН КЛЮЧАМИ]               │                        │
       │  ECDH(privA, pubB) → sharedBits                    │
       │  HKDF(sharedBits, sessionId) → AES-256-GCM key     │
       │                           │                        │
  [3. QR-ВЕРИФІКАЦІЯ]              │                        │
       │── VERIFICATION_STATUS ───►│──── VERIFICATION_STATUS►│
       │◄── BOTH_VERIFIED ─────────│──── BOTH_VERIFIED ────►│
       │                           │                        │
  [4. ПЕРЕДАЧА ФАЙЛУ]              │                        │
       │  encrypt(file, key)       │                        │
       │── FILE_METADATA ─────────►│──── FILE_METADATA ────►│
       │── FILE_CHUNK × N ────────►│──── FILE_CHUNK × N ───►│
       │── FILE_COMPLETE ─────────►│──── FILE_COMPLETE ────►│
       │◄── FILE_ACK ──────────────│◄─── FILE_ACK ──────────│
       │                           │                        │
  [5. VAULT]                       │                        │
       │  vault.saveFile(          │                        │
       │    encrypt(file, vaultKey)│                        │
       │  ) → IndexedDB            │                        │
```

---

## Структура проєкту

```
secure-file/
├── server/                        # Relay-сервер (Python 3.11+)
│   ├── main.py                    # FastAPI: HTTP API + WebSocket handler
│   ├── session_manager.py         # Lifecycle сесій, grace period, key replay
│   ├── models.py                  # Pydantic-схеми 15 типів повідомлень
│   ├── crypto_utils.py            # CSPRNG session_id, fingerprint, QR PNG
│   ├── rate_limiter.py            # Sliding window rate limiter (HTTP + WS)
│   ├── config.py                  # pydantic-settings + env vars (SFT_*)
│   └── middleware.py              # Security headers, HSTS (HTTPS-only)
│
├── static/                        # Клієнт (PWA + Capacitor webDir)
│   ├── index.html                 # Single-page app shell
│   ├── manifest.json              # PWA manifest
│   ├── sw.js                      # Service Worker (offline)
│   └── js/
│       ├── app.js                 # State machine, UI, orchestration
│       ├── crypto.js              # Web Crypto API: ECDH, HKDF, AES-GCM
│       ├── websocket.js           # WSClient: reconnect, ping, sendFile
│       ├── qr.js                  # QR генерація + jsQR сканування
│       ├── vault.js               # Vault: IndexedDB + AES-256-GCM
│       ├── file-handler.js        # FileReader, chunk collector, download
│       ├── native-bridge.js       # Capacitor: filesystem, haptic, share
│       ├── config.js              # URL resolver (web vs native)
│       └── vendor/
│           ├── qrcode.min.js      # QR генерація (local copy)
│           └── jsQR.js            # QR сканування (local copy)
│
├── tests/
│   └── test_server.py             # 42 unit/integration тести (pytest)
│
├── android/                       # Capacitor Android project
│   └── app/src/main/
│       ├── java/.../MainActivity.java   # WebView + camera permission bridge
│       └── assets/public/              # Синхронізована копія static/
│
├── docker/                        # Docker + Nginx конфігурація
├── capacitor.config.json          # Capacitor (webDir, appId, plugins)
├── requirements.txt               # Python залежності
├── Dockerfile                     # Для хмарного деплою
├── Procfile                       # Railway / Heroku
├── render.yaml                    # Render.com (one-click deploy)
├── run.py                         # Точка входу dev-сервера
├── pyproject.toml                 # pytest, black, ruff конфігурація
├── ARCHITECTURE.md                # Детальна технічна архітектура
├── DEPLOY.md                      # Деплой relay + збірка APK
├── UPDATE_GUIDE.md                # Оновлення та тестування
└── USER_GUIDE.md                  # Керівництво користувача
```

---

## Криптографічний стек

| Компонент | Алгоритм | Стандарт | Реалізація |
|-----------|----------|----------|-----------|
| Обмін ключами | ECDH P-256 | RFC 6090 | Web Crypto API |
| Деривація ключів | HKDF-SHA256 | RFC 5869 | Web Crypto API |
| Шифрування файлів | AES-256-GCM | NIST SP 800-38D | Web Crypto API |
| Шифрування vault | AES-256-GCM | NIST SP 800-38D | Web Crypto API |
| Fingerprint | SHA-256 | FIPS 180-4 | Web Crypto API |
| Session ID | CSPRNG 128 bit | — | `secrets.token_hex(16)` |
| Транспорт | TLS 1.3 | RFC 8446 | WSS (nginx/uvicorn) |

**Деривація спільного ключа:**
```
sharedBits = ECDH(privA, pubB)          # 256 біт
ikm = importKey(sharedBits, 'HKDF')
aesKey = HKDF(ikm, salt=sessionId, info='sft-v1-aes-gcm', hash='SHA-256', length=256)
```

---

## HTTP API

| Метод | Шлях | Опис | Відповідь |
|-------|------|------|-----------|
| `POST` | `/api/sessions` | Створення нової сесії | `{session_id, join_url, qr_data, created_at}` |
| `GET` | `/api/sessions/{id}/status` | Стан сесії | `{state, initiator_connected, joiner_connected, …}` |
| `GET` | `/api/health` | Health check | `{status, active_sessions, version}` |
| `GET` | `/join/{session_id}` | Redirect для QR-посилання | `index.html` |
| `GET` | `/` | Головна сторінка | `index.html` |

---

## WebSocket протокол

**Endpoint:** `WSS /ws/{session_id}/{initiator|joiner}`

### Повідомлення від клієнта до сервера

| Тип | Поля | Опис |
|-----|------|------|
| `KEY_EXCHANGE` | `public_key`, `fingerprint`, `key_algorithm` | Публічний ключ ECDH |
| `VERIFICATION_STATUS` | `verified: bool` | Результат QR-верифікації |
| `FILE_METADATA` | `filename`, `original_size`, `chunk_count`, `nonce`, `content_type` | Метадані файлу |
| `FILE_CHUNK` | `chunk_index`, `total_chunks`, `data` | Зашифрований фрагмент (Base64) |
| `FILE_COMPLETE` | `auth_tag`, `sha256_plaintext` | Завершення передачі |
| `FILE_ACK` | `success: bool`, `error_code?` | Підтвердження розшифрування |
| `SESSION_CLOSE` | `reason` | Закриття сесії |
| `PING` | — | Keepalive (ігнорується сервером) |

### Повідомлення від сервера до клієнта

| Тип | Опис |
|-----|------|
| `SESSION_READY` | Обидва учасники підключені |
| `PARTNER_CONNECTED` | Партнер приєднався |
| `PARTNER_DISCONNECTED` | Партнер відключився (після 10s grace period) |
| `KEY_RELAY` | Ретрансляція ключа партнера |
| `BOTH_VERIFIED` | Обидва підтвердили ключі |
| `ERROR` | Помилка (`error_code`, `message`, `fatal`) |
| `SESSION_CLOSE` | Сесія закрита |

---

## Конфігурація сервера (змінні середовища)

| Змінна | За замовч. | Опис |
|--------|-----------|------|
| `SFT_HOST` | `0.0.0.0` | Адреса прослуховування |
| `SFT_PORT` | `8000` | Порт |
| `SFT_SESSION_TTL_SECONDS` | `1800` | TTL активної сесії (30 хв) |
| `SFT_SESSION_TTL_WAITING` | `600` | TTL сесії без joiner (10 хв) |
| `SFT_MAX_SESSIONS` | `1000` | Ліміт одночасних сесій |
| `SFT_MAX_FILE_SIZE_BYTES` | `104857600` | Максимум файлу (100 МБ) |
| `SFT_MAX_CHUNK_SIZE_BYTES` | `358400` | Максимум chunk з Base64-overhead |
| `SFT_HTTP_RATE_LIMIT` | `10` | HTTP запитів/секунду з IP |
| `SFT_WS_CONNECT_RATE_LIMIT` | `5` | WS підключень/хвилину з IP |
| `SFT_CORS_ORIGINS` | `["*"]` | Дозволені CORS-джерела |
| `SFT_LOG_LEVEL` | `INFO` | Рівень логування |

---

## Швидкий старт

```bash
# 1. Залежності
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# 2. Запуск (dev)
python run.py
# → http://localhost:8000

# 3. Тести
pytest tests/ -v
# → 42 passed

# 4. Android APK
npm install
npx cap sync android
npx cap open android   # Build → Build APK
```

---

## Безпека

### HTTP Security Headers

| Заголовок | Значення |
|-----------|---------|
| `Content-Security-Policy` | `default-src 'self'`, script/style inline allowed |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (HTTPS only) |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `Permissions-Policy` | `camera=(self), microphone=()` |

### Захисні механізми

- **Replay protection**: Сервер відстежує nonce кожного файлу per-сесія
- **Rate limiting**: 10 HTTP req/s та 5 WS connections/хв per IP (sliding window)
- **Session TTL**: Автоматичне видалення прострочених сесій кожні 30 секунд
- **Zero-trust**: Сервер ніколи не зберігає і не інтерпретує вміст файлів
- **Chunk validation**: Максимум `ceil(100MB / 256KB) ≈ 401` фрагментів на файл

---

## Тести

```bash
pytest tests/ -v                          # 42 тести
pytest tests/ --cov=server                # З покриттям коду
pytest tests/test_server.py::TestCrypto   # Тільки крипто-тести
```

Охоплені модулі: `SessionManager`, `RateLimiter`, `CryptoUtils`, WebSocket protocol flow, HTTP API, error handling, reconnect scenarios.

---

## Платформи

| Платформа | Спосіб | Особливості |
|-----------|--------|-------------|
| Android | Capacitor APK | Нативна камера, файлова система, haptic |
| iOS | Capacitor (збірка XCode) | Аналогічно Android |
| Chrome / Edge | PWA (браузер) | Service Worker, Add to Home Screen |
| Firefox / Safari | PWA (браузер) | Без Service Worker push notifications |
| Десктоп | Браузер | Sidebar layout ≥ 900px, ручна верифікація |

---

## Ліцензія

MIT — відкритий вихідний код.

---

*Детальна технічна документація: [ARCHITECTURE.md](ARCHITECTURE.md)*  
*Керівництво користувача: [USER_GUIDE.md](USER_GUIDE.md)*  
*Деплой та збірка: [DEPLOY.md](DEPLOY.md)*
