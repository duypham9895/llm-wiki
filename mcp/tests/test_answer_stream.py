from prd_mcp.answer import rewrite_query


def test_rewrite_query_empty_history_returns_latest_no_llm():
    calls = []
    def chat_fn(messages):
        calls.append(messages)
        return "SHOULD NOT BE CALLED"
    assert rewrite_query([], "what is SP3K?", chat_fn) == "what is SP3K?"
    assert calls == []  # no LLM call when there's no prior context


def test_rewrite_query_uses_history_to_make_standalone():
    history = [
        {"role": "user", "content": "tell me about referral PRDs"},
        {"role": "assistant", "content": "EP-457 covers referrals..."},
    ]
    captured = {}
    def chat_fn(messages):
        captured["messages"] = messages
        return "referral bank report dashboard PRD"
    out = rewrite_query(history, "what about the bank report one?", chat_fn)
    assert out == "referral bank report dashboard PRD"
    # the prompt must include both the history and the latest follow-up
    blob = " ".join(m["content"] for m in captured["messages"])
    assert "bank report" in blob and "referral" in blob


def test_rewrite_query_blank_latest_returns_blank_no_llm():
    calls = []
    assert rewrite_query([{"role": "user", "content": "x"}], "   ", lambda m: calls.append(m) or "y") == "   "
    assert calls == []
