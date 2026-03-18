# Оновлення сервера та APK + тестування ноутбук ↔ смартфон

## Що маємо

```
📱 Смартфон (APK)  ←──WSS──→  ☁️ Render.com  ←──WSS──→  💻 Ноутбук (браузер)
                               (relay-сервер)
                               + веб-клієнт
```

Render хостить і relay-сервер, і веб-клієнт одночасно.
На ноутбуці просто відкриваєш URL у Chrome — і все працює.


---

## КРОК 1: Оновити код на GitHub

Якщо репозиторій вже створено раніше:

```bash
# Розпакувати новий архів
tar -xzf secure-file-transfer.tar.gz
cd secure-file-transfer

# Якщо .git вже є — просто коміт
git add .
git commit -m "v2: back buttons, crash protection, hints"
git push
```

Якщо репозиторію ще немає:

```bash
tar -xzf secure-file-transfer.tar.gz
cd secure-file-transfer

git init
git add .
git commit -m "Initial commit"

# Створити репо на github.com, потім:
git remote add origin https://github.com/YOUR_USER/secure-file-transfer.git
git branch -M main
git push -u origin main
```


---

## КРОК 2: Деплой / оновлення на Render.com

### Якщо Render ще не налаштовано (перший раз):

1. Зайти на **[render.com](https://render.com)** → Sign up (через GitHub)
2. **New** → **Web Service**
3. Підключити репозиторій `secure-file-transfer`
4. Render побачить `render.yaml` і заповнить все автоматично:
   - **Runtime**: Python
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn server.main:app --host 0.0.0.0 --port $PORT`
5. Plan: **Free**
6. Натиснути **Create Web Service**
7. Зачекати 2-3 хвилини

### Якщо Render вже налаштовано (оновлення):

**Render автоматично деплоїть при кожному `git push`.**

Просто:
```bash
git push
```

Через 1-2 хвилини нова версія буде live. Можна дивитись статус у Dashboard → Events.

### Отримати URL

Після деплою URL буде типу:
```
https://secure-file-transfer-XXXX.onrender.com
```

Перевірка:
```
https://secure-file-transfer-XXXX.onrender.com/api/health
```
→ `{"status":"ok","active_sessions":0,"version":"1.0.0"}`


---

## КРОК 3: Тест на ноутбуці (без APK)

Просто відкрий URL з Render у Chrome на ноутбуці:

```
https://secure-file-transfer-XXXX.onrender.com
```

Це повноцінний веб-клієнт. Створи сесію тут.


---

## КРОК 4: Оновити APK для смартфона

### 4.1. Вписати URL сервера

Відкрий `static/js/config.js`, знайди рядок:
```javascript
const DEFAULT_SERVER_URL = '';
```

Заміни на свій URL з Render:
```javascript
const DEFAULT_SERVER_URL = 'https://secure-file-transfer-XXXX.onrender.com';
```

### 4.2. Пересинхронізувати та зібрати

```bash
# Якщо node_modules ще немає:
npm install

# Якщо android/ ще немає:
npx cap add android

# Синхронізація оновлених файлів:
npx cap sync android

# Відкрити в Android Studio:
npx cap open android
```

### 4.3. Зібрати APK в Android Studio

1. Зачекати Gradle sync
2. **Build → Build Bundle(s) / APK(s) → Build APK(s)**
3. APK тут: `android/app/build/outputs/apk/debug/app-debug.apk`

### 4.4. Встановити на телефон

- **USB**: `adb install android/app/build/outputs/apk/debug/app-debug.apk`
- **Без USB**: скинути APK на телефон через Telegram/Drive → відкрити → встановити


---

## КРОК 5: Тестування ноутбук ↔ смартфон

### На ноутбуці (Chrome):
1. Відкрити `https://secure-file-transfer-XXXX.onrender.com`
2. Натиснути **«Створити сесію»**
3. З'явиться QR-код та посилання

### На смартфоні (APK):
1. Відкрити апку
2. Ввести ID сесії (скопіювати з ноутбука) або відсканувати QR приєднання
3. Або: якщо URL вбито в config.js — натиснути «Приєднатись»

### Верифікація:
4. На ноутбуці — показується QR вашого ключа
5. На телефоні — натиснути **«📷 Сканувати QR»** → навести камеру на екран ноутбука
6. На телефоні — показати свій QR ноутбуку
7. На ноутбуці — натиснути **«✋ Ручна верифікація»** (камери немає) або порівняти fingerprint вручну

> **Порада**: на ноутбуці камера може бути недоступна через HTTP.
> Використовуйте «Ручна верифікація» на ноутбуці, а QR-скан — на телефоні.

### Передача:
8. Хто завгодно обирає файл → шифрується → передається → другий отримує


---

## Шпаргалка команд

```bash
# Оновити сервер на Render (після зміни коду):
git add . && git commit -m "update" && git push
# → Render деплоїть автоматично

# Оновити APK (після зміни клієнтського коду):
npx cap sync android
# → Android Studio → Build APK

# Повна перезбірка APK з нуля:
npm install
npx cap add android
npx cap sync android
npx cap open android

# Перевірка сервера:
curl https://YOUR-URL.onrender.com/api/health
```


---

## FAQ

**Q: Перший запит до Render довго відповідає?**
A: Безкоштовний план "засинає" після 15 хв. Перший запит після сну — 30-50 секунд. Це нормально.

**Q: Чи можна тестувати два телефони?**
A: Так! Обидва відкривають APK, один створює сесію, другий приєднується.

**Q: Чи можна тестувати два вікна браузера?**
A: Так! Відкрити URL у двох вкладках/вікнах. Але QR-сканування камерою потребує HTTPS.

**Q: Файл не передається?**
A: Перевірте що обидві сторони пройшли верифікацію (зелені галочки). Без неї передача заблокована.

**Q: APK не підключається до сервера?**
A: Перевірте URL у config.js. Має бути `https://...`, не `http://`.
