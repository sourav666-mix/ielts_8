"""Detached git commit + push. Writes output to _git_out.txt."""
import subprocess
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = open(os.path.join(ROOT, "_git_out.txt"), "w", encoding="utf-8")

def run(cmd):
    OUT.write(f"\n$ {cmd}\n")
    OUT.flush()
    r = subprocess.run(cmd, cwd=ROOT, shell=True, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=180)
    OUT.write((r.stdout or "") + (r.stderr or ""))
    OUT.flush()
    return r.returncode

try:
    run("git add -A")
    rc = run('git commit -m "Speaking: skip-speaking option (advance without completing speaking) + mic reliability fixes (suspended AudioContext, stuck gate, STT retry)"')
    if rc == 0:
        run("git push origin main")
    run("git --no-pager log --oneline -3")
    run("git status --short --branch")
finally:
    OUT.close()

import subprocess
import sys
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = open(os.path.join(ROOT, "_verify_out.txt"), "w", encoding="utf-8")

def run(cmd, cwd):
    OUT.write(f"\n$ {cmd}\n")
    OUT.flush()
    r = subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=300)
    OUT.write((r.stdout or "") + (r.stderr or ""))
    OUT.flush()
    return r.returncode

try:
    # 1 ── SSR stage render
    ssr = os.path.join(ROOT, "frontend", "_ssr_check.mjs")
    with open(ssr, "w", encoding="utf-8") as f:
        f.write("""import React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { createServer } from 'vite';
const vite = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const stages = ['ready', 'boot', 'greet', 'speaking', 'listening', 'thinking', 'gate', 'summary', 'done'];
let failed = false;
try {
  const { default: SpeakingLive } = await vite.ssrLoadModule('/src/components/speaking/SpeakingLive.jsx');
  const { default: SpeakingView } = await vite.ssrLoadModule('/src/views/SpeakingView.jsx');
  try { renderToString(React.createElement(MemoryRouter, null, React.createElement(SpeakingView))); console.log('SpeakingView: OK'); }
  catch (err) { failed = true; console.error('SpeakingView: CRASHED:', (err.stack || err.message).split('\\n').slice(0, 4).join('\\n')); }
  for (const s of stages) {
    try {
      const html = renderToString(React.createElement(MemoryRouter, null, React.createElement(SpeakingLive, { phase: 'practice', target: 6.5, initialStage: s })));
      console.log('stage ' + s + ': OK (' + html.length + ' chars)');
    } catch (err) { failed = true; console.error('stage ' + s + ': CRASHED:', (err.stack || err.message).split('\\n').slice(0, 4).join('\\n')); }
  }
} finally { await vite.close(); }
if (failed) process.exitCode = 1;
""")
    rc = run("node _ssr_check.mjs", os.path.join(ROOT, "frontend"))
    OUT.write(f"SSR exit: {rc}\n"); OUT.flush()

    # 2 ── vite build
    rc = run("npx vite build", os.path.join(ROOT, "frontend"))
    OUT.write(f"BUILD exit: {rc}\n"); OUT.flush()

    # 3 ── backend skip-aware advance (import via the backend venv python)
    venv_py = os.path.join(ROOT, "backend", ".venv", "Scripts", "python.exe")
    check = os.path.join(ROOT, "_skip_check.py")
    with open(check, "w", encoding="utf-8") as f:
        f.write(
            "import os, sys\n"
            "sys.path.insert(0, r'%s')\n"
            "os.environ.setdefault('JWT_SECRET', 'verify' * 8)\n"
            "import importlib\n"
            "os.chdir(r'%s')\n"
            "ds = importlib.import_module('app.services.day_service')\n"
            "src = open(r'%s', encoding='utf-8').read()\n"
            "print('skip branch present:', 'module_data.get(\"skipped\")' in src)\n"
            "print('empty-bands guard present:', 'Every module was skipped today' in src)\n"
            "bands = [6.0, 6.5, 7.0]\n"
            "print('overall from 3 bands (6.0,6.5,7.0):', ds.round_band(sum(bands) / len(bands)), '(expect 6.5)')\n"
            % (os.path.join(ROOT, "backend"), os.path.join(ROOT, "backend"),
               os.path.join(ROOT, "backend", "app", "services", "day_service.py"))
        )
    rc = run(f'"{venv_py}" "{check}"', ROOT)
    OUT.write(f"BACKEND CHECK exit: {rc}\n"); OUT.flush()
except Exception as exc:
    OUT.write(f"VERIFY ERROR: {exc}\n")
finally:
    OUT.close()

import io
import json
import math
import struct
import time
import urllib.request

OUT = open("_diag_out.txt", "w", encoding="utf-8")
def say(*args):
    line = " ".join(str(a) for a in args)
    print(line)
    OUT.write(line + "\n")
    OUT.flush()

BASE = "https://ielts-8.onrender.com/api"


def post_json(path, payload, token=None, timeout=120):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(), headers=headers)
    return urllib.request.urlopen(req, timeout=timeout)


def post_multipart(path, filename, filebytes, token, timeout=120):
    boundary = "----probe1234"
    body = io.BytesIO()
    body.write(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
        f"Content-Type: audio/webm\r\n\r\n".encode()
    )
    body.write(filebytes)
    body.write(f"\r\n--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        BASE + path, data=body.getvalue(),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                 "Authorization": f"Bearer {token}"},
    )
    return urllib.request.urlopen(req, timeout=timeout)


def make_wav(seconds=2.0, freq=440):
    rate = 16000
    frames = b"".join(
        struct.pack("<h", int(8000 * math.sin(2 * math.pi * freq * i / rate)))
        for i in range(int(rate * seconds))
    )
    buf = io.BytesIO()
    import wave
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(frames)
    return buf.getvalue()


try:
    token = json.loads(post_json("/auth/guest", {}).read().decode())["access_token"]
    say("guest auth OK")

    t0 = time.time()
    try:
        r = post_json("/tts", {"text": "This is a test of the speaking coach voice.", "voice": "af_heart"}, token)
        body = r.read()
        say(f"/tts: {r.status} | {r.headers.get('Content-Type')} | {len(body)} bytes | {time.time()-t0:.1f}s | RIFF={body[:4]==b'RIFF'}")
    except Exception as exc:
        say("/tts FAILED:", repr(exc)[:300])

    t0 = time.time()
    try:
        r = post_multipart("/stt", "answer.webm", make_wav(), token)
        say(f"/stt: {r.status} | {r.read().decode()[:150]} | {time.time()-t0:.1f}s")
    except Exception as exc:
        say("/stt FAILED:", repr(exc)[:300])
finally:
    OUT.close()
