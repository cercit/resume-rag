"""Print base/build_resume.py render() output for resume.example.json at every spacing step (JSON list)."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "base"))
import build_resume as b  # noqa: E402

d = json.loads((ROOT / "base" / "resume.example.json").read_text(encoding="utf-8"))
print(json.dumps([b.render(d, s) for s in b.STEPS]))
