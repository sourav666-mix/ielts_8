"""ATLAS IELTS Academy — day-record persistence (§10.2) and the
SERVER-AUTHORITATIVE §2.3 ADVANCE.

Advance is the one place the tricky rules live, exactly as the
frontend's stores assume (File 18 adopts the results wholesale):

    1. All four modules must report status 'done' (409 otherwise).
    2. Module bands → overall via mean + the §9.4 IELTS rounding
       rule (mirrored from frontend scoring.js — verified eighths
       by eighths below).
    3. History entry appended (idempotent upsert by user/phase/day).
    4. Streak: +1 if the last completed date was the calendar day
       before, else 1 (UTC calendar — documented: the server can't
       know the student's local timezone; internally consistent
       because only the server writes streak).
    5. Rollover: Practice Day 150 → Mock Day 1; Mock Day 120 →
       status 'complete' (no next day; the final record is returned
       so the frontend's adoptDay(res.day) always has a day).
    6. The next day's record is created fresh (reset if a stale
       row somehow exists).
"""

import math
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from app.schemas import DayRecordData
from app.services import history_service
from app.services.profile_service import profile_to_dict
from app.store import (
    DayRecord,
    User,
    day_records_create,
    day_records_find,
    profiles_find_by_user,
    save,
)

PHASE_LENGTHS = {"practice": 150, "mock": 120}
MODULES = ("reading", "listening", "writing", "speaking")
_MODULE_LABELS = {
    "reading": "Reading",
    "listening": "Listening",
    "writing": "Writing",
    "speaking": "Speaking",
}


# ── §10.2 record shape (mirror of the frontend's makeDayRecord) ──

def _fresh_module() -> dict:
    return {"status": "todo", "content": None, "answers": {}, "score": None, "timeSpentSec": 0}


def fresh_day_record(phase: str, day: int) -> dict:
    return {
        "phase": phase,
        "day": day,
        "reading": _fresh_module(),
        "listening": _fresh_module(),
        "writing": {
            "status": "todo",
            "content": None,
            "task1": {"text": "", "file": None, "feedback": None, "modelAnswer": None},
            "task2": {"text": "", "file": None, "feedback": None},
            "score": None,
            "timeSpentSec": 0,
        },
        "speaking": {
            "status": "todo",
            "content": None,
            "sessionStartedAt": None,
            "timeSpentSec": 0,
            "rounds": [],
            "score": None,
        },
    }


# ── Reads / writes ───────────────────────────────────────────

def get_or_create_day(user_id: int, phase: str, day: int) -> DayRecord:
    """Creation persists immediately — a GET that creates must save."""
    row = day_records_find(user_id, phase, day)
    if row is None:
        row = day_records_create(user_id, phase, day, fresh_day_record(phase, day))
    return row


def _is_dirty(record: dict) -> bool:
    for module in MODULES:
        module_data = (record or {}).get(module) or {}
        if module_data.get("status") != "todo":
            return True
        if module_data.get("content") not in (None, {}):
            return True
    return False


def _ensure_fresh_day(user_id: int, phase: str, day: int) -> DayRecord:
    """Create-or-reset — the NEXT day must always start clean (the caller
    persists via the advance's single save())."""
    row = day_records_find(user_id, phase, day)
    if row is None:
        row = day_records_create(user_id, phase, day, fresh_day_record(phase, day))
    elif _is_dirty(row.record):
        row.record = fresh_day_record(phase, day)
    return row


def put_day(user_id: int, phase: str, day: int, data: DayRecordData) -> dict:
    """Envelope-validated full-record write. model_dump(by_alias=True)
    preserves every camelCase extra (content, answers, warmupsDone,
    plays, modelAnswer, speaking rounds…)."""
    if data.phase != phase or data.day != day:
        raise HTTPException(
            status_code=409,
            detail=(
                "Your day record and today's programme disagree — refresh the page "
                "and it usually sorts itself out."
            ),
        )
    row = get_or_create_day(user_id, phase, day)
    payload = data.model_dump(by_alias=True)
    row.record = payload  # fresh assignment — mutation discipline
    save()
    return payload


# ── §9.4 band math (mirrors frontend scoring.js roundBand) ────

def round_band(avg: float) -> float:
    """The IELTS rounding rule: an average ending in exactly .25 rounds
    UP to the next half band; exactly .75 rounds UP to the next whole
    band; every other fractional value rounds to the nearest half.

    remainder in eighths →  0   1   2   3   4   5   6   7
    band adjustment      → +0  +0  +.5 +.5 +.5 +.5  +1  +1
    """
    value = float(avg)
    if not math.isfinite(value):
        raise HTTPException(status_code=409, detail="That score couldn't be averaged.")
    floor_value = math.floor(value)
    eighths = round((value - floor_value) * 8)
    if eighths >= 8:  # float-noise guard (6.9999…)
        return min(9.0, floor_value + 1.0)
    adjustment = 0.0 if eighths <= 1 else 0.5 if eighths <= 5 else 1.0
    return max(0.0, min(9.0, floor_value + adjustment))


def _utc_today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _utc_yesterday() -> str:
    return (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")


def _join_and(items: list[str]) -> str:
    clean = [item for item in items if item]
    if not clean:
        return ""
    if len(clean) == 1:
        return clean[0]
    return ", ".join(clean[:-1]) + " and " + clean[-1]


# ── §2.3 ADVANCE — the single authoritative transition ───────

def advance_day(user: User) -> dict:
    """Server-authoritative §2.3 advance → {profile, day, history} (File 18 adopts all three).
    Database-free: profile rides on user.profile; one save() at the end persists."""
    profile = user.profile
    if profile is None:
        raise HTTPException(
            status_code=409,
            detail="Your profile isn't set up yet — finish onboarding first.",
        )
    if profile.status == "complete":
        raise HTTPException(
            status_code=409,
            detail=(
                "The programme is already complete — 270 days, start to finish. "
                "There's nothing left to advance."
            ),
        )

    phase, day = profile.phase, profile.day
    row = day_records_find(user.id, phase, day)
    record = row.record if row is not None else None
    if not record:
        raise HTTPException(
            status_code=409,
            detail="Today's sections haven't been started yet — there's nothing to hand in.",
        )

    # 1 ── the four-done gate (§2.3)
    pending = [
        _MODULE_LABELS[module]
        for module in MODULES
        if ((record.get(module) or {}).get("status")) != "done"
    ]
    if pending:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{_join_and(pending)} still to finish — complete all four and "
                "tomorrow unlocks. Your progress is saved, so you can leave and come back."
            ),
        )

    # 2 ── module bands → overall (§9.4). A module the student SKIPPED
    #    (status done, `skipped: true`, no band) contributes nothing and
    #    is excluded from the average; at least one scored module is
    #    still required to advance.
    bands: dict[str, float] = {}
    for module in MODULES:
        module_data = record.get(module) or {}
        if module_data.get("skipped"):
            continue
        band = (module_data.get("score") or {}).get("band")
        if not isinstance(band, (int, float)):
            raise HTTPException(
                status_code=409,
                detail=(
                    f"{_MODULE_LABELS[module]} is marked complete but has no stored "
                    "score — re-open it and submit again. Your work is safe."
                ),
            )
        bands[module] = float(band)
    if not bands:
        raise HTTPException(
            status_code=409,
            detail=(
                "Every module was skipped today — complete at least one "
                "module to move to the next day."
            ),
        )
    overall = round_band(sum(bands.values()) / len(bands))

    # 3 ── streak (UTC calendar — see module docstring)
    today = _utc_today()
    if profile.last_completed_date == today:
        new_streak = max(1, profile.streak)
    elif profile.last_completed_date == _utc_yesterday():
        new_streak = profile.streak + 1
    else:
        new_streak = 1

    # 4 ── history append (idempotent; persists immediately)
    history_service.append_entry(
        user.id,
        phase=phase,
        day=day,
        date=today,
        reading=bands["reading"],
        listening=bands["listening"],
        writing=bands["writing"],
        speaking=bands["speaking"],
        overall=overall,
        weak_areas=profile.weak_area_profile or None,
    )

    # 5 ── rollover (§2.3)
    if phase == "practice" and day >= PHASE_LENGTHS["practice"]:
        new_phase, new_day, completed = "mock", 1, False
    elif phase == "mock" and day >= PHASE_LENGTHS["mock"]:
        new_phase, new_day, completed = "mock", day, True
    else:
        new_phase, new_day, completed = phase, day + 1, False

    profile.status = "complete" if completed else "active"
    profile.phase = new_phase
    profile.day = new_day
    profile.streak = new_streak
    profile.last_completed_date = today

    # 6 ── the next day's fresh record (the final day keeps its record)
    if completed:
        final_row = row
    else:
        final_row = _ensure_fresh_day(user.id, new_phase, new_day)

    save()   # profile mutations + (possibly reset) next-day record

    # File 18's advanceDay adopts exactly this shape.
    return {
        "profile": profile_to_dict(profile),
        "day": final_row.record,
        "history": history_service.list_entries(user.id),
    }