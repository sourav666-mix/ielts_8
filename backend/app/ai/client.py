"""ATLAS IELTS Academy — AI provider client (OpenRouter + Groq).

One HTTP layer for every model call in the product:

    chat()             OpenAI-compatible chat completions (both providers)
    transcribe_audio() Groq Whisper (§13.4) — returns the RAW transcript
    synthesize_speech() Kokoro-82M via OpenRouter audio-out (§13.1)
    generate_image()   OpenRouter Image API (§14.2)
    extract_json()     string-aware JSON recovery from model drift

Discipline, stated once:
* Every AIError message is warm and user-facing — it surfaces
  VERBATIM through Batch 11's registered exception handler.
* Retry policy: 429 respects Retry-After (capped at 20s); 5xx and
  transport errors get ONE in-client retry with backoff; read
  timeouts are NEVER retried (minutes were already spent). The AI
  ROUTER (router.py) owns cross-model fallback.
* No `response_format: json_object`: not every routed model
  guarantees support, and a hard 400 beats a soft fence. The
  prompts demand JSON-only and extract_json() handles drift
  (fences, prose wrappers, braces inside strings).
* Timeouts are set by the caller and ALIGN with the frontend's
  request timeouts (api.js: GEN 240s / GRADE 300s / TTS 180s /
  STT 120s) — the backend never keeps working after the student's
  client has already given up.
"""

import asyncio
import base64
import json
import random
import re
from typing import Any

import httpx

from app.config import settings


class AIError(Exception):
    """Warm, user-facing failure. `.status` maps to an HTTP code."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.message = message
        self.status = status


# ── Warm message constants (single source; router reuses) ─────

WARM_BUSY = "The AI is busy right now — trying again in a moment."
WARM_UNREACHABLE = "The coach is unreachable right now. Give it a moment and try again."
WARM_TIMEOUT = "That took longer than the coach allows — try again in a moment."
WARM_UNREADABLE = "The coach's answer came back unreadable — try again in a moment."
WARM_EMPTY = "The coach's answer came back blank — one more try usually sorts it."
WARM_UNPARSABLE = (
    "The coach's answer came back in a format I couldn't read — "
    "one more try usually sorts it."
)

_MAX_ATTEMPTS = 2  # total attempts per provider call


# ── Retry helpers ────────────────────────────────────────────

def _retry_after(response: httpx.Response) -> float:
    raw = response.headers.get("retry-after")
    try:
        return min(20.0, max(1.0, float(raw)))
    except (TypeError, ValueError):
        return 2.0


async def _backoff(attempt: int) -> None:
    delay = min(8.0, 1.2 * (2 ** (attempt - 1))) + random.uniform(0.0, 0.4)
    await asyncio.sleep(delay)


# ── Provider plumbing ────────────────────────────────────────

def _provider_env(provider: str) -> tuple[str, str, str]:
    """(base_url, api_key, human label) — or a warm 503 if unconfigured."""
    if provider == "groq":
        return settings.groq_base_url, settings.groq_api_key, "Groq"
    return settings.openrouter_base_url, settings.openrouter_api_key, "OpenRouter"


def _chat_headers(provider: str) -> dict[str, str]:
    base, key, label = _provider_env(provider)
    if not key:
        raise AIError(
            f"The coach needs a {label} API key — add it to .env and restart the server.",
            503,
        )
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if provider == "openrouter":
        # OpenRouter's app-attribution headers (optional, harmless, polite).
        headers["HTTP-Referer"] = "https://atlas-ielts.academy"
        headers["X-Title"] = "ATLAS IELTS Academy"
    return headers


async def _post_with_retries(
    url: str,
    *,
    headers: dict,
    read_timeout: float,
    json_payload: dict | None = None,
    files: dict | None = None,
    data: dict | None = None,
) -> dict:
    """POST with the retry policy above. Returns parsed JSON. Raises AIError."""
    timeout = httpx.Timeout(connect=10.0, read=read_timeout, write=60.0, pool=10.0)
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=timeout) as http:
                response = await http.post(
                    url, headers=headers, json=json_payload, files=files, data=data
                )
        except httpx.TimeoutException:
            raise AIError(WARM_TIMEOUT, 504)
        except httpx.TransportError:
            if attempt < _MAX_ATTEMPTS:
                await _backoff(attempt)
                continue
            raise AIError(WARM_UNREACHABLE, 503)

        status = response.status_code
        if 200 <= status < 300:
            try:
                parsed = response.json()
            except ValueError:
                raise AIError(WARM_UNREADABLE, 502)
            if not isinstance(parsed, dict):
                raise AIError(WARM_UNREADABLE, 502)
            return parsed
        if status == 429:
            if attempt < _MAX_ATTEMPTS:
                await asyncio.sleep(_retry_after(response))
                continue
            raise AIError(WARM_BUSY, 429)
        if status >= 500:
            if attempt < _MAX_ATTEMPTS:
                await _backoff(attempt)
                continue
            raise AIError(WARM_UNREACHABLE, 502)
        if status in (401, 403):
            raise AIError(
                "The coach's AI credentials were refused — check the API keys in .env.",
                502,
            )
        if status == 402:
            raise AIError(
                "The coach's AI account is out of credit — top up the provider "
                "account and try again.",
                402,
            )
        # Any other 4xx: our payload vs their API — retrying won't help.
        raise AIError(
            "The AI refused that request — try again; if it keeps happening, "
            "check the model slugs in .env.",
            400,
        )
    raise AIError(WARM_UNREACHABLE, 502)  # unreachable, kept for type-checkers


# ── Chat completions (both providers, same OpenAI shape) ──────

def _clamp_temperature(value: float) -> float:
    return max(0.0, min(2.0, float(value)))


async def chat(
    provider: str,
    model: str,
    messages: list,
    *,
    temperature: float = 0.7,
    max_tokens: int | None = None,
    read_timeout: float = 220.0,
    reasoning: dict | None = None,
) -> str:
    """One chat completion → the assistant's text content.

    `messages` is the plain OpenAI format; content may be a string
    OR a parts array (vision calls build parts in prompts.py).

    `reasoning` is OpenRouter's unified reasoning-control fragment
    (e.g. {"effort": "low"} or {"enabled": false}). It exists here
    because OpenRouter's hybrid-reasoning models silently burn
    minutes of thinking tokens by default — see router.reasoning_for
    for the per-family policy. Ignored for non-OpenRouter providers.
    """
    base, _key, _label = _provider_env(provider)
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": _clamp_temperature(temperature),
    }
    if max_tokens:
        payload["max_tokens"] = int(max_tokens)
    if reasoning and provider == "openrouter":
        payload["reasoning"] = dict(reasoning)

    data = await _post_with_retries(
        f"{base}/chat/completions",
        headers=_chat_headers(provider),
        json_payload=payload,
        read_timeout=read_timeout,
    )

    choices = data.get("choices") or []
    message = (choices[0] or {}).get("message") or {} if choices else {}
    content = message.get("content")
    if not content or not str(content).strip():
        raise AIError(WARM_EMPTY, 502)
    return str(content)


# ── Streaming chat completions (SSE, both providers) ──────────

def _status_error(status: int, body: str) -> AIError:
    """Map a provider HTTP error to the same warm messages the
    non-streaming path uses (single source of user-facing copy)."""
    if status == 429:
        return AIError(WARM_BUSY, 429)
    if status >= 500:
        return AIError(WARM_UNREACHABLE, 502)
    if status in (401, 403):
        return AIError(
            "The coach's AI credentials were refused — check the API keys in .env.",
            502,
        )
    if status == 402:
        return AIError(
            "The coach's AI account is out of credit — top up the provider "
            "account and try again.",
            402,
        )
    return AIError(
        "The AI refused that request — try again; if it keeps happening, "
        "check the model slugs in .env.",
        400,
    )


async def chat_stream(
    provider: str,
    model: str,
    messages: list,
    *,
    temperature: float = 0.7,
    max_tokens: int | None = None,
    read_timeout: float = 110.0,
    reasoning: dict | None = None,
):
    """Yield assistant text deltas from an OpenAI-compatible SSE stream.

    Raises AIError BEFORE the first delta on connection/HTTP failure —
    that's the contract that lets router.chat_stream_with_fallback try
    the next model in the chain. After deltas have flowed, a mid-stream
    drop raises too; the caller decides whether the partial text is
    still useful.
    """
    base, _key, _label = _provider_env(provider)
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": _clamp_temperature(temperature),
        "stream": True,
    }
    if max_tokens:
        payload["max_tokens"] = int(max_tokens)
    if reasoning and provider == "openrouter":
        payload["reasoning"] = dict(reasoning)

    timeout = httpx.Timeout(connect=10.0, read=read_timeout, write=60.0, pool=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as http:
            async with http.stream(
                "POST",
                f"{base}/chat/completions",
                headers=_chat_headers(provider),
                json=payload,
            ) as resp:
                if resp.status_code < 200 or resp.status_code >= 300:
                    raw = (await resp.aread()).decode("utf-8", "replace")[:400]
                    raise _status_error(resp.status_code, raw)
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data or data == "[DONE]":
                        if data == "[DONE]":
                            break
                        continue
                    try:
                        chunk = json.loads(data)
                    except ValueError:
                        continue
                    choices = chunk.get("choices") or [{}]
                    delta = (choices[0] or {}).get("delta") or {}
                    piece = delta.get("content")
                    if piece:
                        yield str(piece)
    except httpx.TimeoutException:
        raise AIError(WARM_TIMEOUT, 504)
    except httpx.TransportError:
        raise AIError(WARM_UNREACHABLE, 503)


# ── Speech-to-text — Groq Whisper (§13.4) ─────────────────────

async def transcribe_audio(
    audio: bytes,
    filename: str,
    *,
    model: str | None = None,
    read_timeout: float = 110.0,
) -> str:
    """Returns the RAW transcript — fillers preserved (§13.4);
    cleaning happens only in the AI feedback's displayed version."""
    if not settings.groq_api_key:
        raise AIError(
            "Speech-to-text needs a Groq API key — add GROQ_API_KEY to .env.",
            503,
        )
    lower = filename.lower()
    content_type = (
        "audio/mp4" if lower.endswith((".m4a", ".mp4")) else "audio/webm"
    )
    data = await _post_with_retries(
        f"{settings.groq_base_url}/audio/transcriptions",
        headers={"Authorization": f"Bearer {settings.groq_api_key}"},
        files={"file": (filename, audio, content_type)},
        data={"model": model or settings.stt_model},
        read_timeout=read_timeout,
    )
    text = (data or {}).get("text")
    if not text or not str(text).strip():
        raise AIError("Nothing was caught in that recording — try speaking again.", 422)
    return str(text)


# ── Text-to-speech — Kokoro-82M via OpenRouter (§13.1) ────────

async def synthesize_speech(
    text: str,
    voice: str,
    *,
    speed: float = 0.95,
    model: str | None = None,
    read_timeout: float = 170.0,
) -> bytes:
    """One line of speech as MP3 bytes.

    ⚠ Endpoint note (verified against the live API): Kokoro-82M on
    OpenRouter is a DEDICATED text-to-speech model served at
    `/audio/speech` (OpenAI-compatible, BINARY mp3 response) — it
    rejects chat/completions with a 400. `speed` runs 0.5–2.0; the
    0.95 default is slightly slower than natural, which reads as
    clearer for learners without sounding artificial.

    The frontend (speech.js) falls back to browser speechSynthesis
    on any failure here — a TTS outage never blocks a module (§13.5).
    """
    payload = {
        "model": model or settings.tts_model,
        "voice": voice,
        "input": text,
        "response_format": "mp3",
        "speed": max(0.5, min(2.0, float(speed))),
    }
    timeout = httpx.Timeout(connect=10.0, read=read_timeout, write=60.0, pool=10.0)
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=timeout) as http:
                response = await http.post(
                    f"{settings.openrouter_base_url}/audio/speech",
                    headers=_chat_headers("openrouter"),
                    json=payload,
                )
        except httpx.TimeoutException:
            raise AIError(WARM_TIMEOUT, 504)
        except httpx.TransportError:
            if attempt < _MAX_ATTEMPTS:
                await _backoff(attempt)
                continue
            raise AIError(WARM_UNREACHABLE, 503)

        status = response.status_code
        if 200 <= status < 300 and response.content:
            return response.content           # raw audio/mpeg bytes
        if status == 429 and attempt < _MAX_ATTEMPTS:
            await asyncio.sleep(_retry_after(response))
            continue
        if status >= 500 and attempt < _MAX_ATTEMPTS:
            await _backoff(attempt)
            continue
        if status in (401, 403):
            raise AIError(
                "The coach's AI credentials were refused — check the API keys in .env.",
                502,
            )
        if status == 402:
            raise AIError(
                "The coach's AI account is out of credit — top up the provider "
                "account and try again.",
                402,
            )
        # 4xx (bad voice/model) or an empty body — retrying won't help.
        raise AIError(
            "The coach's voice isn't available right now — the written version "
            "has everything you need.",
            502,
        )
    raise AIError(WARM_TIMEOUT, 504)  # unreachable, kept for type-checkers


# ── Image generation — OpenRouter Image API (§14.2) ───────────

async def generate_image(
    prompt: str,
    *,
    model: str | None = None,
    read_timeout: float = 110.0,
) -> str:
    """Returns an image URL (or data URL). Callers treat failure as
    'use the schematic' — never a hard dependency (§14.4)."""
    payload = {"model": model or settings.image_model, "prompt": prompt}
    data = await _post_with_retries(
        f"{settings.openrouter_base_url}/images/generations",
        headers=_chat_headers("openrouter"),
        json_payload=payload,
        read_timeout=read_timeout,
    )
    items = (data or {}).get("data") or []
    first = items[0] if items else {}
    if not isinstance(first, dict):
        first = {}
    url = first.get("url")
    if url:
        return str(url)
    b64 = first.get("b64_json")
    if b64:
        return f"data:image/png;base64,{b64}"
    raise AIError(
        "The diagram sketch didn't come back — the schematic has everything you need.",
        502,
    )


# ── JSON recovery (model drift) ──────────────────────────────

_FENCE_RE = re.compile(r"```(?:json|JSON)?\s*\n?(.*?)```", re.DOTALL)


def extract_json(content: str) -> Any:
    """Parse the model's JSON answer, tolerating drift.

    Order of attack: direct parse → code-fence body → first
    string-aware balanced JSON object/array in the text (correctly
    skipping braces and escapes INSIDE string literals — the
    failure mode of every naive brace-counter).
    """
    if content is None:
        raise AIError(WARM_EMPTY, 502)
    text = str(content).strip()
    if not text:
        raise AIError(WARM_EMPTY, 502)

    candidates: list[str] = []
    fence = _FENCE_RE.search(text)
    if fence:
        candidates.append(fence.group(1).strip())
    candidates.append(text)

    for candidate in candidates:
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except ValueError:
            pass
        scanned = _first_balanced_json(candidate)
        if scanned is not None:
            return scanned
    raise AIError(WARM_UNPARSABLE, 502)


def _first_balanced_json(text: str) -> Any | None:
    for start, opener in enumerate(text):
        if opener not in "{[":
            continue
        closer = "}" if opener == "{" else "]"
        depth = 0
        in_string = False
        escaped = False
        for i in range(start, len(text)):
            char = text[i]
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char in "{[":
                depth += 1
            elif char in "}]":
                depth -= 1
                if depth == 0:
                    if char != closer:
                        break  # mismatched bracket — try the next opener
                    try:
                        return json.loads(text[start : i + 1])
                    except ValueError:
                        break  # balanced but invalid — try the next opener
    return None