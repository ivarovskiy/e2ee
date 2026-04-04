"""
server/session_manager.py
Менеджер сесій relay-сервера.

SessionManager відповідає за повний lifecycle сесії:
- створення та видалення сесій
- відстеження учасників (WebSocket-з'єднань)
- збереження публічних ключів та статусу верифікації
- TTL та автоматичне очищення
- захист від replay-атак (відстеження nonce)
- ізоляція даних між сесіями

КРИТИЧНА ВЛАСТИВІСТЬ: SessionManager НІКОЛИ не інтерпретує
вміст повідомлень типу FILE_CHUNK — zero-trust relay.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Optional

from fastapi import WebSocket

from .config import settings
from .crypto_utils import generate_session_id, generate_session_token
from .models import SessionState, SessionRole, ErrorCode

logger = logging.getLogger("sft.session_manager")


@dataclass
class SessionData:
    """
    Дані однієї сесії обміну файлами.

    Містить всю інформацію про сесію: з'єднання учасників,
    публічні ключі, статус верифікації, використані nonce.
    """

    session_id: str
    token: str  # токен автентифікації
    created_at: float = field(default_factory=time.time)
    state: SessionState = SessionState.CREATED

    # WebSocket-з'єднання учасників
    initiator_ws: Optional[WebSocket] = field(default=None, repr=False)
    joiner_ws: Optional[WebSocket] = field(default=None, repr=False)

    # Публічні ключі (Base64 SPKI)
    initiator_pubkey: Optional[str] = None
    joiner_pubkey: Optional[str] = None

    # Fingerprints (SHA-256 hex)
    initiator_fingerprint: Optional[str] = None
    joiner_fingerprint: Optional[str] = None

    # Статус QR-верифікації
    initiator_verified: bool = False
    joiner_verified: bool = False

    # Захист від replay (використані nonce)
    seen_nonces: set = field(default_factory=set)

    # Метадані передачі
    current_file_metadata: Optional[dict] = None
    chunks_received: int = 0

    @property
    def ttl_seconds(self) -> int:
        """TTL залежить від стану сесії."""
        if self.state == SessionState.CREATED:
            return settings.session_ttl_waiting
        return settings.session_ttl_seconds

    @property
    def is_expired(self) -> bool:
        """Чи вичерпано TTL сесії."""
        return (time.time() - self.created_at) > self.ttl_seconds

    @property
    def ttl_remaining(self) -> int:
        """Залишок TTL у секундах."""
        remaining = self.ttl_seconds - (time.time() - self.created_at)
        return max(0, int(remaining))

    @property
    def both_connected(self) -> bool:
        """Чи підключені обидва учасники."""
        return self.initiator_ws is not None and self.joiner_ws is not None

    @property
    def both_keys_exchanged(self) -> bool:
        """Чи обмінялися ключами обидва учасники."""
        return self.initiator_pubkey is not None and self.joiner_pubkey is not None

    @property
    def both_verified(self) -> bool:
        """Чи верифікували обидва учасники ключі."""
        return self.initiator_verified and self.joiner_verified

    def get_partner_ws(self, role: SessionRole) -> Optional[WebSocket]:
        """Повертає WebSocket партнера."""
        if role == SessionRole.INITIATOR:
            return self.joiner_ws
        return self.initiator_ws

    def get_ws(self, role: SessionRole) -> Optional[WebSocket]:
        """Повертає WebSocket учасника за роллю."""
        if role == SessionRole.INITIATOR:
            return self.initiator_ws
        return self.joiner_ws

    def set_ws(self, role: SessionRole, ws: Optional[WebSocket]) -> None:
        """Встановлює WebSocket для ролі."""
        if role == SessionRole.INITIATOR:
            self.initiator_ws = ws
        else:
            self.joiner_ws = ws

    def set_pubkey(self, role: SessionRole, pubkey: str, fingerprint: str) -> None:
        """Зберігає публічний ключ та fingerprint для ролі."""
        if role == SessionRole.INITIATOR:
            self.initiator_pubkey = pubkey
            self.initiator_fingerprint = fingerprint
        else:
            self.joiner_pubkey = pubkey
            self.joiner_fingerprint = fingerprint

    def set_verified(self, role: SessionRole, verified: bool) -> None:
        """Встановлює статус верифікації для ролі."""
        if role == SessionRole.INITIATOR:
            self.initiator_verified = verified
        else:
            self.joiner_verified = verified

    def check_nonce(self, nonce: str) -> bool:
        """
        Перевіряє унікальність nonce (захист від replay).

        Returns:
            True якщо nonce унікальний, False якщо вже використаний.
        """
        if nonce in self.seen_nonces:
            return False
        self.seen_nonces.add(nonce)
        return True

    def clear_sensitive_data(self) -> None:
        """Очищення чутливих даних при закритті сесії."""
        self.initiator_pubkey = None
        self.joiner_pubkey = None
        self.initiator_fingerprint = None
        self.joiner_fingerprint = None
        self.initiator_verified = False
        self.joiner_verified = False
        self.seen_nonces.clear()
        self.current_file_metadata = None
        self.chunks_received = 0
        self.state = SessionState.CLOSED


class SessionManager:
    """
    Менеджер сесій relay-сервера.

    Відповідає за створення, відстеження та видалення сесій.
    Реалізує автоматичне очищення прострочених сесій.
    """

    # Час очікування перед тим як повідомити партнера про відключення.
    # Дозволяє клієнту перепідключитись після короткочасного розриву
    # (наприклад, відкриття камери або перемикання додатків) без скидання сесії.
    DISCONNECT_GRACE_SECONDS = 5

    def __init__(self) -> None:
        self._sessions: dict[str, SessionData] = {}
        self._cleanup_task: Optional[asyncio.Task] = None
        # Задачі відкладеного повідомлення партнера: (session_id, role_value) → Task
        self._pending_disconnects: dict[tuple[str, str], asyncio.Task] = {}

    @property
    def active_session_count(self) -> int:
        """Кількість активних сесій."""
        return len(self._sessions)

    def start_cleanup_loop(self) -> None:
        """Запускає фонову задачу очищення прострочених сесій."""
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())
            logger.info("Session cleanup loop started")

    def stop_cleanup_loop(self) -> None:
        """Зупиняє фонову задачу очищення."""
        if self._cleanup_task and not self._cleanup_task.done():
            self._cleanup_task.cancel()
            logger.info("Session cleanup loop stopped")

    async def _cleanup_loop(self) -> None:
        """Фонова задача: видаляє прострочені сесії кожні 30 секунд."""
        while True:
            try:
                await asyncio.sleep(30)
                expired = [
                    sid
                    for sid, session in self._sessions.items()
                    if session.is_expired
                ]
                for sid in expired:
                    logger.info(
                        f"Session {sid[:8]}... expired, cleaning up "
                        f"(state={self._sessions[sid].state.value})"
                    )
                    await self.close_session(sid, reason="ttl_expired")
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Cleanup loop error: {e}")

    def create_session(self) -> SessionData:
        """
        Створює нову сесію.

        Returns:
            SessionData нової сесії.

        Raises:
            RuntimeError: якщо досягнуто ліміт сесій.
        """
        if len(self._sessions) >= settings.max_sessions:
            raise RuntimeError(
                f"Maximum sessions limit reached ({settings.max_sessions})"
            )

        session_id = generate_session_id()
        token = generate_session_token()
        session = SessionData(session_id=session_id, token=token)
        self._sessions[session_id] = session

        logger.info(
            f"Session created: {session_id[:8]}... "
            f"(active: {len(self._sessions)})"
        )
        return session

    def get_session(self, session_id: str) -> Optional[SessionData]:
        """
        Повертає сесію за ID.

        Returns:
            SessionData або None якщо сесія не знайдена / прострочена.
        """
        session = self._sessions.get(session_id)
        if session is None:
            return None
        if session.is_expired:
            logger.info(f"Session {session_id[:8]}... expired on access")
            # Не видаляємо тут — залишаємо для cleanup loop
            return None
        return session

    async def join_session(
        self, session_id: str, role: SessionRole, ws: WebSocket
    ) -> tuple[Optional[SessionData], Optional[ErrorCode]]:
        """
        Підключає учасника до сесії.

        Підтримує reconnect: якщо для ролі вже є WS-з'єднання,
        воно замінюється новим (клієнт перепідключився після розриву).

        Returns:
            (SessionData, None) при успіху або (None, ErrorCode) при помилці.
        """
        session = self.get_session(session_id)
        if session is None:
            return None, ErrorCode.SESSION_NOT_FOUND

        if session.state == SessionState.CLOSED:
            return None, ErrorCode.SESSION_NOT_FOUND

        existing_ws = session.get_ws(role)
        if existing_ws is not None:
            # Reconnect: закриваємо старе з'єднання і скасовуємо відкладене
            # повідомлення партнера (якщо воно ще не відправлено).
            key = (session_id, role.value)
            if key in self._pending_disconnects:
                self._pending_disconnects[key].cancel()
                self._pending_disconnects.pop(key, None)
                logger.info(
                    f"Session {session_id[:8]}...: {role.value} reconnected "
                    f"within grace period — PARTNER_DISCONNECTED cancelled"
                )
            try:
                await existing_ws.close()
            except Exception:
                pass

        session.set_ws(role, ws)

        # Оновлення стану
        if session.both_connected:
            session.state = SessionState.CONNECTED
            logger.info(
                f"Session {session_id[:8]}... → CONNECTED "
                f"(both participants joined)"
            )

        return session, None

    async def disconnect(
        self, session_id: str, role: SessionRole
    ) -> None:
        """
        Відключає учасника від сесії.

        Замість миттєвого повідомлення партнера запускає відкладену задачу
        (DISCONNECT_GRACE_SECONDS). Якщо клієнт перепідключиться за цей час —
        задача скасовується і партнер нічого не отримує.
        """
        session = self._sessions.get(session_id)
        if session is None:
            return

        session.set_ws(role, None)
        logger.info(
            f"Session {session_id[:8]}...: {role.value} disconnected "
            f"(grace={self.DISCONNECT_GRACE_SECONDS}s)"
        )

        # Відкладена задача — можлива скасовка при reconnect
        key = (session_id, role.value)
        if key in self._pending_disconnects:
            self._pending_disconnects[key].cancel()

        task = asyncio.create_task(
            self._delayed_disconnect_notify(session_id, role)
        )
        self._pending_disconnects[key] = task

    async def _delayed_disconnect_notify(
        self, session_id: str, role: SessionRole
    ) -> None:
        """
        Через DISCONNECT_GRACE_SECONDS перевіряє, чи клієнт повернувся.
        Якщо ні — сповіщає партнера про відключення.
        """
        try:
            await asyncio.sleep(self.DISCONNECT_GRACE_SECONDS)

            session = self._sessions.get(session_id)
            if session is None:
                return

            # Якщо роль знову підключена — reconnect відбувся, нічого не робимо
            if session.get_ws(role) is not None:
                return

            partner_role = (
                SessionRole.JOINER
                if role == SessionRole.INITIATOR
                else SessionRole.INITIATOR
            )
            partner_ws = session.get_ws(partner_role)
            if partner_ws is not None:
                try:
                    await partner_ws.send_json(
                        {"type": "PARTNER_DISCONNECTED", "role": role.value}
                    )
                    logger.info(
                        f"Session {session_id[:8]}...: sent PARTNER_DISCONNECTED "
                        f"for {role.value} after grace period"
                    )
                except Exception:
                    pass
        except asyncio.CancelledError:
            pass
        finally:
            key = (session_id, role.value)
            self._pending_disconnects.pop(key, None)

    async def close_session(
        self, session_id: str, reason: str = "closed"
    ) -> None:
        """
        Закриває сесію та очищує всі дані.

        Надсилає SESSION_CLOSE обом учасникам перед закриттям.
        """
        session = self._sessions.pop(session_id, None)
        if session is None:
            return

        close_msg = {
            "type": "SESSION_CLOSE",
            "session_id": session_id,
            "reason": reason,
        }

        # Повідомити обох учасників
        for ws in [session.initiator_ws, session.joiner_ws]:
            if ws is not None:
                try:
                    await ws.send_json(close_msg)
                    await ws.close()
                except Exception:
                    pass

        session.clear_sensitive_data()

        logger.info(
            f"Session {session_id[:8]}... closed "
            f"(reason={reason}, active: {len(self._sessions)})"
        )

    def update_state(self, session: SessionData) -> None:
        """
        Оновлює стан сесії на основі поточних даних.

        Виконує перевірку переходів згідно діаграми станів (Таблиця А.3).
        """
        if session.state == SessionState.CLOSED:
            return

        if session.both_connected and session.state == SessionState.CREATED:
            session.state = SessionState.CONNECTED

        if session.both_keys_exchanged and session.state == SessionState.CONNECTED:
            session.state = SessionState.KEYS_EXCHANGED

        if session.both_verified and session.state == SessionState.KEYS_EXCHANGED:
            session.state = SessionState.VERIFIED


# Singleton інстанс
session_manager = SessionManager()
