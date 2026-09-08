# ==============================================================
# ATLAS IELTS Academy — backend image (NO DATABASE edition)
# Dev (docker-compose.yml) overlays ./backend as /app and runs
#   uvicorn --reload
# so this image's CMD is the PRODUCTION entrypoint; dev just
# replaces it. Self-contained either way.
#
# Persistence = one JSON file (store.py, DATA_FILE env). No DB
# service, no migrations, no drivers — nothing to configure.
# ==============================================================

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Dependencies first — the layer Docker can cache.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application code (overlaid by the dev bind mount; canonical here).
COPY . .

# Non-root runtime user (created BEFORE the data dir that it must own).
RUN useradd --create-home appuser

# Writable home for the JSON store (store.py writes DATA_FILE here).
# Baked in, owned by the runtime user — works on any container host.
RUN mkdir -p /data && chown -R appuser:appuser /data
ENV DATA_FILE=/data/atlas_data.json

USER appuser

EXPOSE 8000

# JWT_SECRET arrives via environment (Render dashboard / render.yaml).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]