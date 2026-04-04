"""
server/main.py
Головний модуль relay-сервера.

FastAPI-застосунок з WebSocket-ендпоінтами та HTTP API.
Реалізує повний протокол обміну повідомленнями (11 типів)
згідно специфікації (Додаток А).

КРИТИЧНА ВЛАСТИВІСТЬ: сервер є zero-trust relay.
Він НЕ інтерпретує вміст FILE_CHUNK — лише перевіряє
тип повідомлення та розмір payload, після чого ретранслює.
"""

from __future__ import annotations

import json
import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .models import (
    MessageType,
    SessionRole,
    SessionState,
    ErrorCode,
    CreateSessionResponse,
    SessionStatusResponse,
    OutgoingError,
)
from .session_manager import session_manager, SessionData
from .crypto_utils import generate_session_qr_data, generate_qr_png_base64
from .rate_limiter import ws_limiter
from .middleware import SecurityHeadersMiddleware, RateLimitMiddleware

# ── Logging ─────────────────────────────────────────────────────────

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("sft.main")


# ── Lifespan ────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Запуск/зупинка фонових задач."""
    session_manager.start_cleanup_loop()
    logger.info(
        f"Secure File Transfer relay server started "
        f"(host={settings.host}, port={settings.port})"
    )
    yield
    session_manager.stop_cleanup_loop()
    logger.info("Server shutting down")


# ── FastAPI app ─────────────────────────────────────────────────────

app = FastAPI(
    title="Secure File Transfer — Relay Server",
    description=(
        "Zero-trust relay server для захищеного обміну файлами "
        "з E2EE (AES-256-GCM) та QR-верифікацією ключів."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# Middleware (порядок важливий: останній доданий — перший виконаний)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RateLimitMiddleware)


# ── HTTP API ────────────────────────────────────────────────────────

@app.post("/api/sessions", response_model=CreateSessionResponse)
async def create_session(request: Request):
    """
    Створює нову сесію обміну файлами.

    Повертає session_id, URL для приєднання та QR-код.
    """
    try:
        session = session_manager.create_session()
    except RuntimeError as e:
        return JSONResponse(
            status_code=503,
            content={"error_code": "INTERNAL_ERROR", "message": str(e)},
        )

    base_url = str(request.base_url).rstrip("/")
    join_url = generate_session_qr_data(session.session_id, base_url)
    qr_data = generate_qr_png_base64(join_url)

    return CreateSessionResponse(
        session_id=session.session_id,
        join_url=join_url,
        qr_data=qr_data,
        created_at=session.created_at,
    )


@app.get("/api/sessions/{session_id}/status", response_model=SessionStatusResponse)
async def get_session_status(session_id: str):
    """Повертає статус сесії."""
    session = session_manager.get_session(session_id)
    if session is None:
        return JSONResponse(
            status_code=404,
            content={
                "error_code": ErrorCode.SESSION_NOT_FOUND.value,
                "message": "Session not found or expired",
            },
        )

    return SessionStatusResponse(
        session_id=session.session_id,
        state=session.state,
        initiator_connected=session.initiator_ws is not None,
        joiner_connected=session.joiner_ws is not None,
        keys_exchanged=session.both_keys_exchanged,
        both_verified=session.both_verified,
        created_at=session.created_at,
        ttl_remaining=session.ttl_remaining,
    )


@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "ok",
        "active_sessions": session_manager.active_session_count,
        "version": "1.0.0",
    }


# ── WebSocket Handler ───────────────────────────────────────────────

@app.websocket("/ws/{session_id}/{role}")
async def websocket_endpoint(
    websocket: WebSocket,
    session_id: str,
    role: str,
):
    """
    WebSocket-ендпоінт для учасників сесії.

    URL: /ws/{session_id}/{initiator|joiner}
    """
    # Валідація ролі
    try:
        session_role = SessionRole(role)
    except ValueError:
        await websocket.close(code=4000, reason="Invalid role")
        return

    # Rate limiting для WebSocket
    client_ip = _get_ws_client_ip(websocket)
    if not ws_limiter.is_allowed(client_ip):
        await websocket.close(code=4029, reason="Rate limited")
        return

    # Приймаємо з'єднання
    await websocket.accept()

    # Приєднуємось до сесії
    session, error = await session_manager.join_session(
        session_id, session_role, websocket
    )

    if error is not None:
        await _send_error(websocket, error, fatal=True)
        await websocket.close(code=4000 + int(error != ErrorCode.SESSION_NOT_FOUND))
        return

    logger.info(
        f"WS connected: session={session_id[:8]}..., role={role}"
    )

    # Повідомляємо партнера про підключення
    if session.both_connected:
        await _notify_both(session, {
            "type": MessageType.SESSION_READY.value,
            "session_id": session_id,
        })

    partner_ws = session.get_partner_ws(session_role)
    if partner_ws is not None:
        try:
            await partner_ws.send_json({
                "type": MessageType.PARTNER_CONNECTED.value,
                "role": role,
            })
        except Exception:
            pass

    # Головний цикл обробки повідомлень
    try:
        while True:
            raw = await websocket.receive_text()
            await _handle_message(session, session_role, raw)
    except WebSocketDisconnect:
        logger.info(f"WS disconnected: session={session_id[:8]}..., role={role}")
    except Exception as e:
        logger.error(f"WS error: session={session_id[:8]}..., {e}")
    finally:
        await session_manager.disconnect(session_id, session_role)


# ── Message Handler ─────────────────────────────────────────────────

async def _handle_message(
    session: SessionData, role: SessionRole, raw: str
) -> None:
    """
    Обробляє вхідне повідомлення від клієнта.

    Маршрутизує повідомлення за типом і перевіряє дозволені переходи.
    """
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        ws = session.get_ws(role)
        if ws:
            await _send_error(ws, ErrorCode.INVALID_MESSAGE, message="Invalid JSON")
        return

    msg_type = data.get("type")
    if msg_type is None:
        ws = session.get_ws(role)
        if ws:
            await _send_error(ws, ErrorCode.INVALID_MESSAGE, message="Missing 'type'")
        return

    # Маршрутизація за типом повідомлення
    # PING — keepalive від клієнта, ігноруємо (без відповіді)
    if msg_type == "PING":
        return

    handlers = {
        MessageType.KEY_EXCHANGE.value: _handle_key_exchange,
        MessageType.VERIFICATION_STATUS.value: _handle_verification_status,
        MessageType.FILE_METADATA.value: _handle_file_metadata,
        MessageType.FILE_CHUNK.value: _handle_file_chunk,
        MessageType.FILE_COMPLETE.value: _handle_file_complete,
        MessageType.FILE_ACK.value: _handle_file_ack,
        MessageType.SESSION_CLOSE.value: _handle_session_close,
    }

    handler = handlers.get(msg_type)
    if handler is None:
        ws = session.get_ws(role)
        if ws:
            await _send_error(
                ws, ErrorCode.INVALID_MESSAGE,
                message=f"Unknown message type: {msg_type}"
            )
        return

    await handler(session, role, data)


async def _handle_key_exchange(
    session: SessionData, role: SessionRole, data: dict
) -> None:
    """Обробляє KEY_EXCHANGE: зберігає ключ і ретранслює партнеру."""
    pubkey = data.get("public_key")
    fingerprint = data.get("fingerprint")
    key_algorithm = data.get("key_algorithm", "ECDH-P256")

    if not pubkey or not fingerprint:
        ws = session.get_ws(role)
        if ws:
            await _send_error(
                ws, ErrorCode.INVALID_MESSAGE,
                message="Missing public_key or fingerprint"
            )
        return

    # Валідація формату fingerprint
    if len(fingerprint) != 64:
        ws = session.get_ws(role)
        if ws:
            await _send_error(
                ws, ErrorCode.INVALID_MESSAGE,
                message="Fingerprint must be 64 hex characters (SHA-256)"
            )
        return

    # Зберігаємо ключ
    session.set_pubkey(role, pubkey, fingerprint)

    logger.info(
        f"Session {session.session_id[:8]}...: "
        f"{role.value} sent KEY_EXCHANGE (fp={fingerprint[:16]}...)"
    )

    # Ретранслюємо партнеру
    partner_ws = session.get_partner_ws(role)
    if partner_ws is not None:
        await partner_ws.send_json({
            "type": MessageType.KEY_RELAY.value,
            "public_key": pubkey,
            "fingerprint": fingerprint,
            "key_algorithm": key_algorithm,
            "from_role": role.value,
        })

    # Оновлюємо стан
    session_manager.update_state(session)


async def _handle_verification_status(
    session: SessionData, role: SessionRole, data: dict
) -> None:
    """Обробляє VERIFICATION_STATUS: зберігає статус і перевіряє обидва."""
    verified = data.get("verified", False)
    session.set_verified(role, verified)

    logger.info(
        f"Session {session.session_id[:8]}...: "
        f"{role.value} verification={'OK' if verified else 'FAILED'}"
    )

    # Ретранслюємо партнеру
    partner_ws = session.get_partner_ws(role)
    if partner_ws is not None:
        await partner_ws.send_json({
            "type": MessageType.VERIFICATION_STATUS.value,
            "verified": verified,
            "from_role": role.value,
        })

    # Перевіряємо чи обидва верифіковані
    session_manager.update_state(session)

    if session.both_verified:
        logger.info(
            f"Session {session.session_id[:8]}...: "
            f"BOTH_VERIFIED — file transfer allowed"
        )
        await _notify_both(session, {
            "type": MessageType.BOTH_VERIFIED.value,
            "session_id": session.session_id,
        })


async def _handle_file_metadata(
    session: SessionData, role: SessionRole, data: dict
) -> None:
    """Обробляє FILE_METADATA: перевіряє стан та ретранслює."""
    ws = session.get_ws(role)

    # Перевірка: ключі обмінялися?
    if not session.both_keys_exchanged:
        if ws:
            await _send_error(ws, ErrorCode.KEY_NOT_EXCHANGED)
        return

    # Перевірка: верифікація пройдена?
    if not session.both_verified:
        if ws:
            await _send_error(ws, ErrorCode.VERIFICATION_REQUIRED)
        return

    # Перевірка розміру файлу
    original_size = data.get("original_size", 0)
    if original_size > settings.max_file_size_bytes:
        if ws:
            await _send_error(
                ws, ErrorCode.PAYLOAD_TOO_LARGE,
                message=f"File size {original_size} exceeds limit "
                        f"({settings.max_file_size_bytes} bytes)"
            )
        return

    # Перевірка nonce (replay protection)
    nonce = data.get("nonce", "")
    if not session.check_nonce(nonce):
        if ws:
            await _send_error(ws, ErrorCode.INVALID_NONCE)
        return

    # Зберігаємо метадані та оновлюємо стан
    session.current_file_metadata = {
        "filename": data.get("filename", "unknown"),
        "original_size": original_size,
        "chunk_count": data.get("chunk_count", 1),
        "nonce": nonce,
        "content_type": data.get("content_type", "application/octet-stream"),
    }
    session.chunks_received = 0
    session.state = SessionState.TRANSFERRING

    logger.info(
        f"Session {session.session_id[:8]}...: "
        f"FILE_METADATA received (file={data.get('filename')}, "
        f"size={original_size}, chunks={data.get('chunk_count')})"
    )

    # Ретранслюємо партнеру (zero-trust: вміст не інтерпретується)
    partner_ws = session.get_partner_ws(role)
    if partner_ws is not None:
        await partner_ws.send_json(data)


async def _handle_file_chunk(
    session: SessionData, role: SessionRole, data: dict
) -> None:
    """
    Обробляє FILE_CHUNK: перевіряє розмір та ретранслює.

    ZERO-TRUST: сервер НЕ інтерпретує поле 'data' —
    лише перевіряє його довжину та ретранслює.
    """
    ws = session.get_ws(role)

    if session.state != SessionState.TRANSFERRING:
        if ws:
            await _send_error(ws, ErrorCode.INVALID_STATE, message="Not in TRANSFERRING state")
        return

    # Перевірка розміру payload
    chunk_data = data.get("data", "")
    if len(chunk_data) > settings.max_chunk_size_bytes:
        if ws:
            await _send_error(
                ws, ErrorCode.PAYLOAD_TOO_LARGE,
                message=f"Chunk size exceeds limit ({settings.max_chunk_size_bytes} bytes)"
            )
        return

    session.chunks_received += 1

    # Ретранслюємо (zero-trust: дані не інтерпретуються)
    partner_ws = session.get_partner_ws(role)
    if partner_ws is not None:
        await partner_ws.send_json(data)


async def _handle_file_complete(
    session: SessionData, role: SessionRole, data: dict
) -> None:
    """Обробляє FILE_COMPLETE: ретранслює auth_tag партнеру."""
    logger.info(
        f"Session {session.session_id[:8]}...: "
        f"FILE_COMPLETE (chunks_received={session.chunks_received})"
    )

    # Ретранслюємо
    partner_ws = session.get_partner_ws(role)
    if partner_ws is not None:
        await partner_ws.send_json(data)


async def _handle_file_ack(
    session: SessionData, role: SessionRole, data: dict
) -> None:
    """Обробляє FILE_ACK: підтвердження розшифрування від отримувача."""
    success = data.get("success", False)

    if success:
        session.state = SessionState.VERIFIED  # Повертаємо до VERIFIED для нового файлу
        session.current_file_metadata = None
        session.chunks_received = 0
        logger.info(
            f"Session {session.session_id[:8]}...: "
            f"FILE_ACK success — ready for next file"
        )
    else:
        error_code = data.get("error_code", "UNKNOWN")
        logger.warning(
            f"Session {session.session_id[:8]}...: "
            f"FILE_ACK failed (error={error_code})"
        )

    # Ретранслюємо
    partner_ws = session.get_partner_ws(role)
    if partner_ws is not None:
        await partner_ws.send_json(data)


async def _handle_session_close(
    session: SessionData, role: SessionRole, data: dict
) -> None:
    """Обробляє SESSION_CLOSE: закриває сесію."""
    reason = data.get("reason", "user_closed")
    logger.info(
        f"Session {session.session_id[:8]}...: "
        f"SESSION_CLOSE from {role.value} (reason={reason})"
    )
    await session_manager.close_session(session.session_id, reason=reason)


# ── Утиліти ─────────────────────────────────────────────────────────

async def _send_error(
    ws: WebSocket,
    error_code: ErrorCode,
    message: str = "",
    fatal: bool = False,
) -> None:
    """Надсилає повідомлення про помилку клієнту."""
    if not message:
        message = error_code.value.replace("_", " ").title()
    try:
        await ws.send_json(
            OutgoingError(
                error_code=error_code.value,
                message=message,
                fatal=fatal,
            ).model_dump()
        )
    except Exception:
        pass


async def _notify_both(session: SessionData, data: dict) -> None:
    """Надсилає повідомлення обом учасникам."""
    for ws in [session.initiator_ws, session.joiner_ws]:
        if ws is not None:
            try:
                await ws.send_json(data)
            except Exception:
                pass


def _get_ws_client_ip(websocket: WebSocket) -> str:
    """Отримує IP клієнта з WebSocket."""
    forwarded = websocket.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if websocket.client:
        return websocket.client.host
    return "unknown"


# ── Static Files & Join Route ───────────────────────────────────────

import os
from pathlib import Path
from fastapi.responses import FileResponse

STATIC_DIR = Path(__file__).parent.parent / "static"


@app.get("/join/{session_id}")
async def join_session_page(session_id: str):
    """Сторінка приєднання до сесії (для QR-коду)."""
    index = STATIC_DIR / "index.html"
    if index.exists():
        return FileResponse(str(index))
    return JSONResponse(
        status_code=404,
        content={"message": "Client not found. Deploy static files."},
    )


# Монтуємо статичні файли (після всіх маршрутів)
# Підтримуємо і /static/... (legacy) і /js/..., /css/... (Capacitor-сумісні)
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static-legacy")
    # Окремі маунти для підкаталогів щоб відносні шляхи працювали
    js_dir = STATIC_DIR / "js"
    css_dir = STATIC_DIR / "css"
    if js_dir.exists():
        app.mount("/js", StaticFiles(directory=str(js_dir)), name="js")
    if css_dir.exists():
        app.mount("/css", StaticFiles(directory=str(css_dir)), name="css")


@app.get("/")
async def root():
    """Головна сторінка."""
    index = STATIC_DIR / "index.html"
    if index.exists():
        return FileResponse(str(index))
    return {"message": "Secure File Transfer Relay Server", "api": "/api/health"}


@app.get("/manifest.json")
async def manifest():
    """PWA manifest."""
    f = STATIC_DIR / "manifest.json"
    if f.exists():
        return FileResponse(str(f), media_type="application/manifest+json")
    return JSONResponse(status_code=404, content={})


@app.get("/sw.js")
async def service_worker():
    """Service Worker."""
    f = STATIC_DIR / "sw.js"
    if f.exists():
        return FileResponse(str(f), media_type="application/javascript")
    return JSONResponse(status_code=404, content={})
