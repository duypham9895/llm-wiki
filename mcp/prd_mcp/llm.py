import asyncio
import json
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

    def _default_stream_opener(self):
        def opener(url, headers, body, timeout):
            client = httpx.AsyncClient(timeout=timeout)
            return client, client.stream("POST", url, headers=headers, json=body)
        return opener

    async def chat_stream(self, messages, stream_opener=None, async_sleep=asyncio.sleep):
        url = f"{self.cfg.minimax_base}/chat/completions"
        headers = {"content-type": "application/json", "authorization": f"Bearer {self.cfg.minimax_key}"}
        body = {"model": self.cfg.chat_model, "messages": messages, "temperature": 0.2, "stream": True}
        timeout = getattr(self.cfg, "request_timeout", 60)
        opener = stream_opener or self._default_stream_opener()

        # PHASE 1 — connect with retry (NO tokens emitted yet). Retry ONLY here on
        # 429/5xx or a pre-stream connect error. Each failed attempt closes its client.
        attempt = 0
        resp = client = ctx = None
        while True:
            client, ctx = opener(url, headers, body, timeout)
            try:
                resp = await ctx.__aenter__()
            except (httpx.ConnectError, httpx.ConnectTimeout):
                await client.aclose()
                if attempt < self.max_retries:
                    await async_sleep(min(2 ** attempt * 0.3, 5))
                    attempt += 1
                    continue
                raise
            except BaseException:
                await client.aclose()  # any other open error: close, do not retry, propagate
                raise
            if resp.status_code >= 400:
                status = resp.status_code
                try:
                    await ctx.__aexit__(None, None, None)
                finally:
                    await client.aclose()
                if (status == 429 or status >= 500) and attempt < self.max_retries:
                    await async_sleep(min(2 ** attempt * 0.3, 5))
                    attempt += 1
                    continue
                raise Exception(f"http {status}")
            break  # connected with a 2xx — proceed to stream (no more retries)

        # PHASE 2 — stream tokens. No retry here; close everything in finally.
        try:
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[len("data:"):].strip()
                if data == "[DONE]":
                    break
                try:
                    delta = json.loads(data)["choices"][0]["delta"].get("content")
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue
                if delta:
                    yield delta
        finally:
            try:
                await ctx.__aexit__(None, None, None)
            finally:
                await client.aclose()


def make_client(cfg, http_post=None, sleep_fn=time.sleep):
    timeout = getattr(cfg, "request_timeout", 60)
    return LlmClient(cfg, http_post or _default_post(timeout), sleep_fn, getattr(cfg, "max_retries", 3))
