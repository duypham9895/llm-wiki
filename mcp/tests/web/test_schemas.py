import pytest

from prd_mcp.web.schemas import RegisterIn, validate_password
from prd_mcp.web.errors import AppError


def test_register_requires_valid_email():
    with pytest.raises(Exception):
        RegisterIn(email="not-an-email", password="x" * 12)


def test_validate_password_min_length(settings):
    with pytest.raises(AppError) as e:
        validate_password("short", settings)
    assert e.value.code == "weak_password"


def test_validate_password_max_length(settings):
    with pytest.raises(AppError):
        validate_password("x" * 129, settings)


def test_validate_password_ok(settings):
    validate_password("x" * 12, settings)  # no raise
