"""
server/middleware.py
Middleware для безпеки: HTTP Security Headers, rate limiting.

Реалізує вимоги Таблиці 3.10 звіту:
- Content-Security-Policy
- Strict-Transport-Security
- X-Frame-Options
- X-Content-Type-Options
- Referrer-Policy
- Permissions-Policy
"""

from __future__ import annotations

import logging

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response, JSONResponse

from .rate_limiter import http_limiter

logger = logging.getLogger("sft.middleware")


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """
    Middleware для встановлення обов'язкових HTTP Security Headers.

    Відповідає вимогам безпеки Таблиці 3.10 звіту.
    """

    SECURITY_HEADERS = {
        "Content-Security-Policy": (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; "
            "connect-src 'self' ws: wss:; "
            "media-src 'self'; "
            "worker-src 'self' blob:; "
            "frame-ancestors 'none'"
        ),
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy": "camera=(self), microphone=()",
        "X-Permitted-Cross-Domain-Policies": "none",
    }

    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)

        for header, value in self.SECURITY_HEADERS.items():
            response.headers[header] = value

        return response


class RateLimitMiddleware(BaseHTTPMiddleware):
    """
    Middleware для HTTP rate limiting.

    Обмежує кількість HTTP-запитів з одного IP.
    WebSocket rate limiting виконується окремо при підключенні.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        # Пропускаємо WebSocket-запити (вони обробляються окремо)
        if request.headers.get("upgrade", "").lower() == "websocket":
            return await call_next(request)

        # Пропускаємо статичні файли
        if request.url.path.startswith("/static"):
            return await call_next(request)

        client_ip = self._get_client_ip(request)

        if not http_limiter.is_allowed(client_ip):
            return JSONResponse(
                status_code=429,
                content={
                    "error_code": "RATE_LIMITED",
                    "message": "Too many requests. Please try again later.",
                },
            )

        return await call_next(request)

    @staticmethod
    def _get_client_ip(request: Request) -> str:
        """Отримує IP клієнта з урахуванням proxy-заголовків."""
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()
        if request.client:
            return request.client.host
        return "unknown"
