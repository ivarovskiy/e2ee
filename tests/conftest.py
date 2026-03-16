"""
tests/conftest.py
Спільні фікстури для всіх тестових модулів.
"""

import pytest
import pytest_asyncio


@pytest.fixture(scope="session")
def anyio_backend():
    return "asyncio"
