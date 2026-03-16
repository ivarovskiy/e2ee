"""
run.py — точка входу для запуску relay-сервера.

Використання:
    python run.py
    або
    uvicorn server.main:app --host 0.0.0.0 --port 8000 --reload
"""

import uvicorn
from server.config import settings

if __name__ == "__main__":
    uvicorn.run(
        "server.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
        log_level=settings.log_level.lower(),
    )
