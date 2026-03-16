"""
server/config.py
Конфігурація relay-сервера через pydantic-settings / змінні середовища.
"""

from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    """Налаштування relay-сервера."""

    # --- Сервер ---
    host: str = Field(default="0.0.0.0", description="Адреса прослуховування")
    port: int = Field(default=8000, description="Порт сервера")
    debug: bool = Field(default=False, description="Режим налагодження")

    # --- Сесії ---
    session_ttl_seconds: int = Field(
        default=1800, description="TTL сесії у секундах (30 хв)"
    )
    session_ttl_waiting: int = Field(
        default=600, description="TTL для сесії без joiner (10 хв)"
    )
    max_sessions: int = Field(
        default=1000, description="Максимальна кількість одночасних сесій"
    )

    # --- Передача файлів ---
    max_file_size_bytes: int = Field(
        default=104_857_600, description="Максимальний розмір файлу (100 МБ)"
    )
    max_chunk_size_bytes: int = Field(
        default=358_400,
        description="Максимальний розмір chunk з Base64-оверхедом (~256 КБ raw)",
    )

    # --- Rate Limiting ---
    http_rate_limit: int = Field(
        default=10, description="Максимум HTTP-запитів на секунду з одного IP"
    )
    ws_connect_rate_limit: int = Field(
        default=5, description="Максимум WS-підключень на хвилину з одного IP"
    )

    # --- CORS ---
    cors_origins: list[str] = Field(
        default=["*"], description="Дозволені CORS-джерела"
    )

    # --- Логування ---
    log_level: str = Field(default="INFO", description="Рівень логування")

    model_config = {"env_prefix": "SFT_", "env_file": ".env", "extra": "ignore"}


settings = Settings()
