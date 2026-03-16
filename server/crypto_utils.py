"""
server/crypto_utils.py
Криптографічні утиліти relay-сервера.

Сервер НЕ виконує шифрування/розшифрування (zero-trust).
Цей модуль містить лише допоміжні функції:
- генерація session_id через CSPRNG
- обчислення fingerprint (для валідації формату)
- генерація QR-кодів запрошення
"""

import hashlib
import hmac
import secrets
from io import BytesIO
from base64 import b64encode

import qrcode
from qrcode.constants import ERROR_CORRECT_M


def generate_session_id() -> str:
    """
    Генерує унікальний session_id через CSPRNG.

    Використовує secrets.token_hex(16) — 128 біт ентропії,
    що дає 32-символьний hex-рядок.

    Returns:
        32-символьний hex session_id.
    """
    return secrets.token_hex(16)


def generate_session_token() -> str:
    """
    Генерує токен автентифікації для сесії (256 біт).

    Returns:
        64-символьний hex token.
    """
    return secrets.token_hex(32)


def validate_fingerprint_format(fingerprint: str) -> bool:
    """
    Перевіряє формат fingerprint (64 символи hex = SHA-256).

    Args:
        fingerprint: рядок для перевірки.

    Returns:
        True якщо формат коректний.
    """
    if len(fingerprint) != 64:
        return False
    try:
        int(fingerprint, 16)
        return True
    except ValueError:
        return False


def constant_time_compare(a: str, b: str) -> bool:
    """
    Порівняння рядків у постійному часі (захист від timing attack).

    Args:
        a, b: рядки для порівняння.

    Returns:
        True якщо рядки ідентичні.
    """
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def generate_session_qr_data(session_id: str, base_url: str) -> str:
    """
    Генерує дані для QR-коду запрошення до сесії.

    Args:
        session_id: ідентифікатор сесії.
        base_url: базова URL сервера.

    Returns:
        URL для приєднання до сесії.
    """
    return f"{base_url}/join/{session_id}"


def generate_qr_png_base64(data: str) -> str:
    """
    Генерує QR-код у форматі PNG, кодований у Base64.

    Args:
        data: дані для кодування в QR.

    Returns:
        Base64-рядок PNG-зображення QR-коду.
    """
    qr = qrcode.QRCode(
        version=None,
        error_correction=ERROR_CORRECT_M,
        box_size=8,
        border=2,
    )
    qr.add_data(data)
    qr.make(fit=True)

    img = qr.make_image(fill_color="black", back_color="white")

    buffer = BytesIO()
    img.save(buffer, format="PNG")
    buffer.seek(0)

    return b64encode(buffer.read()).decode("utf-8")
