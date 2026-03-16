#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
#  build.sh — Збірка Android APK для Secure File Transfer
#
#  Використання:
#    chmod +x build.sh
#    ./build.sh              # debug APK
#    ./build.sh release      # release APK (потрібен keystore)
#    ./build.sh clean        # повне очищення та перезбірка
#
#  Передумови:
#    - Node.js 18+
#    - Android Studio + Android SDK (API 34)
#    - Java 17+
#    - ANDROID_HOME або ANDROID_SDK_ROOT встановлено
# ══════════════════════════════════════════════════════════════════════

set -e

# ── Кольори ─────────────────────────────────────────────────────────

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[1;34m'; N='\033[0m'
ok()   { echo -e "${G}✓${N} $1"; }
warn() { echo -e "${Y}!${N} $1"; }
err()  { echo -e "${R}✗ $1${N}"; exit 1; }
step() { echo -e "\n${B}── $1 ──${N}"; }

MODE="${1:-debug}"

echo ""
echo "  ╔═══════════════════════════════════════════╗"
echo "  ║   Secure File Transfer — Android Builder  ║"
echo "  ╚═══════════════════════════════════════════╝"
echo ""

# ── Перевірка передумов ─────────────────────────────────────────────

step "Перевірка середовища"

command -v node >/dev/null 2>&1 || err "Node.js не знайдено. Встановіть: https://nodejs.org"
NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
[ "$NODE_VER" -ge 18 ] || err "Node.js 18+ потрібен (зараз: $(node -v))"
ok "Node.js $(node -v)"

command -v npm >/dev/null 2>&1 || err "npm не знайдено"
ok "npm $(npm -v)"

command -v java >/dev/null 2>&1 || err "Java не знайдена. Встановіть JDK 17+"
ok "Java $(java -version 2>&1 | head -1)"

# Android SDK
if [ -z "$ANDROID_HOME" ] && [ -z "$ANDROID_SDK_ROOT" ]; then
    # Спробуємо типові шляхи
    for p in "$HOME/Android/Sdk" "$HOME/Library/Android/sdk" "/usr/lib/android-sdk"; do
        if [ -d "$p" ]; then
            export ANDROID_HOME="$p"
            export ANDROID_SDK_ROOT="$p"
            break
        fi
    done
fi

if [ -z "$ANDROID_HOME" ] && [ -z "$ANDROID_SDK_ROOT" ]; then
    err "Android SDK не знайдено. Встановіть Android Studio та задайте ANDROID_HOME"
fi
ok "Android SDK: ${ANDROID_HOME:-$ANDROID_SDK_ROOT}"

# ── Clean (опціонально) ────────────────────────────────────────────

if [ "$MODE" = "clean" ]; then
    step "Очищення"
    rm -rf node_modules android
    ok "Видалено node_modules/ та android/"
    MODE="debug"
fi

# ── npm install ─────────────────────────────────────────────────────

step "Встановлення npm-залежностей"

if [ ! -d "node_modules" ]; then
    npm install
    ok "Залежності встановлено"
else
    ok "Залежності вже є (пропускаємо npm install)"
fi

# ── Capacitor: додаємо Android ──────────────────────────────────────

step "Ініціалізація Android-проекту"

if [ ! -d "android" ]; then
    npx cap add android
    ok "Android-платформу додано"
else
    ok "Android-платформа вже існує"
fi

# ── Синхронізація веб-файлів ────────────────────────────────────────

step "Синхронізація static/ → android/"
npx cap sync android
ok "Веб-файли синхронізовано"

# ── Кастомізація Android ────────────────────────────────────────────

step "Застосування Android-кастомізацій"

MANIFEST="android/app/src/main/AndroidManifest.xml"

# Додаємо дозвіл CAMERA якщо немає
if [ -f "$MANIFEST" ]; then
    if ! grep -q "android.permission.CAMERA" "$MANIFEST"; then
        # Вставляємо дозвіл після першого <uses-permission
        sed -i '/<uses-permission/a\    <uses-permission android:name="android.permission.CAMERA" />' "$MANIFEST" 2>/dev/null || \
        sed -i '' '/<uses-permission/a\
    <uses-permission android:name="android.permission.CAMERA" />' "$MANIFEST" 2>/dev/null
        ok "Додано дозвіл CAMERA"
    else
        ok "Дозвіл CAMERA вже є"
    fi

    # Додаємо networkSecurityConfig якщо немає
    if ! grep -q "networkSecurityConfig" "$MANIFEST"; then
        sed -i 's|<application|<application android:usesCleartextTraffic="true"|' "$MANIFEST" 2>/dev/null || \
        sed -i '' 's|<application|<application android:usesCleartextTraffic="true"|' "$MANIFEST" 2>/dev/null
        ok "Додано usesCleartextTraffic (для dev-режиму)"
    else
        ok "networkSecurityConfig вже є"
    fi
fi

# Кольори (dark theme)
COLORS_FILE="android/app/src/main/res/values/colors.xml"
if [ -f "$COLORS_FILE" ]; then
    cat > "$COLORS_FILE" << 'XMLEOF'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="colorPrimary">#5b8af5</color>
    <color name="colorPrimaryDark">#0c0e14</color>
    <color name="colorAccent">#5b8af5</color>
</resources>
XMLEOF
    ok "Кольори оновлено (dark theme)"
fi

# Styles
STYLES_FILE="android/app/src/main/res/values/styles.xml"
if [ -f "$STYLES_FILE" ]; then
    cat > "$STYLES_FILE" << 'XMLEOF'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme" parent="Theme.AppCompat.NoActionBar">
        <item name="colorPrimary">@color/colorPrimary</item>
        <item name="colorPrimaryDark">@color/colorPrimaryDark</item>
        <item name="colorAccent">@color/colorAccent</item>
        <item name="android:windowBackground">@color/colorPrimaryDark</item>
        <item name="android:navigationBarColor">@color/colorPrimaryDark</item>
        <item name="android:statusBarColor">@color/colorPrimaryDark</item>
    </style>
    <style name="AppTheme.NoActionBar" parent="AppTheme">
        <item name="windowActionBar">false</item>
        <item name="windowNoTitle">true</item>
    </style>
</resources>
XMLEOF
    ok "Стилі оновлено (dark StatusBar + NavBar)"
fi

# Strings
STRINGS_FILE="android/app/src/main/res/values/strings.xml"
if [ -f "$STRINGS_FILE" ]; then
    cat > "$STRINGS_FILE" << 'XMLEOF'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">Secure File Transfer</string>
    <string name="title_activity_main">Secure File Transfer</string>
    <string name="package_name">com.sft.securetransfer</string>
    <string name="custom_url_scheme">com.sft.securetransfer</string>
</resources>
XMLEOF
    ok "Strings оновлено"
fi

# ── Збірка APK ──────────────────────────────────────────────────────

step "Збірка APK ($MODE)"

cd android
chmod +x gradlew 2>/dev/null || true

if [ "$MODE" = "release" ]; then
    ./gradlew assembleRelease
    APK_PATH="app/build/outputs/apk/release/app-release-unsigned.apk"
else
    ./gradlew assembleDebug
    APK_PATH="app/build/outputs/apk/debug/app-debug.apk"
fi

cd ..

# ── Результат ───────────────────────────────────────────────────────

FULL_APK="android/$APK_PATH"

if [ -f "$FULL_APK" ]; then
    SIZE=$(du -h "$FULL_APK" | cut -f1)

    # Копіюємо в корінь для зручності
    cp "$FULL_APK" "./secure-file-transfer.apk"

    echo ""
    echo "  ╔═══════════════════════════════════════════╗"
    echo -e "  ║  ${G}APK успішно зібрано!${N}                    ║"
    echo "  ╠═══════════════════════════════════════════╣"
    echo "  ║  Файл: ./secure-file-transfer.apk        ║"
    echo "  ║  Розмір: $SIZE                            ║"
    echo "  ╚═══════════════════════════════════════════╝"
    echo ""
    echo "  Встановлення на підключений пристрій:"
    echo "    adb install secure-file-transfer.apk"
    echo ""
    echo "  Або скопіюйте APK на телефон і встановіть."
    echo ""
else
    err "APK не знайдено: $FULL_APK"
fi
