# Деплой та збірка — від нуля до робочої апки

## Загальна схема

```
📱 Телефон A (APK або браузер)          📱 Телефон Б (APK або браузер)
        │                                          │
        │  WSS (зашифровані blob, E2EE)            │
        └──────────── ☁️ Relay ─────────────────────┘
                   (Render.com / Docker)
                   НЕ бачить файли
```

---

## ЕТАП 1: Деплой relay-сервера

### Варіант А — Render.com (безкоштовно, 5 хвилин)

1. Завантажити репозиторій на GitHub
2. Зайти на [render.com](https://render.com) → **New → Web Service**
3. Підключити репозиторій — Render знайде `render.yaml` автоматично
4. Натиснути **Create Web Service** → зачекати 2-3 хвилини
5. Отримати URL: `https://YOUR-APP.onrender.com`

Перевірка:
```bash
curl https://YOUR-APP.onrender.com/api/health
# → {"status":"ok","active_sessions":0,"version":"1.0.0"}
```

> Безкоштовний план "засинає" після 15 хв без активності.
> Перший запит після сну може займати 30-50 секунд.

**Автодеплой при git push:**
```bash
git add . && git commit -m "update" && git push
# → Render деплоїть автоматично за 1-2 хвилини
```

### Варіант Б — Docker (self-hosted)

```bash
docker build -t secure-drop .
docker run -d -p 8000:8000 \
  -e SFT_CORS_ORIGINS='["https://your-domain.com"]' \
  -e SFT_LOG_LEVEL=INFO \
  secure-drop
```

### Варіант В — локальна розробка

```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python run.py
# → http://localhost:8000
```

---

## ЕТАП 2: Веб-клієнт (PWA у браузері)

Відкрити URL сервера у браузері — це вже повноцінний PWA:

```
https://YOUR-APP.onrender.com
```

- Працює в Chrome, Firefox, Safari, Edge
- Можна "Add to Home Screen" для іконки на робочому столі
- QR-сканування потребує HTTPS (не localhost)

---

## ЕТАП 3: Збірка Android APK

### Передумови

| Інструмент | Версія | Посилання |
|------------|--------|-----------|
| Android Studio | Flamingo+ | [developer.android.com/studio](https://developer.android.com/studio) |
| Android SDK | API 34 | SDK Manager в Android Studio |
| Node.js | 18+ | [nodejs.org](https://nodejs.org) |
| Java JDK | 17+ | Зазвичай йде з Android Studio |

### Крок 1: Вписати URL сервера (опціонально)

Відкрити `static/js/config.js`:
```javascript
// Залишити порожнім — можна ввести в самій апці при запуску
const DEFAULT_SERVER_URL = '';

// АБО вписати одразу:
const DEFAULT_SERVER_URL = 'https://YOUR-APP.onrender.com';
```

### Крок 2: Збірка

```bash
# Встановити залежності
npm install

# Додати Android-платформу (якщо android/ ще немає)
npx cap add android

# Синхронізувати веб-файли в Android-проект
npx cap sync android

# Відкрити в Android Studio
npx cap open android
```

### Крок 3: Збірка APK в Android Studio

1. Зачекати Gradle sync (1-2 хв при першому разі)
2. **Build → Build Bundle(s) / APK(s) → Build APK(s)**
3. APK знаходиться тут:
   ```
   android/app/build/outputs/apk/debug/app-debug.apk
   ```

### Крок 4: Встановлення на телефон

**Через USB:**
```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

**Без USB (передати файл):**
- Telegram / Google Drive / email → відкрити APK → «Встановити»
- Потрібно дозволити встановлення з невідомих джерел у налаштуваннях

---

## ЕТАП 4: Використання

### На пристрої A (ініціатор):
1. Відкрити застосунок
2. Натиснути **«Створити сесію»**
3. Показати QR-код пристрою Б або надіслати посилання

### На пристрої Б (joiner):
**Варіант А — сканування QR:**
1. Відкрити застосунок
2. Натиснути **«Сканувати QR партнера»** (на головному екрані)
3. Навести камеру на QR ініціатора — приєднається автоматично

**Варіант Б — вручну:**
1. Вставити ID сесії в поле → **«Приєднатись»**
2. Або відкрити посилання з месенджера

### Верифікація (обидва):
3. Кожен сканує QR-код з екрану іншого (підтвердження ключів)
4. Після двох зелених галочок → передача дозволена

### Передача:
5. Будь-хто з двох натискає зону файлу → обирає файл → відправляє

---

## Оновлення після зміни коду

```bash
# Зміна серверного коду:
git add . && git commit -m "fix" && git push
# → Render деплоїть автоматично

# Зміна клієнтського коду (JS/CSS):
npx cap sync android
# → Android Studio → Build → Build APK

# Повна перезбірка:
npm install
npx cap sync android
npx cap open android
```

---

## Тести

```bash
pytest tests/ -v                    # 42 тести
pytest tests/ --cov=server          # + покриття коду
```

---

## Змінні середовища (production)

| Змінна | Значення | Опис |
|--------|---------|------|
| `SFT_CORS_ORIGINS` | `["https://domain.com"]` | Обмежити CORS (замість `*`) |
| `SFT_LOG_LEVEL` | `WARNING` | Менше шуму в логах |
| `SFT_MAX_SESSIONS` | `500` | Під ресурси хосту |
| `SFT_HTTP_RATE_LIMIT` | `10` | HTTP req/s per IP |
| `SFT_WS_CONNECT_RATE_LIMIT` | `5` | WS connections/хв per IP |
| `SFT_SESSION_TTL_SECONDS` | `1800` | TTL активної сесії |

---

## FAQ

**Q: Перший запит до Render довго відповідає?**  
A: Безкоштовний план засинає після 15 хв. Перший запит після сну — 30-50 секунд. Нормально для демо.

**Q: Можна тестувати два вікна браузера?**  
A: Так! Відкрити URL у двох вкладках. QR-скан потребує HTTPS — на localhost використовуйте Ручну верифікацію.

**Q: APK не підключається до сервера?**  
A: URL у `config.js` або в полі застосунку має бути `https://...`, не `http://`.

**Q: Можна без APK (тільки браузер)?**  
A: Так, PWA у браузері — повний функціонал. APK потрібен лише для нативних функцій (haptic, camera permission на старих Android).

**Q: Файл не передається після верифікації?**  
A: Перевірте що обидві сторони мають зелені галочки "ok". Без цього сервер блокує FILE_METADATA.
