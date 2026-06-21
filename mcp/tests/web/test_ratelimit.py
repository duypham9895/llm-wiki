from prd_mcp.web.ratelimit import RateLimiter


def test_ip_bucket_allows_then_blocks():
    rl = RateLimiter(per_min=5)
    t = 1000.0
    for _ in range(5):
        assert rl.check_ip("1.2.3.4", now=t) is True
    assert rl.check_ip("1.2.3.4", now=t) is False  # 6th within the minute


def test_ip_bucket_refills_over_time():
    rl = RateLimiter(per_min=5)
    t = 1000.0
    for _ in range(5):
        rl.check_ip("1.2.3.4", now=t)
    assert rl.check_ip("1.2.3.4", now=t) is False
    assert rl.check_ip("1.2.3.4", now=t + 61) is True  # a minute later, refilled


def test_distinct_ips_have_independent_buckets():
    rl = RateLimiter(per_min=1)
    t = 1000.0
    assert rl.check_ip("1.1.1.1", now=t) is True
    assert rl.check_ip("2.2.2.2", now=t) is True  # different IP not throttled


def test_email_delay_increases_with_failures():
    rl = RateLimiter(per_min=5)
    t = 1000.0
    assert rl.email_delay("a@x.com", now=t) == 0
    for _ in range(4):
        rl.record_email_failure("a@x.com", now=t)
    assert rl.email_delay("a@x.com", now=t) > 0


def test_email_reset_clears_delay():
    rl = RateLimiter(per_min=5)
    t = 1000.0
    for _ in range(5):
        rl.record_email_failure("a@x.com", now=t)
    rl.reset_email("a@x.com")
    assert rl.email_delay("a@x.com", now=t) == 0
