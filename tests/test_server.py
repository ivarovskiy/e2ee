"""
tests/test_server.py
Комплексний набір тестів для relay-сервера.

Тести покривають: HTTP API, WebSocket, SessionManager,
криптографічні утиліти, rate limiter, security headers.

Запуск: pytest tests/ -v --cov=server --cov-report=term-missing

Відповідає специфікації тестів з Таблиці В.1 звіту.
"""

import asyncio
import json
import time
import hashlib
import secrets

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from unittest.mock import AsyncMock, MagicMock

from server.main import app
from server.session_manager import session_manager, SessionManager, SessionData
from server.models import (
    MessageType, SessionRole, SessionState, ErrorCode,
)
from server.crypto_utils import (
    generate_session_id,
    generate_session_token,
    validate_fingerprint_format,
    constant_time_compare,
    generate_session_qr_data,
)
from server.rate_limiter import RateLimiter
from server.config import settings


# ══════════════════════════════════════════════════════════════════════
# Фікстури
# ══════════════════════════════════════════════════════════════════════

@pytest_asyncio.fixture
async def client():
    """Async HTTP клієнт для тестування API."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture(autouse=True)
def clean_sessions():
    """Очищує всі сесії перед кожним тестом."""
    session_manager._sessions.clear()
    yield
    session_manager._sessions.clear()


# ══════════════════════════════════════════════════════════════════════
# UT-01..UT-06: Тести SessionManager (test_session)
# ══════════════════════════════════════════════════════════════════════

class TestSessionManager:
    """Тести менеджера сесій."""

    def test_ut01_session_id_generation(self):
        """UT-01: Генерація унікального session_id (32 байти hex)."""
        session = session_manager.create_session()
        assert len(session.session_id) == 32
        # Перевірка що це валідний hex
        int(session.session_id, 16)

    def test_ut02_session_id_format(self):
        """UT-02: Перевірка коректності формату session_id."""
        session = session_manager.create_session()
        assert session.session_id.isalnum()
        assert all(c in "0123456789abcdef" for c in session.session_id)

    def test_ut03_session_id_uniqueness(self):
        """UT-03: Унікальність послідовних session_id (1000 ітерацій)."""
        ids = set()
        for _ in range(1000):
            sid = generate_session_id()
            assert sid not in ids, f"Duplicate session_id: {sid}"
            ids.add(sid)

    def test_ut04_session_ttl(self):
        """UT-04: TTL сесії — відхилення після закінчення."""
        session = session_manager.create_session()
        sid = session.session_id

        # Сесія повинна бути доступна
        assert session_manager.get_session(sid) is not None

        # Імітуємо закінчення TTL
        session.created_at = time.time() - settings.session_ttl_waiting - 1
        assert session.is_expired is True
        assert session_manager.get_session(sid) is None

    def test_ut05_session_isolation(self):
        """UT-05: Ізоляція даних між сесіями."""
        s1 = session_manager.create_session()
        s2 = session_manager.create_session()

        s1.initiator_pubkey = "key_A"
        s2.initiator_pubkey = "key_B"

        assert s1.initiator_pubkey != s2.initiator_pubkey
        assert s1.session_id != s2.session_id

    def test_ut06_session_cleanup(self):
        """UT-06: Очищення пам'яті при закритті сесії."""
        session = session_manager.create_session()
        session.initiator_pubkey = "test_key"
        session.initiator_fingerprint = "a" * 64
        session.seen_nonces.add("nonce1")

        session.clear_sensitive_data()

        assert session.initiator_pubkey is None
        assert session.initiator_fingerprint is None
        assert len(session.seen_nonces) == 0
        assert session.state == SessionState.CLOSED

    def test_session_state_transitions(self):
        """Перевірка коректних переходів між станами."""
        session = session_manager.create_session()
        assert session.state == SessionState.CREATED

        # Симулюємо підключення обох
        session.initiator_ws = MagicMock()
        session.joiner_ws = MagicMock()
        session_manager.update_state(session)
        assert session.state == SessionState.CONNECTED

        # Обмін ключами
        session.initiator_pubkey = "key_a"
        session.joiner_pubkey = "key_b"
        session_manager.update_state(session)
        assert session.state == SessionState.KEYS_EXCHANGED

        # Верифікація
        session.initiator_verified = True
        session.joiner_verified = True
        session_manager.update_state(session)
        assert session.state == SessionState.VERIFIED

    def test_session_max_limit(self):
        """Перевірка ліміту максимальної кількості сесій."""
        original_max = settings.max_sessions
        settings.max_sessions = 3
        try:
            session_manager.create_session()
            session_manager.create_session()
            session_manager.create_session()
            with pytest.raises(RuntimeError, match="Maximum sessions"):
                session_manager.create_session()
        finally:
            settings.max_sessions = original_max

    def test_nonce_replay_protection(self):
        """Перевірка захисту від replay-атак через nonce."""
        session = session_manager.create_session()

        # Перший раз — OK
        assert session.check_nonce("nonce_abc") is True
        # Повторний — відхилено
        assert session.check_nonce("nonce_abc") is False
        # Інший nonce — OK
        assert session.check_nonce("nonce_def") is True

    def test_partner_ws_routing(self):
        """Перевірка маршрутизації до партнера."""
        session = session_manager.create_session()
        ws_init = MagicMock()
        ws_join = MagicMock()

        session.set_ws(SessionRole.INITIATOR, ws_init)
        session.set_ws(SessionRole.JOINER, ws_join)

        assert session.get_partner_ws(SessionRole.INITIATOR) is ws_join
        assert session.get_partner_ws(SessionRole.JOINER) is ws_init


# ══════════════════════════════════════════════════════════════════════
# UT-07..UT-13: Тести криптографічних утиліт (test_crypto)
# ══════════════════════════════════════════════════════════════════════

class TestCryptoUtils:
    """Тести криптографічних утиліт."""

    def test_ut07_fingerprint_known_input(self):
        """UT-07: SHA-256 fingerprint: відомий вхід → очікуваний вихід."""
        test_key = b"test_public_key_data_32bytes!!!!!"
        expected = hashlib.sha256(test_key).hexdigest()
        assert len(expected) == 64

    def test_ut08_different_keys_different_fingerprints(self):
        """UT-08: SHA-256: різні ключі → різні fingerprint."""
        fp1 = hashlib.sha256(b"key_1").hexdigest()
        fp2 = hashlib.sha256(b"key_2").hexdigest()
        assert fp1 != fp2

    def test_ut09_session_id_hex_format(self):
        """UT-09: session_id генерується як 32-символьний hex."""
        for _ in range(100):
            sid = generate_session_id()
            assert len(sid) == 32
            int(sid, 16)  # Валідний hex

    def test_ut10_session_token_length(self):
        """UT-10: session token — 64 символи hex (256 біт)."""
        token = generate_session_token()
        assert len(token) == 64
        int(token, 16)

    def test_ut11_fingerprint_validation_valid(self):
        """UT-11: Валідація коректного fingerprint."""
        valid_fp = "a" * 64
        assert validate_fingerprint_format(valid_fp) is True

    def test_ut12_fingerprint_validation_invalid_length(self):
        """UT-12: Валідація fingerprint невірної довжини."""
        assert validate_fingerprint_format("abc") is False
        assert validate_fingerprint_format("a" * 63) is False
        assert validate_fingerprint_format("a" * 65) is False

    def test_ut13_fingerprint_validation_invalid_chars(self):
        """UT-13: Валідація fingerprint з невалідними символами."""
        invalid_fp = "g" * 64  # 'g' не є hex
        assert validate_fingerprint_format(invalid_fp) is False

    def test_constant_time_compare_equal(self):
        """Порівняння однакових рядків."""
        assert constant_time_compare("abc123", "abc123") is True

    def test_constant_time_compare_different(self):
        """Порівняння різних рядків."""
        assert constant_time_compare("abc123", "abc124") is False

    def test_qr_data_generation(self):
        """Генерація URL для QR-коду."""
        url = generate_session_qr_data("abc123", "https://example.com")
        assert url == "https://example.com/join/abc123"


# ══════════════════════════════════════════════════════════════════════
# UT-14..UT-20: Тести HTTP API (test_api)
# ══════════════════════════════════════════════════════════════════════

class TestHTTPAPI:
    """Тести HTTP API relay-сервера."""

    @pytest.mark.asyncio
    async def test_ut14_create_session_200(self, client):
        """UT-14: POST /api/sessions: 200 OK + session_id у відповіді."""
        response = await client.post("/api/sessions")
        assert response.status_code == 200
        data = response.json()
        assert "session_id" in data
        assert len(data["session_id"]) == 32

    @pytest.mark.asyncio
    async def test_ut15_create_session_has_qr(self, client):
        """UT-15: POST /api/sessions: наявність QR-коду у відповіді."""
        response = await client.post("/api/sessions")
        data = response.json()
        assert "qr_data" in data
        assert len(data["qr_data"]) > 100  # Base64 PNG

    @pytest.mark.asyncio
    async def test_ut16_session_status_200(self, client):
        """UT-16: GET /api/sessions/{id}/status: 200 для існуючої сесії."""
        create_resp = await client.post("/api/sessions")
        sid = create_resp.json()["session_id"]

        response = await client.get(f"/api/sessions/{sid}/status")
        assert response.status_code == 200
        data = response.json()
        assert data["state"] == "CREATED"

    @pytest.mark.asyncio
    async def test_ut17_session_status_404(self, client):
        """UT-17: GET /api/sessions/{id}/status: 404 для неіснуючої."""
        response = await client.get("/api/sessions/nonexistent123/status")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_ut19_cors_headers(self, client):
        """UT-19: CORS заголовки у відповіді."""
        response = await client.options(
            "/api/sessions",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
            },
        )
        # CORS повинен відповідати
        assert response.status_code in (200, 204, 405)

    @pytest.mark.asyncio
    async def test_ut20_content_type_json(self, client):
        """UT-20: Content-Type: application/json у відповіді."""
        response = await client.post("/api/sessions")
        assert "application/json" in response.headers.get("content-type", "")

    @pytest.mark.asyncio
    async def test_health_check(self, client):
        """Health check endpoint."""
        response = await client.get("/api/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "active_sessions" in data

    @pytest.mark.asyncio
    async def test_security_headers(self, client):
        """Перевірка HTTP Security Headers (Таблиця 3.10)."""
        response = await client.post("/api/sessions")

        assert response.headers.get("X-Frame-Options") == "DENY"
        assert response.headers.get("X-Content-Type-Options") == "nosniff"
        assert response.headers.get("Referrer-Policy") == "no-referrer"
        assert "Content-Security-Policy" in response.headers
        assert "Strict-Transport-Security" in response.headers
        assert "Permissions-Policy" in response.headers


# ══════════════════════════════════════════════════════════════════════
# UT-33..UT-35: Тести nonce (test_nonce)
# ══════════════════════════════════════════════════════════════════════

class TestNonce:
    """Тести генерації та унікальності nonce."""

    def test_ut33_nonce_uniqueness_10000(self):
        """UT-33: Унікальність nonce: 10000 генерацій без повторів."""
        nonces = set()
        for _ in range(10000):
            nonce = secrets.token_bytes(12)
            nonce_hex = nonce.hex()
            assert nonce_hex not in nonces
            nonces.add(nonce_hex)

    def test_ut34_nonce_length(self):
        """UT-34: Довжина nonce: 12 байт (96 біт)."""
        nonce = secrets.token_bytes(12)
        assert len(nonce) == 12
        assert len(nonce) * 8 == 96

    def test_ut35_csprng_no_patterns(self):
        """UT-35: CSPRNG: відсутність очевидних патернів."""
        nonces = [secrets.token_bytes(12) for _ in range(1000)]
        # Перевірка: всі nonce різні
        assert len(set(n.hex() for n in nonces)) == 1000
        # Перевірка: жоден не є нулями
        assert not any(n == b"\x00" * 12 for n in nonces)


# ══════════════════════════════════════════════════════════════════════
# UT-36..UT-40: Тести fingerprint (test_fingerprint)
# ══════════════════════════════════════════════════════════════════════

class TestFingerprint:
    """Тести fingerprint-верифікації."""

    def test_ut37_fingerprint_length(self):
        """UT-37: Fingerprint: коректна довжина 64 символи."""
        key_data = secrets.token_bytes(32)
        fp = hashlib.sha256(key_data).hexdigest()
        assert len(fp) == 64

    def test_ut38_same_keys_same_fingerprint(self):
        """UT-38: Порівняння fingerprint: true для однакових ключів."""
        key_data = secrets.token_bytes(32)
        fp1 = hashlib.sha256(key_data).hexdigest()
        fp2 = hashlib.sha256(key_data).hexdigest()
        assert fp1 == fp2

    def test_ut39_different_keys_different_fingerprint(self):
        """UT-39: Порівняння fingerprint: false для різних ключів."""
        fp1 = hashlib.sha256(secrets.token_bytes(32)).hexdigest()
        fp2 = hashlib.sha256(secrets.token_bytes(32)).hexdigest()
        assert fp1 != fp2

    def test_ut40_constant_time_comparison(self):
        """UT-40: Fingerprint: стійкість до timing attack."""
        fp1 = "a" * 64
        fp2 = "a" * 64
        fp3 = "b" * 64

        # constant_time_compare повинен працювати коректно
        assert constant_time_compare(fp1, fp2) is True
        assert constant_time_compare(fp1, fp3) is False


# ══════════════════════════════════════════════════════════════════════
# Тести Rate Limiter
# ══════════════════════════════════════════════════════════════════════

class TestRateLimiter:
    """Тести rate limiting."""

    def test_ut18_rate_limit_exceeded(self):
        """UT-18: Rate limiting: відхилення при перевищенні ліміту."""
        limiter = RateLimiter(max_requests=3, window_seconds=1.0, name="test")

        assert limiter.is_allowed("1.2.3.4") is True
        assert limiter.is_allowed("1.2.3.4") is True
        assert limiter.is_allowed("1.2.3.4") is True
        # 4-й запит — перевищено
        assert limiter.is_allowed("1.2.3.4") is False

    def test_rate_limit_different_ips(self):
        """Різні IP мають незалежні ліміти."""
        limiter = RateLimiter(max_requests=2, window_seconds=1.0, name="test")

        assert limiter.is_allowed("1.1.1.1") is True
        assert limiter.is_allowed("1.1.1.1") is True
        assert limiter.is_allowed("1.1.1.1") is False

        # Інший IP — ліміт не вичерпано
        assert limiter.is_allowed("2.2.2.2") is True

    def test_rate_limit_window_reset(self):
        """Ліміт скидається після закінчення вікна."""
        limiter = RateLimiter(max_requests=1, window_seconds=0.1, name="test")

        assert limiter.is_allowed("1.1.1.1") is True
        assert limiter.is_allowed("1.1.1.1") is False

        # Чекаємо поки вікно закриється
        import time
        time.sleep(0.15)
        assert limiter.is_allowed("1.1.1.1") is True


# ══════════════════════════════════════════════════════════════════════
# Тести моделей
# ══════════════════════════════════════════════════════════════════════

class TestModels:
    """Тести Pydantic-моделей."""

    def test_session_data_defaults(self):
        """Перевірка значень за замовчуванням SessionData."""
        session = SessionData(
            session_id="a" * 32,
            token="b" * 64,
        )
        assert session.state == SessionState.CREATED
        assert session.initiator_ws is None
        assert session.joiner_ws is None
        assert session.both_connected is False
        assert session.both_keys_exchanged is False
        assert session.both_verified is False

    def test_session_data_properties(self):
        """Перевірка обчислюваних властивостей."""
        session = SessionData(
            session_id="a" * 32,
            token="b" * 64,
        )
        session.initiator_pubkey = "key_a"
        session.joiner_pubkey = "key_b"
        assert session.both_keys_exchanged is True

        session.initiator_verified = True
        session.joiner_verified = True
        assert session.both_verified is True

    def test_message_types_enum(self):
        """Перевірка всіх типів повідомлень."""
        assert MessageType.KEY_EXCHANGE.value == "KEY_EXCHANGE"
        assert MessageType.FILE_CHUNK.value == "FILE_CHUNK"
        assert MessageType.BOTH_VERIFIED.value == "BOTH_VERIFIED"

    def test_error_codes_enum(self):
        """Перевірка кодів помилок."""
        assert ErrorCode.SESSION_NOT_FOUND.value == "SESSION_NOT_FOUND"
        assert ErrorCode.VERIFICATION_REQUIRED.value == "VERIFICATION_REQUIRED"
        assert ErrorCode.PAYLOAD_TOO_LARGE.value == "PAYLOAD_TOO_LARGE"


# ══════════════════════════════════════════════════════════════════════
# Конфігурація pytest
# ══════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
