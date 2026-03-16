# Secure File Transfer — Relay Server

Система захищеного обміну файлами між смартфонами з end-to-end шифруванням (AES-256-GCM) та перевіркою ключів через QR-коди.

## Архітектура

```
┌─────────────┐     WSS/TLS 1.3     ┌──────────────┐     WSS/TLS 1.3     ┌─────────────┐
│  Клієнт А   │◄───────────────────►│ Relay Server │◄───────────────────►│  Клієнт Б   │
│ (PWA/JS)    │  encrypted blobs    │  (FastAPI)   │  encrypted blobs    │ (PWA/JS)    │
│             │                     │  zero-trust  │                     │             │
│ Web Crypto  │                     │  NO keys     │                     │ Web Crypto  │
│ API         │                     │  NO plaintext│                     │ API         │
└─────────────┘                     └──────────────┘                     └─────────────┘
```

**Zero-trust relay**: сервер бачить лише зашифровані blob-дані. Ключі шифрування генеруються та зберігаються виключно на клієнтах.

## Криптографічний стек

| Компонент | Алгоритм | Специфікація |
|-----------|----------|--------------|
| Обмін ключами | ECDH (P-256 / X25519) | RFC 7748 |
| Деривація ключів | HKDF-SHA256 | RFC 5869 |
| Шифрування | AES-256-GCM | NIST SP 800-38D |
| Fingerprint | SHA-256 | FIPS 180-4 |
| Транспорт | TLS 1.3 | RFC 8446 |

## Структура проєкту

```
secure-file-transfer/
├── server/                  # Relay-сервер (Python/FastAPI)
│   ├── __init__.py
│   ├── main.py              # FastAPI app, WebSocket handler, HTTP API
│   ├── session_manager.py   # SessionManager: lifecycle сесій, TTL
│   ├── models.py            # Pydantic-схеми повідомлень
│   ├── crypto_utils.py      # SHA-256 fingerprint, CSPRNG, QR
│   ├── rate_limiter.py      # Rate limiting по IP
│   ├── config.py            # Конфігурація через pydantic-settings
│   └── middleware.py        # Security headers, CORS
├── static/                  # Клієнтська частина (PWA) — TODO
│   ├── js/
│   ├── css/
│   └── index.html
├── tests/                   # Тести
│   ├── __init__.py
│   ├── conftest.py
│   └── test_server.py       # 40+ unit/integration тестів
├── docker/                  # Docker-конфігурація
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── nginx/
│       └── nginx.conf
├── requirements.txt
├── pyproject.toml
├── run.py                   # Точка входу
├── .env.example
└── README.md
```

## Швидкий старт

### 1. Встановлення залежностей

```bash
python -m venv venv
source venv/bin/activate      # Linux/macOS
# venv\Scripts\activate       # Windows

pip install -r requirements.txt
```

### 2. Конфігурація

```bash
cp .env.example .env
# Відредагуйте .env за потреби
```

### 3. Запуск сервера

```bash
# Development
python run.py

# Або напряму через uvicorn
uvicorn server.main:app --host 0.0.0.0 --port 8000 --reload
```

Сервер доступний за адресою: `http://localhost:8000`

### 4. Тестування

```bash
# Всі тести
pytest tests/ -v

# З покриттям
pytest tests/ -v --cov=server --cov-report=term-missing

# Конкретний клас тестів
pytest tests/test_server.py::TestSessionManager -v
```

### 5. Docker (production)

```bash
cd docker

# Згенеруйте самопідписаний сертифікат для розробки:
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout nginx/certs/privkey.pem \
  -out nginx/certs/fullchain.pem \
  -subj "/CN=localhost"

docker compose up --build
```

## API Endpoints

### HTTP

| Метод | URL | Опис |
|-------|-----|------|
| `POST` | `/api/sessions` | Створення нової сесії |
| `GET` | `/api/sessions/{id}/status` | Статус сесії |
| `GET` | `/api/health` | Health check |

### WebSocket

| URL | Опис |
|-----|------|
| `/ws/{session_id}/initiator` | Підключення ініціатора |
| `/ws/{session_id}/joiner` | Підключення отримувача |

### Протокол повідомлень (WebSocket JSON)

Фази: Підключення → Обмін ключами → QR-верифікація → Передача файлу

Деталі — див. `server/models.py` та Додаток А звіту.

## Безпека

- **HTTP Security Headers**: CSP, HSTS, X-Frame-Options, X-Content-Type-Options
- **Rate Limiting**: 10 req/s HTTP, 5 WS/хв
- **TLS 1.3 only** з PFS cipher suites
- **Replay protection**: nonce tracking per session
- **Zero-trust**: сервер не має доступу до ключів або відкритого тексту

## Ліцензія

MIT — відкритий вихідний код.
