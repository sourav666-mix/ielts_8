"""ATLAS IELTS Academy — voice routes (spec §13).

/tts  Kokoro-82M via OpenRouter → raw audio/mpeg bytes
      (File 14 requests a blob; the frontend's speech.js falls back
      to browser speechSynthesis on failure — a TTS outage never
      blocks a module, §13.5).
/stt  Groq Whisper → {text}, the RAW transcript (fillers preserved,
      §13.4 — cleaning happens only in the AI's displayed version).
"""

import re

from fastapi import APIRouter, Body, Depends, File, UploadFile
from fastapi.responses import Response

from app.ai.client import AIError, synthesize_speech, synthesize_speech_gpt_audio, transcribe_audio
from app.deps import get_current_user
from app.store import User

router = APIRouter(tags=["voice"])

# Kokoro voice IDs look like af_heart / bm_george — this both validates
# and keeps arbitrary strings out of the provider payload.
_VOICE_RE = re.compile(r"^[ab][fm]_[a-z0-9]+$")

MAX_TTS_CHARS = 2000        # one transcript line / question / cue card
MAX_STT_BYTES = 25 * 1024 * 1024   # Whisper's own upload ceiling


@router.post("/tts")
async def tts(
    payload: dict = Body(...),
    user: User = Depends(get_current_user),
) -> Response:
    text = str(payload.get("text") or "").strip()
    voice = str(payload.get("voice") or "").strip()
    raw_speed = payload.get("speed")
    try:
        speed = float(raw_speed) if raw_speed is not None else 0.95
    except (TypeError, ValueError):
        speed = 0.95
    speed = max(0.5, min(2.0, speed))
    if not text:
        raise AIError("Nothing to say there — try again.", 400)
    if len(text) > MAX_TTS_CHARS:
        text = text[:MAX_TTS_CHARS]
    if not _VOICE_RE.match(voice):
        raise AIError("That voice isn't available — reload the page and try again.", 400)

    # Preferred engine: openai/gpt-audio-mini via OpenRouter — a far more
    # natural voice than Kokoro, streamed pcm16 → WAV (verified live:
    # first audio ~1.1s). ANY failure falls back to Kokoro silently:
    # a TTS outage never blocks a module (§13.5).
    try:
        wav = await synthesize_speech_gpt_audio(text, voice, read_timeout=45)
        return Response(content=wav, media_type="audio/wav")
    except AIError:
        pass

    audio = await synthesize_speech(text, voice, speed=speed)
    return Response(content=audio, media_type="audio/mpeg")


@router.post("/stt")
async def stt(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
) -> dict:
    raw = await file.read()
    if not raw:
        raise AIError("That recording came through empty — try speaking again.", 422)
    if len(raw) > MAX_STT_BYTES:
        raise AIError("That recording is too long to transcribe — try a shorter one.", 413)

    filename = file.filename or "answer.webm"
    text = await transcribe_audio(raw, filename)
    return {"text": text}