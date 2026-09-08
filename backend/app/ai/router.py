"""ATLAS IELTS Academy — AI model routing (spec §12.1/§12.3).

Every AI call resolves through here: task → ordered model chain →
client.chat. Chains implement §12.1's two-provider resilience —
primary first, then a fallback, deliberately CROSS-PROVIDER where
sensible so one vendor outage can't take down a whole module.

DEADLINE BUDGETS: each task carries a whole-request budget aligned
to (just under) the frontend's request timeouts, so the fallback
chain only spends time the student's client is still willing to
wait for:

    task class          frontend timeout   backend budget
    ───────────────     ─────────────────  ──────────────
    generation (§4/5)   240s               230s
    writing grade       300s               290s
    insight/model       240s               230s
    speaking feedback   240s               115s
    vision              (inner step)       170s
    warmup              240s               115s

Read timeouts are per-call; if the primary fails FAST (bad key,
4xx, quick 5xx) the fallback gets its full shot; if it fails
slowly, the last honest error surfaces.
"""

import time
from dataclasses import dataclass
from enum import Enum
from typing import Any

from app.ai import client
from app.ai.client import AIError
from app.config import settings

# §12.3's named Groq fallback (open-weight, LPU-fast).
# ⚠ llama-3.3-70b-versatile was RETIRED from Groq's catalogue (verified
# against GET /openai/v1/models) — every chain that fell back to it
# ended in a 400. gpt-oss-120b is its current equivalent (verified 200).
GROQ_FALLBACK_MODEL = "openai/gpt-oss-120b"


class Task(str, Enum):
    READING_GEN = "reading_gen"
    READING_QA = "reading_qa"
    READING_INSIGHT = "reading_insight"
    LISTENING_GEN = "listening_gen"
    LISTENING_QA = "listening_qa"
    WRITING_GEN = "writing_gen"
    WRITING_GRADE = "writing_grade"
    WRITING_VISION = "writing_vision"
    WRITING_MODEL = "writing_model"
    SPEAKING_GEN = "speaking_gen"
    SPEAKING_FEEDBACK = "speaking_feedback"
    WARMUP = "warmup"


@dataclass(frozen=True)
class ModelRoute:
    provider: str  # "openrouter" | "groq"
    model: str


def _or(model: str) -> ModelRoute:
    return ModelRoute("openrouter", model)


def _gq(model: str) -> ModelRoute:
    return ModelRoute("groq", model)


# ── §12.3 routing table ──────────────────────────────────────

def model_chain(task: Task, *, targeted: bool = False) -> list[ModelRoute]:
    s = settings
    if task is Task.READING_QA and targeted:
        # §12.3: stronger reasoning when the day precisely targets a weakness
        chain = [_or(s.model_reading_qa_targeted), _or(s.model_fallback)]
    else:
        chain = {
            Task.READING_GEN: [_or(s.model_reading_gen), _or(s.model_fallback)],
            Task.READING_QA: [_or(s.model_reading_qa), _gq(GROQ_FALLBACK_MODEL)],
            Task.READING_INSIGHT: [_or(s.model_reading_insight), _or(s.model_writing_grade)],
            Task.LISTENING_GEN: [_or(s.model_listening_gen), _or(s.model_reading_gen)],
            Task.LISTENING_QA: [_or(s.model_listening_qa), _gq(GROQ_FALLBACK_MODEL)],
            Task.WRITING_GEN: [_or(s.model_writing_gen), _or(s.model_listening_gen)],
            Task.WRITING_GRADE: [_or(s.model_writing_grade), _or(s.model_reading_insight)],
            Task.WRITING_VISION: [_or(s.model_writing_vision), _or(s.model_fallback)],
            Task.WRITING_MODEL: [_or(s.model_writing_grade), _or(s.model_listening_gen)],
            Task.SPEAKING_GEN: [_or(s.model_speaking_gen), _gq(GROQ_FALLBACK_MODEL)],
            Task.SPEAKING_FEEDBACK: [_or(s.model_speaking_feedback), _or(s.model_listening_gen)],
            Task.WARMUP: [_or(s.model_reading_qa), _gq(GROQ_FALLBACK_MODEL)],
        }[task]

    # Dedupe preserving order (guards against someone configuring
    # the same slug as both primary and fallback).
    seen: set[tuple[str, str]] = set()
    unique: list[ModelRoute] = []
    for route in chain:
        key = (route.provider, route.model)
        if key not in seen:
            seen.add(key)
            unique.append(route)
    return unique


# ── Per-task parameters ──────────────────────────────────────

TASK_TEMPERATURES: dict[Task, float] = {
    Task.READING_GEN: 0.8,
    Task.READING_QA: 0.5,
    Task.READING_INSIGHT: 0.5,
    Task.LISTENING_GEN: 0.85,
    Task.LISTENING_QA: 0.5,
    Task.WRITING_GEN: 0.7,
    Task.WRITING_GRADE: 0.2,
    Task.WRITING_VISION: 0.1,
    Task.WRITING_MODEL: 0.7,
    Task.SPEAKING_GEN: 0.85,
    Task.SPEAKING_FEEDBACK: 0.3,
    Task.WARMUP: 0.6,
}

TASK_READ_TIMEOUTS: dict[Task, float] = {
    Task.READING_GEN: 230.0,
    Task.READING_QA: 230.0,
    Task.READING_INSIGHT: 115.0,
    Task.LISTENING_GEN: 230.0,
    Task.LISTENING_QA: 230.0,
    Task.WRITING_GEN: 175.0,
    Task.WRITING_GRADE: 290.0,
    Task.WRITING_VISION: 170.0,
    Task.WRITING_MODEL: 230.0,
    Task.SPEAKING_GEN: 115.0,
    Task.SPEAKING_FEEDBACK: 115.0,
    Task.WARMUP: 115.0,
}

TASK_DEADLINES: dict[Task, float] = {
    Task.READING_GEN: 230.0,
    Task.READING_QA: 230.0,
    Task.READING_INSIGHT: 230.0,
    Task.LISTENING_GEN: 230.0,
    Task.LISTENING_QA: 230.0,
    Task.WRITING_GEN: 230.0,
    Task.WRITING_GRADE: 290.0,
    Task.WRITING_VISION: 170.0,
    Task.WRITING_MODEL: 230.0,
    Task.SPEAKING_GEN: 230.0,
    Task.SPEAKING_FEEDBACK: 115.0,
    Task.WARMUP: 115.0,
}


# ── Reasoning-token policy (latency discipline) ──────────────
#
# OpenRouter's hybrid-reasoning models ship DANGEROUS defaults for
# this product: z-ai/glm-5.3-flash reasons at effort "max" by
# default (mandatory — it cannot be switched off), deepseek-v4
# defaults to "high", qwen3.7 defaults on, gemini 3.6/3.8 default
# on. Left alone, one Reading generation measured 228s and
# Listening generation blew straight through its 230s whole-request
# budget → the student's client gave up first (240s) and every
# module open looked broken. Each family therefore gets an explicit
# budget-safe setting, honoured only where the model allows it:
#   deepseek/*, qwen/*  → reasoning OFF (not mandatory on these)
#   z-ai/glm-5.3-flash  → effort "low" (its minimum; reasoning is
#                         mandatory on this family)
#   google/*, openai/*  → effort "low"
# Groq models are plain instruct models — no fragment needed.

def reasoning_for(model: str) -> dict | None:
    m = (model or "").lower()
    if m.startswith("deepseek/") or m.startswith("qwen/"):
        return {"enabled": False}
    if m.startswith("z-ai/") or m.startswith("google/") or m.startswith("openai/"):
        return {"effort": "low"}
    return None


# ── The entry points Batches 11's routers call ───────────────

async def chat_with_fallback(
    task: Task,
    messages: list,
    *,
    targeted: bool = False,
    temperature: float | None = None,
    max_tokens: int | None = None,
    read_timeout: float | None = None,
    deadline_s: float | None = None,
    json_mode: bool = False,
) -> Any:
    chain = model_chain(task, targeted=targeted)
    temp = TASK_TEMPERATURES.get(task, 0.7) if temperature is None else temperature
    default_read = TASK_READ_TIMEOUTS.get(task, 220.0)
    end = time.monotonic() + (
        deadline_s if deadline_s is not None else TASK_DEADLINES.get(task, 220.0)
    )

    last_error: AIError | None = None
    for index, route in enumerate(chain):
        if index > 0:
            remaining = end - time.monotonic()
            if remaining < 20.0:
                # No room for a meaningful fallback attempt — surface the
                # primary's honest failure instead of burning the budget.
                raise last_error or AIError(client.WARM_TIMEOUT, 504)
        read = read_timeout if read_timeout is not None else default_read
        read = min(read, max(20.0, end - time.monotonic()))
        try:
            content = await client.chat(
                route.provider,
                route.model,
                messages,
                temperature=temp,
                max_tokens=max_tokens,
                read_timeout=read,
                reasoning=reasoning_for(route.model),
            )
            # json_mode parses INSIDE the loop: a model that answers HTTP
            # 200 with unreadable JSON burns its own attempt and the next
            # chain entry gets its full shot — identical to any other
            # failure. (Parsing used to sit AFTER the loop, so one model's
            # format drift failed the whole request even with a healthy
            # fallback sitting right there in the chain.)
            return client.extract_json(content) if json_mode else content
        except AIError as error:
            last_error = error
            continue

    raise last_error or AIError(client.WARM_UNREACHABLE, 502)


async def chat_json_with_fallback(
    task: Task,
    messages: list,
    **kwargs: Any,
) -> Any:
    """chat + robust JSON extraction — the shape every content router uses."""
    return await chat_with_fallback(task, messages, json_mode=True, **kwargs)


async def chat_stream_with_fallback(
    task: Task,
    messages: list,
    *,
    targeted: bool = False,
    temperature: float | None = None,
    max_tokens: int | None = None,
    read_timeout: float | None = None,
):
    """Streaming twin of chat_with_fallback: yields text deltas.

    Fallback contract — a route that fails BEFORE its first delta
    (bad key, 4xx, quick 5xx, connect timeout) burns its attempt and
    the next chain entry gets its full shot. Once deltas are flowing,
    a mid-stream drop is surfaced to the caller (the partial text is
    usually still worth keeping on screen).
    """
    chain = model_chain(task, targeted=targeted)
    temp = TASK_TEMPERATURES.get(task, 0.7) if temperature is None else temperature
    default_read = TASK_READ_TIMEOUTS.get(task, 110.0)

    last_error: AIError | None = None
    for route in chain:
        read = read_timeout if read_timeout is not None else default_read
        stream = client.chat_stream(
            route.provider,
            route.model,
            messages,
            temperature=temp,
            max_tokens=max_tokens,
            read_timeout=read,
            reasoning=reasoning_for(route.model),
        )
        try:
            first = await stream.__anext__()
        except StopAsyncIteration:
            return                     # clean empty stream — treat as done
        except AIError as error:
            last_error = error
            continue
        yield first
        try:
            async for piece in stream:
                yield piece
            return
        except AIError:
            # Mid-stream drop: the partial answer stands; a soft notice
            # keeps the spoken flow natural rather than erroring out.
            yield " The connection dipped just there — everything above still stands."
            return

    raise last_error or AIError(client.WARM_UNREACHABLE, 502)