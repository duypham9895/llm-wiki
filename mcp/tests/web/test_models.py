import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from prd_mcp.web.models import User, Role, Permission, AppSettings


async def test_user_email_is_case_insensitive_unique(db):
    db.add(User(email="Duy@ringkas.co.id", password_hash="x"))
    await db.commit()
    db.add(User(email="duy@ringkas.co.id", password_hash="y"))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_user_status_check_constraint(db):
    db.add(User(email="a@ringkas.co.id", password_hash="x", status="bogus"))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_status_defaults_to_pending(db):
    u = User(email="b@ringkas.co.id", password_hash="x")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    assert u.status == "pending"
    assert isinstance(u.id, uuid.UUID)


async def test_app_settings_singleton_constraint(db):
    db.add(AppSettings(id=1, registration_enabled=True, allowed_domains=["ringkas.co.id"]))
    await db.commit()
    db.add(AppSettings(id=2, registration_enabled=False))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_allowed_domains_is_text_array(db):
    s = AppSettings(id=1, registration_enabled=False, allowed_domains=["ringkas.co.id", "example.com"])
    db.add(s)
    await db.commit()
    await db.refresh(s)
    assert s.allowed_domains == ["ringkas.co.id", "example.com"]
