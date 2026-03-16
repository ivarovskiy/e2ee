# Деплой та збірка — від нуля до робочої апки на телефоні

## Загальна схема

```
   📱 Телефон A (APK)                        📱 Телефон Б (APK)
       │                                          │
       │  WSS (зашифровані blob)                   │
       └──────────── ☁️ Relay ─────────────────────┘
                  (Render.com)
                  НЕ бачить файли
```

Два етапи:
1. **Деплой relay-сервера** на Render.com (5 хвилин, безкоштовно)
2. **Збірка APK** через Android Studio і встановлення на телефон


---

## ЕТАП 1: Деплой relay-сервера на Render.com

### 1.1. Завантажити проект на GitHub

```bash
# Створити новий репозиторій на github.com, потім:
cd secure-file-transfer
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USER/secure-file-transfer.git
git push -u origin main
```

### 1.2. Деплой на Render

1. Зайти на **[render.com](https://render.com)** → зареєструватися (можна через GitHub)
2. Натиснути **New** → **Web Service**
3. Підключити GitHub-репозиторій `secure-file-transfer`
4. Render автоматично знайде `render.yaml` і заповнить налаштування:
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn server.main:app --host 0.0.0.0 --port $PORT`
5. Обрати план **Free**
6. Натиснути **Create Web Service**

### 1.3. Отримати URL

Через 2-3 хвилини сервер буде доступний за адресою типу:
```
https://secure-file-transfer-relay.onrender.com
```

Перевірити: відкрити у браузері:
```
https://secure-file-transfer-relay.onrender.com/api/health
```

Має відповісти: `{"status":"ok","active_sessions":0,"version":"1.0.0"}`

> ⚠️ Безкоштовний план Render «засинає» після 15 хв без активності.
> Перший запит після сну може йти 30-50 секунд. Для демонстрації це нормально.


---

## ЕТАП 2: Збірка Android APK

### 2.1. Передумови

| Інструмент | Що потрібно | Як встановити |
|-----------|------------|---------------|
| Android Studio | Flamingo+ | [developer.android.com/studio](https://developer.android.com/studio) |
| Android SDK | API 34 | Через SDK Manager в Android Studio |
| Node.js | 18+ | [nodejs.org](https://nodejs.org) |
| Java JDK | 17+ | Зазвичай йде з Android Studio |

### 2.2. Вписати URL relay-сервера

Відкрийте файл `static/js/config.js` і замініть рядок:

```javascript
const DEFAULT_SERVER_URL = '';
```

на ваш URL з Render:

```javascript
const DEFAULT_SERVER_URL = 'https://secure-file-transfer-relay.onrender.com';
```

> Це можна також ввести в самій апці при першому запуску (є поле "Relay-сервер"),
> але простіше вписати заздалегідь.

### 2.3. Збірка

```bash
cd secure-file-transfer

# 1. Встановити Capacitor та плагіни
npm install

# 2. Створити Android-проект
npx cap add android

# 3. Скопіювати веб-файли у Android-проект
npx cap sync android

# 4. Відкрити в Android Studio
npx cap open android
```

### 2.4. В Android Studio

1. Зачекати поки Gradle sync завершиться (1-2 хвилини при першому разі)
2. **File → Project Structure → Modules** — перевірити що Compile SDK = 34
3. **Build → Build Bundle(s) / APK(s) → Build APK(s)**
4. APK з'явиться у:
   ```
   android/app/build/outputs/apk/debug/app-debug.apk
   ```

### 2.5. Встановити на телефон

**Варіант А — через USB:**
```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

**Варіант Б — без USB:**
- Скопіювати `app-debug.apk` на телефон (Google Drive, Telegram, email)
- Відкрити файл → «Встановити» (потрібно дозволити встановлення з невідомих джерел)


---

## ЕТАП 3: Використання

### На телефоні A (відправник):
1. Відкрити апку
2. Натиснути **«Створити сесію»**
3. Показати QR-код телефону Б

### На телефоні Б (отримувач):
1. Відкрити апку
2. Ввести ID сесії (або відсканувати QR приєднання)

### Обидва телефони:
3. **Верифікація**: кожен сканує QR-код з екрану іншого телефону (підтверджує ключі)
4. Після верифікації — відправник обирає файл
5. Файл шифрується у браузері → передається через relay → розшифровується на другому телефоні
6. Отримувач зберігає файл


---

## Альтернатива: без APK (PWA у браузері)

Якщо не хочеш збирати APK — просто відкрий URL сервера з Render у браузері телефону:

```
https://secure-file-transfer-relay.onrender.com
```

Це повноцінний PWA — працює в Chrome/Safari без встановлення.
Можна навіть «Add to Home Screen» для іконки на робочому столі.


---

## Команди-шпаргалка

```bash
# Деплой сервера (після git push на GitHub + підключення до Render)
# → автоматично

# Після зміни коду клієнта — пересинхронізувати:
npx cap sync android
# Потім Build APK в Android Studio

# Перевірка здоров'я сервера:
curl https://YOUR-APP.onrender.com/api/health

# Логи на Render:
# render.com → Dashboard → Logs
```


---

## Структура проекту

```
secure-file-transfer/
├── server/                # Relay-сервер (Python/FastAPI)
│   ├── main.py            # API + WebSocket handler
│   ├── session_manager.py # Менеджер сесій
│   ├── models.py          # Протокол повідомлень
│   ├── crypto_utils.py    # CSPRNG, fingerprint, QR
│   ├── rate_limiter.py    # Rate limiting
│   ├── middleware.py       # Security headers
│   └── config.py          # Конфігурація
├── static/                # Клієнт (PWA) — також webDir для Capacitor
│   ├── index.html
│   ├── js/
│   │   ├── config.js      # ← URL relay-сервера тут
│   │   ├── crypto.js      # Web Crypto API (ECDH, AES-256-GCM)
│   │   ├── websocket.js   # WebSocket-клієнт
│   │   ├── qr.js          # QR генерація/сканування
│   │   ├── file-handler.js# Обробка файлів
│   │   ├── native-bridge.js # Capacitor bridge
│   │   └── app.js         # Головний контролер (State Machine)
│   ├── css/style.css
│   ├── sw.js              # Service Worker (PWA)
│   └── manifest.json      # PWA manifest
├── tests/                 # pytest тести
├── package.json           # Capacitor (npm)
├── capacitor.config.json  # Конфігурація Capacitor
├── build.sh               # Автоматизована збірка APK
├── Dockerfile             # Для хмарного деплою
├── Procfile               # Railway/Heroku
├── render.yaml            # Render.com (one-click deploy)
├── requirements.txt       # Python залежності
└── DEPLOY.md              # Ця інструкція
```
