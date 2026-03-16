"""
server/models.py
Pydantic-схеми протокольних повідомлень та відповідей API.

Визначає 11 типів повідомлень протоколу WebSocket
згідно специфікації (Додаток А звіту).
"""

from __future__ import annotations

import time
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# ── Типи повідомлень протоколу ──────────────────────────────────────

class MessageType(str, Enum):
    """Типи повідомлень WebSocket-протоколу."""

    # Фаза підключення
    SESSION_INIT = "SESSION_INIT"
    SESSION_READY = "SESSION_READY"

    # Фаза обміну ключами
    KEY_EXCHANGE = "KEY_EXCHANGE"
    KEY_RELAY = "KEY_RELAY"
    KEY_ACK = "KEY_ACK"

    # Фаза верифікації
    VERIFICATION_STATUS = "VERIFICATION_STATUS"
    BOTH_VERIFIED = "BOTH_VERIFIED"

    # Фаза передачі файлу
    FILE_METADATA = "FILE_METADATA"
    FILE_CHUNK = "FILE_CHUNK"
    FILE_COMPLETE = "FILE_COMPLETE"
    FILE_ACK = "FILE_ACK"

    # Службові
    PARTNER_CONNECTED = "PARTNER_CONNECTED"
    PARTNER_DISCONNECTED = "PARTNER_DISCONNECTED"
    SESSION_CLOSE = "SESSION_CLOSE"
    ERROR = "ERROR"


class SessionRole(str, Enum):
    """Ролі учасників сесії."""

    INITIATOR = "initiator"
    JOINER = "joiner"


class SessionState(str, Enum):
    """Стани серверної сесії (Додаток А.3)."""

    CREATED = "CREATED"
    CONNECTED = "CONNECTED"
    KEYS_EXCHANGED = "KEYS_EXCHANGED"
    VERIFIED = "VERIFIED"
    TRANSFERRING = "TRANSFERRING"
    COMPLETED = "COMPLETED"
    CLOSED = "CLOSED"


# ── Коди помилок (Додаток А.2) ─────────────────────────────────────

class ErrorCode(str, Enum):
    SESSION_NOT_FOUND = "SESSION_NOT_FOUND"
    SESSION_FULL = "SESSION_FULL"
    KEY_NOT_EXCHANGED = "KEY_NOT_EXCHANGED"
    VERIFICATION_REQUIRED = "VERIFICATION_REQUIRED"
    PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE"
    INVALID_NONCE = "INVALID_NONCE"
    RATE_LIMITED = "RATE_LIMITED"
    AUTH_TAG_MISMATCH = "AUTH_TAG_MISMATCH"
    INVALID_MESSAGE = "INVALID_MESSAGE"
    INVALID_STATE = "INVALID_STATE"
    INTERNAL_ERROR = "INTERNAL_ERROR"


# ── Вхідні повідомлення (від клієнта) ──────────────────────────────

class IncomingMessage(BaseModel):
    """Базове вхідне повідомлення від клієнта."""

    type: MessageType


class KeyExchangeMessage(BaseModel):
    """KEY_EXCHANGE: обмін публічними ключами."""

    type: MessageType = MessageType.KEY_EXCHANGE
    public_key: str = Field(..., description="Base64(SPKI) публічного ключа")
    fingerprint: str = Field(
        ..., min_length=64, max_length=64,
        description="Hex SHA-256 від публічного ключа"
    )
    key_algorithm: str = Field(
        default="ECDH-P256", description="Алгоритм ключа"
    )


class VerificationStatusMessage(BaseModel):
    """VERIFICATION_STATUS: результат QR-верифікації."""

    type: MessageType = MessageType.VERIFICATION_STATUS
    verified: bool = Field(..., description="Результат верифікації")


class FileMetadataMessage(BaseModel):
    """FILE_METADATA: метадані файлу перед передачею."""

    type: MessageType = MessageType.FILE_METADATA
    filename: str = Field(..., max_length=255, description="Ім'я файлу")
    original_size: int = Field(..., gt=0, description="Розмір оригіналу (байт)")
    chunk_count: int = Field(..., gt=0, description="Загальна кількість chunk-ів")
    nonce: str = Field(..., description="Base64 nonce (12 байт)")
    content_type: str = Field(
        default="application/octet-stream", description="MIME-тип файлу"
    )


class FileChunkMessage(BaseModel):
    """FILE_CHUNK: зашифрований фрагмент файлу."""

    type: MessageType = MessageType.FILE_CHUNK
    chunk_index: int = Field(..., ge=0, description="Індекс фрагмента")
    total_chunks: int = Field(..., gt=0, description="Загальна кількість")
    data: str = Field(..., description="Base64(ciphertext)")


class FileCompleteMessage(BaseModel):
    """FILE_COMPLETE: завершення передачі з GCM auth tag."""

    type: MessageType = MessageType.FILE_COMPLETE
    auth_tag: str = Field(..., description="Base64 GCM auth tag (16 байт)")
    sha256_plaintext: str = Field(
        default="", description="SHA-256 відкритого тексту для верифікації"
    )


class FileAckMessage(BaseModel):
    """FILE_ACK: підтвердження розшифрування."""

    type: MessageType = MessageType.FILE_ACK
    success: bool
    error_code: Optional[str] = None


class SessionCloseMessage(BaseModel):
    """SESSION_CLOSE: закриття сесії."""

    type: MessageType = MessageType.SESSION_CLOSE
    reason: str = Field(default="user_closed", description="Причина закриття")


# ── Вихідні повідомлення (від сервера) ─────────────────────────────

class OutgoingError(BaseModel):
    """Повідомлення про помилку від сервера."""

    type: MessageType = MessageType.ERROR
    error_code: str
    message: str
    fatal: bool = False


# ── HTTP API моделі ────────────────────────────────────────────────

class CreateSessionResponse(BaseModel):
    """Відповідь на POST /api/sessions."""

    session_id: str
    join_url: str
    qr_data: str  # дані для QR-коду запрошення
    created_at: float = Field(default_factory=time.time)


class SessionStatusResponse(BaseModel):
    """Відповідь на GET /api/sessions/{id}/status."""

    session_id: str
    state: SessionState
    initiator_connected: bool
    joiner_connected: bool
    keys_exchanged: bool
    both_verified: bool
    created_at: float
    ttl_remaining: int
