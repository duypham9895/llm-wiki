import time
import httpx


def _default_post(timeout):
    def post(url, headers, json_body):
        resp = httpx.post(url, headers=headers, json=json_body, timeout=timeout)
        if resp.status_code >= 400:
            err = Exception(f"http {resp.status_code}: {resp.text[:200]}")
            err.status = resp.status_code
            raise err
        return resp.json()
    return post


class LlmClient:
    def __init__(self, cfg, http_post, sleep_fn, max_retries):
        self.cfg, self.http_post, self.sleep_fn, self.max_retries = cfg, http_post, sleep_fn, max_retries

    def _retry(self, fn):
        attempt = 0
        while True:
            try:
                return fn()
            except Exception as err:
                status = getattr(err, "status", None)
                retriable = status == 429 or (isinstance(status, int) and status >= 500)
                if not retriable or attempt >= self.max_retries:
                    raise
                self.sleep_fn(min(2 ** attempt * 0.3, 5))
                attempt += 1

    def embed(self, texts):
        def call():
            data = self.http_post(
                f"{self.cfg.openai_base}/embeddings",
                {"content-type": "application/json", "authorization": f"Bearer {self.cfg.openai_key}"},
                {"model": self.cfg.embed_model, "input": texts},
            )
            return [row["embedding"] for row in data["data"]]
        return self._retry(call)

    def chat(self, messages):
        def call():
            data = self.http_post(
                f"{self.cfg.minimax_base}/chat/completions",
                {"content-type": "application/json", "authorization": f"Bearer {self.cfg.minimax_key}"},
                {"model": self.cfg.chat_model, "messages": messages, "temperature": 0.2, "stream": False},
            )
            return data["choices"][0]["message"]["content"]
        return self._retry(call)


def make_client(cfg, http_post=None, sleep_fn=time.sleep):
    timeout = getattr(cfg, "request_timeout", 60)
    return LlmClient(cfg, http_post or _default_post(timeout), sleep_fn, getattr(cfg, "max_retries", 3))
