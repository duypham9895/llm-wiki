"""Pydantic request/response shapes. Password LENGTH is enforced in endpoints via
validate_password (needs runtime settings); format/email validated here."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr

from prd_mcp.web.errors import AppError
from prd_mcp.web.settings import WebSettings


def validate_password(pw: str, settings: WebSettings) -> None:
    if not (settings.password_min_length <= len(pw) <= 128):
        raise AppError(422, "weak_password", f"password must be {settings.password_min_length}-128 characters")


class RoleBrief(BaseModel):
    id: uuid.UUID
    name: str


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    status: str
    roles: list[RoleBrief]
    permissions: list[str]
    created_at: datetime


class RoleOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    is_system: bool
    permissions: list[str]


class PermissionOut(BaseModel):
    name: str
    description: str


class RegisterIn(BaseModel):
    email: EmailStr
    password: str


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str


class SetPasswordIn(BaseModel):
    password: str


class ApproveIn(BaseModel):
    role_ids: list[uuid.UUID]


class SetRolesIn(BaseModel):
    role_ids: list[uuid.UUID]


class RoleCreateIn(BaseModel):
    name: str
    description: str = ""
    permission_ids: list[uuid.UUID]


class RoleUpdateIn(BaseModel):
    name: str | None = None
    description: str | None = None
    permission_ids: list[uuid.UUID] | None = None


class SettingsIn(BaseModel):
    registration_enabled: bool
    allowed_domains: list[str]


class SettingsOut(BaseModel):
    registration_enabled: bool
    allowed_domains: list[str]


class AcceptedOut(BaseModel):
    status: str = "accepted"
