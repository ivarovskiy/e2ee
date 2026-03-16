# ==============================================================================
# Dockerfile — Secure File Transfer Relay Server
# Multi-stage build для мінімізації розміру (ціль: < 100 МБ)
# Відповідає специфікації підрозділу 3.8.1 звіту
# ==============================================================================

# ── Stage 1: Builder ─────────────────────────────────────────────────
FROM python:3.11-slim-bookworm AS builder

WORKDIR /build

# Встановлюємо build-залежності для C-розширень (cryptography)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        gcc \
        libffi-dev \
        && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ── Stage 2: Runtime ─────────────────────────────────────────────────
FROM python:3.11-slim-bookworm AS runtime

WORKDIR /app

# Копіюємо лише скомпільовані пакети з builder
COPY --from=builder /install /usr/local

# Створюємо non-root користувача (принцип найменших привілеїв)
RUN groupadd -r appuser && useradd -r -g appuser -d /app appuser

# Копіюємо код застосунку
COPY server/ ./server/
COPY static/ ./static/
COPY run.py .

# Створюємо директорію для логів
RUN mkdir -p /app/logs && chown -R appuser:appuser /app

# Запуск від non-root
USER appuser

# Відкриваємо порт (internal)
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health')" || exit 1

# Запуск сервера
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
