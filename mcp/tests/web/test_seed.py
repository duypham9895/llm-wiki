import pytest
from sqlalchemy import select

from prd_mcp.web import rbac, seed
from prd_mcp.web.models import User, Role, Permission
from prd_mcp.web.security import make_password_hasher


async def test_seed_is_idempotent_and_creates_admin(db, settings):
    await seed.run_seed(db, settings)
    await seed.run_seed(db, settings)  # second run must not duplicate
    perms = (await db.execute(select(Permission))).scalars().all()
    assert {p.name for p in perms} == set(rbac.PERMISSIONS)
    roles = {r.name: r for r in (await db.execute(select(Role))).scalars().all()}
    assert roles["admin"].is_system and roles["member"].is_system
    assert {p.name for p in roles["admin"].permissions} == set(rbac.PERMISSIONS)
    assert {p.name for p in roles["member"].permissions} == {"prd.read", "prd.ask"}
    admins = (await db.execute(select(User).where(User.email == settings.admin_email))).scalars().all()
    assert len(admins) == 1 and admins[0].status == "active"


async def test_break_glass_reactivates_when_no_active_admin(db, settings):
    await seed.run_seed(db, settings)
    admin = (await db.execute(select(User).where(User.email == settings.admin_email))).scalar_one()
    admin.status = "disabled"
    await db.commit()
    await seed.run_seed(db, settings)  # break-glass: no active admin -> reactivate
    await db.refresh(admin)
    assert admin.status == "active"


async def test_healthy_admin_password_not_reset(db, settings):
    await seed.run_seed(db, settings)
    admin = (await db.execute(select(User).where(User.email == settings.admin_email))).scalar_one()
    original_hash = admin.password_hash
    await seed.run_seed(db, settings)  # healthy -> untouched
    await db.refresh(admin)
    assert admin.password_hash == original_hash


async def test_global_pair_integrity_fails_on_half_admin(db, settings):
    await seed.run_seed(db, settings)
    # inject a custom role holding ONLY roles.manage and assign to an active user
    rm = (await db.execute(select(Permission).where(Permission.name == "roles.manage"))).scalar_one()
    bad = Role(name="half_admin")
    bad.permissions.append(rm)
    u = User(email="half@ringkas.co.id", password_hash="x", status="active")
    u.roles.append(bad)
    db.add(bad)
    db.add(u)
    await db.commit()
    with pytest.raises(RuntimeError) as e:
        await seed.assert_global_pair_integrity(db)
    assert "half" in str(e.value).lower() or "roles.manage" in str(e.value)


async def test_app_settings_seeded_from_env_on_first_boot(db, settings):
    from prd_mcp.web.models import AppSettings
    from sqlalchemy import select

    enabled_env = settings.model_copy(update={"registration_enabled": True, "allowed_email_domains": "ringkas.co.id"})
    await seed.run_seed(db, enabled_env)
    row = (await db.execute(select(AppSettings))).scalar_one()
    assert row.registration_enabled is True
    assert row.allowed_domains == ["ringkas.co.id"]


async def test_app_settings_not_clobbered_on_redeploy(db, settings):
    """A second boot with DIFFERENT env must NOT overwrite the existing DB row."""
    from prd_mcp.web.models import AppSettings
    from sqlalchemy import select

    first = settings.model_copy(update={"registration_enabled": True, "allowed_email_domains": "ringkas.co.id"})
    await seed.run_seed(db, first)
    # admin later turns registration OFF at runtime
    row = (await db.execute(select(AppSettings))).scalar_one()
    row.registration_enabled = False
    await db.commit()
    # redeploy with env still saying ON -> must stay OFF (DB authoritative)
    await seed.run_seed(db, first)
    row = (await db.execute(select(AppSettings))).scalar_one()
    assert row.registration_enabled is False


async def test_global_pair_integrity_fails_on_half_admin_role_with_no_user(db, settings):
    """A custom role holding exactly one admin-pair perm, assigned to NO user,
    must still fail the startup guard via the role-scan branch (the user-scan
    branch does not fire here since the role is unassigned)."""
    await seed.run_seed(db, settings)
    rm = (await db.execute(select(Permission).where(Permission.name == "roles.manage"))).scalar_one()
    half = Role(name="half_admin_unassigned")
    half.permissions.append(rm)
    db.add(half)
    await db.commit()
    with pytest.raises(RuntimeError):
        await seed.assert_global_pair_integrity(db)
