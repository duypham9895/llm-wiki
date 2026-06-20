"""Single error type + the canonical error envelope {error:{code,message}}."""
from __future__ import annotations


class AppError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        self.status_code = status_code
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


def pair_error() -> AppError:
    return AppError(422, "admin_pair", "users.manage and roles.manage must be held together or not at all")


def last_admin_error() -> AppError:
    return AppError(409, "last_admin", "operation would remove the last active administrator")


def forbidden() -> AppError:
    return AppError(403, "forbidden", "insufficient permission")


def csrf_error() -> AppError:
    return AppError(403, "csrf", "missing or invalid CSRF header")


def system_role_error() -> AppError:
    return AppError(409, "system_role_immutable", "system roles cannot be modified or deleted")


def role_in_use_error() -> AppError:
    return AppError(409, "role_in_use", "role is still assigned to one or more users")


def invalid_credentials() -> AppError:
    return AppError(401, "invalid_credentials", "invalid email or password")


def unauthorized() -> AppError:
    return AppError(401, "unauthorized", "authentication required")
