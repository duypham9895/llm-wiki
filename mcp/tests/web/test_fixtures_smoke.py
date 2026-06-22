"""Smoke tests for Task 0.5 Phase-3 fixtures.

Verifies that the fixture graph resolves (no 'fixture not found' / import errors)
AND that the permission-scoped clients genuinely exercise the REAL require_permission
guard — using the Phase-2 admin router (guarded by users.manage), since the Phase-3
prd/chat/status routers aren't mounted until their own tasks.
"""
import pytest


async def test_perm_client_reaches_healthz(client_prd_read):
    """client_prd_read (permission-scoped client + per-client app) can hit /healthz."""
    resp = await client_prd_read.get("/healthz")
    # 200 = DB reachable; 503 = DB unavailable. Either proves the fixture resolved.
    assert resp.status_code in (200, 503)


async def test_no_perms_client_gets_real_403_from_guard(client_no_perms):
    """A user with NO permissions hits the REAL require_permission guard on a guarded
    route (admin/users requires users.manage) and gets 403 — proving the clients
    override current_user, NOT require_permission (Codex review)."""
    resp = await client_no_perms.get("/api/admin/users")
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "forbidden"


async def test_status_view_client_lacks_users_manage(client_status_view):
    """A status.view user is still forbidden from a users.manage route — confirms the
    guard checks the SPECIFIC permission, and the scoped clients carry distinct perms."""
    resp = await client_status_view.get("/api/admin/users")
    assert resp.status_code == 403


async def test_conv_id_is_non_empty_uuid(conv_id):
    """conv_id fixture resolves to a non-empty string (UUID of created Conversation)."""
    assert isinstance(conv_id, str)
    assert len(conv_id) > 0
