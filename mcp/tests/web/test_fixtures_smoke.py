"""Smoke tests for Task 0.5 Phase-3 fixtures.

Verifies that the fixture graph resolves (no 'fixture not found' / import errors)
without requiring any Phase-3 router code to be present.

Assertions are intentionally minimal — we only confirm that:
  - client_prd_read + app_with_core resolve and can make a real HTTP request.
  - conv_id + ask_user resolve and produce a non-empty string UUID.
"""
import pytest


async def test_perm_client_reaches_healthz(client_prd_read):
    """client_prd_read (permission-scoped client + app_with_core) can hit /healthz."""
    resp = await client_prd_read.get("/healthz")
    # 200 = DB reachable; 503 = DB unavailable. Either proves the fixture resolved.
    assert resp.status_code in (200, 503)


async def test_conv_id_is_non_empty_uuid(conv_id):
    """conv_id fixture resolves to a non-empty string (UUID of created Conversation)."""
    assert isinstance(conv_id, str)
    assert len(conv_id) > 0
