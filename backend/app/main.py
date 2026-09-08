"""ATLAS IELTS Academy — application assembly.

    · CORS limited to the configured frontend origin (dev is
      same-origin via the Vite proxy, so this is belt-and-braces)
    · AIError handler — Batch 10's carried obligation: every AI
      failure surfaces as a warm {detail} message at its own status
      (429 busy / 502 refused / 503 unconfigured / 504 timeout …),
      never a bare 500
    · RequestValidationError → 400 with the validator's own warm
      message when one exists (RegisterIn's copy), generic warm
      otherwise — technical pydantic strings never reach a student
    · All routers under settings.api_prefix ("/api"); docs at
      /api/docs so they're reachable through the Vite proxy too
"""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.ai.client import AIError
from app.config import settings
from app.routers import auth, content, days, history, profile, speaking, voice, writing

app = FastAPI(
    title=settings.project_name,
    version="1.0.0",
    docs_url=f"{settings.api_prefix}/docs",
    openapi_url=f"{settings.api_prefix}/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    # Comma-separated FRONTEND_ORIGIN list — the Vercel production
    # domain and its *.vercel.app preview deployments both need to
    # pass, so a single hard-coded origin is never enough in prod.
    allow_origins=[
        origin.strip()
        for origin in settings.frontend_origin.split(",")
        if origin.strip()
    ],
    allow_credentials=False,        # bearer tokens, not cookies
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(AIError)
async def ai_error_handler(request: Request, exc: AIError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"detail": exc.message})


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    message = "That request looked malformed — please refresh and try again."
    errors = exc.errors()
    if errors:
        raw = str(errors[0].get("msg", ""))
        if raw.startswith("Value error"):          # a validator's own warm copy
            message = raw.removeprefix("Value error").strip(" ,")
    return JSONResponse(status_code=400, content={"detail": message})


_prefix = settings.api_prefix
app.include_router(auth.router, prefix=_prefix)
app.include_router(profile.router, prefix=_prefix)
app.include_router(days.router, prefix=_prefix)
app.include_router(history.router, prefix=_prefix)
app.include_router(content.router, prefix=_prefix)
app.include_router(speaking.router, prefix=_prefix)
app.include_router(writing.router, prefix=_prefix)
app.include_router(voice.router, prefix=_prefix)


@app.get("/health", tags=["ops"])
async def health() -> dict:
    """Liveness for docker / load balancers — no auth, no DB touch."""
    return {"status": "ok", "project": settings.project_name, "version": "1.0.0"}