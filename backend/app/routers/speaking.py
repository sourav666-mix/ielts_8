"""ATLAS IELTS Academy — live Speaking Coach (§7.9).

POST /speaking/coach/stream — a Server-Sent-Events relay: the model's
reply streams out as `data:` JSON frames while it is still being
generated. The frontend speaks sentences with pipelined TTS as they
arrive, so feedback starts playing a couple of seconds after the
student stops talking instead of waiting for the whole reply.

Auth + AI relay only — normalisation stays the frontend's gatekeeper,
exactly like every other content route here.
"""

import json

from fastapi import APIRouter, Body, Depends
from fastapi.responses import StreamingResponse

from app.ai import Task
from app.ai import prompts
from app.ai.client import AIError
from app.ai.router import chat_stream_with_fallback
from app.deps import get_current_user
from app.store import User

router = APIRouter(tags=["speaking-coach"])


@router.post("/speaking/coach/stream")
async def speaking_coach_stream(
    payload: dict = Body(...),
    user: User = Depends(get_current_user),
):
    """Stream the coach's spoken feedback for one answer.

    SSE frames: {"type":"delta","text":...} · {"type":"done"} ·
    {"type":"error","detail":...}. The task reuses SPEAKING_FEEDBACK's
    chain + 115s budget — a feedback-class call, streamed.
    """
    messages = prompts.speaking_coach_messages(payload)

    async def frames():
        try:
            async for delta in chat_stream_with_fallback(
                Task.SPEAKING_FEEDBACK, messages, max_tokens=700,
            ):
                yield f"data: {json.dumps({'type': 'delta', 'text': delta}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except AIError as error:
            yield f"data: {json.dumps({'type': 'error', 'detail': error.message})}\n\n"
        except Exception:  # noqa: BLE001 — never crash the stream silently
            yield f"data: {json.dumps({'type': 'error', 'detail': 'The coach lost the thread — try that answer once more.'})}\n\n"

    return StreamingResponse(
        frames(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
