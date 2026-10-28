"""Copy only the Edge Function secrets from .env to Supabase, without printing any value.

python scripts/set_secrets.py
Writes a temp file with LLM_API_KEY, LLM_MODEL_GENERATE, LLM_MODEL_TWEAK, ALLOWED_ORIGIN,
LLM_PROVIDER=openrouter and LLM_BASE_URL, runs `npx supabase secrets set --env-file`, deletes the file.
SUPABASE_* names are never sent (Supabase injects its own into every function).
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KEYS = ["LLM_API_KEY", "LLM_MODEL_GENERATE", "LLM_MODEL_TWEAK", "ALLOWED_ORIGIN"]
FIXED = {"LLM_PROVIDER": "openrouter", "LLM_BASE_URL": "https://openrouter.ai/api/v1"}

env = {}
for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")

missing = [k for k in KEYS if not env.get(k)]
if missing:
    sys.exit(f"Missing in .env: {', '.join(missing)}")
fd, tmp = tempfile.mkstemp(suffix=".env")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        for k in KEYS:
            f.write(f"{k}={env[k]}\n")
        for k, v in FIXED.items():
            f.write(f"{k}={v}\n")
    r = subprocess.run(["npx", "--yes", "supabase", "secrets", "set", "--env-file", tmp], cwd=ROOT,
                       capture_output=True, text=True, shell=os.name == "nt")
    print("supabase secrets set:", "ok" if r.returncode == 0 else "FAILED")
    if r.returncode:
        print(r.stderr.replace(env["LLM_API_KEY"], "***")[-800:])
        sys.exit(1)
finally:
    os.remove(tmp)
print("names set:", ", ".join(KEYS + list(FIXED)))
