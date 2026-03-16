FROM python:3.11-slim-bookworm

WORKDIR /app

# Залежності
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Код сервера + статичні файли клієнта
COPY server/ ./server/
COPY static/ ./static/

# Non-root
RUN groupadd -r appuser && useradd -r -g appuser appuser
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health')"

CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
