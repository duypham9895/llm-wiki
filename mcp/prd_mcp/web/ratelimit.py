"""In-process rate limiting (single uvicorn worker). Per-IP token bucket +
per-email increasing-backoff counter. State is in memory and resets on restart —
accepted on a single-owner box. All methods take an explicit monotonic `now`."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class _Bucket:
    tokens: float
    last_refill: float


@dataclass
class _EmailState:
    failures: int = 0
    last_failure: float = 0.0


class RateLimiter:
    def __init__(self, per_min: int):
        self.per_min = max(1, per_min)
        self.refill_rate = self.per_min / 60.0  # tokens per second
        self._ip: dict[str, _Bucket] = {}
        self._email: dict[str, _EmailState] = {}

    def check_ip(self, ip: str, *, now: float) -> bool:
        b = self._ip.get(ip)
        if b is None:
            b = _Bucket(tokens=float(self.per_min), last_refill=now)
            self._ip[ip] = b
        # refill
        elapsed = max(0.0, now - b.last_refill)
        b.tokens = min(float(self.per_min), b.tokens + elapsed * self.refill_rate)
        b.last_refill = now
        if b.tokens >= 1.0:
            b.tokens -= 1.0
            return True
        return False

    def record_email_failure(self, email: str, *, now: float) -> None:
        st = self._email.setdefault(email.lower(), _EmailState())
        st.failures += 1
        st.last_failure = now

    def email_delay(self, email: str, *, now: float) -> float:
        st = self._email.get(email.lower())
        if st is None or st.failures < 3:
            return 0.0
        # exponential-ish backoff capped at 30s, starting after 3 consecutive failures
        return float(min(30, 2 ** (st.failures - 2)))

    def reset_email(self, email: str) -> None:
        self._email.pop(email.lower(), None)
