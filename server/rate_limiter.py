"""
server/rate_limiter.py
Rate limiting по IP для HTTP-запитів та WebSocket-підключень.

Використовує алгоритм sliding window counter.
"""

from __future__ import annotations

import time
import logging
from collections import defaultdict
from dataclasses import dataclass, field

logger = logging.getLogger("sft.rate_limiter")


@dataclass
class RateLimitEntry:
    """Запис rate limit для одного IP."""

    timestamps: list[float] = field(default_factory=list)

    def cleanup(self, window_seconds: float) -> None:
        """Видаляє застарілі записи."""
        cutoff = time.time() - window_seconds
        self.timestamps = [t for t in self.timestamps if t > cutoff]

    def add(self) -> None:
        """Додає новий запит."""
        self.timestamps.append(time.time())

    @property
    def count(self) -> int:
        return len(self.timestamps)


class RateLimiter:
    """
    Rate limiter з підтримкою sliding window.

    Використовується для обмеження HTTP-запитів (10/с)
    та WebSocket-підключень (5/хв).
    """

    def __init__(
        self,
        max_requests: int,
        window_seconds: float,
        name: str = "default",
    ) -> None:
        self._max_requests = max_requests
        self._window_seconds = window_seconds
        self._name = name
        self._entries: dict[str, RateLimitEntry] = defaultdict(RateLimitEntry)
        self._last_cleanup = time.time()

    def is_allowed(self, client_ip: str) -> bool:
        """
        Перевіряє чи дозволено запит від цього IP.

        Args:
            client_ip: IP-адреса клієнта.

        Returns:
            True якщо запит дозволено.
        """
        # Періодичне глобальне очищення (раз на 60 секунд)
        now = time.time()
        if now - self._last_cleanup > 60:
            self._global_cleanup()
            self._last_cleanup = now

        entry = self._entries[client_ip]
        entry.cleanup(self._window_seconds)

        if entry.count >= self._max_requests:
            logger.warning(
                f"Rate limit ({self._name}) exceeded for {client_ip}: "
                f"{entry.count}/{self._max_requests} in {self._window_seconds}s"
            )
            return False

        entry.add()
        return True

    def _global_cleanup(self) -> None:
        """Видаляє IP-записи без активних запитів."""
        empty_ips = [
            ip for ip, entry in self._entries.items() if entry.count == 0
        ]
        for ip in empty_ips:
            del self._entries[ip]


# Інстанси rate limiter-ів
http_limiter = RateLimiter(
    max_requests=10,
    window_seconds=1.0,
    name="http",
)

ws_limiter = RateLimiter(
    max_requests=5,
    window_seconds=60.0,
    name="websocket",
)
