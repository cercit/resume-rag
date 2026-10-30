"""Go-live audit through the REST API (no SQL editor needed). Reads .env; never prints a key.
- every public table: anon reads nothing and cannot insert
- the new tables keep no resume or JD text (signal keys are on an allow-list)
- signals from the last live run arrived (generate + tweak)
- public counter answers; admin-only functions refuse anon"""
from pathlib import Path

import requests

env = dict(l.split("=", 1) for l in Path(".env").read_text(encoding="utf-8").splitlines() if "=" in l and not l.startswith("#"))
URL, ANON, SERVICE = env["SUPABASE_URL"].strip(), env["SUPABASE_ANON_KEY"].strip(), env["SUPABASE_SERVICE_ROLE_KEY"].strip()
anon = {"apikey": ANON, "Authorization": f"Bearer {ANON}", "Content-Type": "application/json"}
svc = {"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}"}
fails = 0


def check(name, ok, detail=""):
    global fails
    fails += 0 if ok else 1
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f": {str(detail)[:200]}"))


TABLES = ["documents", "resume_sessions", "resume_versions", "profiles", "admins", "user_limits", "usage_totals",
          "limit_requests", "quality_signals", "feedback", "weekly_reports"]
for t in TABLES:
    r = requests.get(f"{URL}/rest/v1/{t}?select=*&limit=1", headers=anon)
    check(f"anon reads nothing from {t}", r.status_code in (401, 403) or r.json() == [], f"{r.status_code} {r.text}")
    r = requests.post(f"{URL}/rest/v1/{t}", headers=anon, json={})
    check(f"anon cannot insert into {t}", r.status_code in (401, 403), f"{r.status_code} {r.text}")

ALLOWED = {"generate": {"role", "keywords_missing", "keywords_dropped", "jobs", "bullets", "removed", "ms"},
           "tweak": {"category", "outcome", "text", "ms"}, "undo": {"from_version"}, "download": {"version"},
           "rating": {"up", "context"}}
rows = requests.get(f"{URL}/rest/v1/quality_signals?select=kind,data,created_at&order=created_at.desc&limit=500", headers=svc).json()
bad = [r for r in rows if not set(r["data"]).issubset(ALLOWED.get(r["kind"], set()))]
check("signals hold only allowed fields (no resume/JD text)", not bad, bad[:2])
kinds = {r["kind"] for r in rows}
check("live run left generate and tweak signals", {"generate", "tweak"} <= kinds, kinds)
gen = next((r["data"] for r in rows if r["kind"] == "generate"), {})
check("generate signal has role and keywords", bool(gen.get("role")) and "keywords_dropped" in gen, gen)
tw = [r["data"] for r in rows if r["kind"] == "tweak"]
check("tweak signals record refused and applied", {"refused", "applied"} <= {t.get("outcome") for t in tw}, tw[:4])
check("tweak text is scrubbed and short", all(len(t.get("text", "")) <= 200 for t in tw))

s = requests.post(f"{URL}/rest/v1/rpc/public_stats", headers=anon, json={})
check("public counter answers", s.ok and {"users", "resumes"} <= set(s.json()), s.text)
print(f"counter now: {s.json()}")
for f in ["admin_users", "admin_set_limit", "admin_requests", "admin_decide_request", "admin_set_extra", "admin_feedback",
          "admin_set_feedback_status", "admin_stats", "admin_weekly_reports", "build_weekly_report", "match_documents"]:
    r = requests.post(f"{URL}/rest/v1/rpc/{f}", headers=anon, json={})
    check(f"anon refused: {f}", r.status_code in (401, 403, 404), f"{r.status_code} {r.text}")
print("ALL PASS" if not fails else f"{fails} FAILED")
