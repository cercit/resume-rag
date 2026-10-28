"""Live check with a long (about 11 KB) made-up resume, the size that failed for real users.

python tests/live/long_resume_test.py
Creates a throwaway user with the admin API, calls generate once, prints status and timing, deletes the user.
Reads .env; never prints a key.
"""
import json
import secrets
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
env = {}
for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
URL, ANON, SVC = env["SUPABASE_URL"].rstrip("/"), env["SUPABASE_ANON_KEY"], env["SUPABASE_SERVICE_ROLE_KEY"]
admin = {"apikey": SVC, "Authorization": f"Bearer {SVC}", "Content-Type": "application/json"}

jobs = []
for j in range(6):
    bullets = "\n".join(
        f"- Delivered project {j}-{b}: reduced processing time for team {b} by {10 + b}% using SQL and Excel "
        f"reports for {20 + b} branch managers, and wrote the handover notes the team still uses."
        for b in range(10))
    jobs.append(f"Senior Analyst {j}, Example Company {j} Ltd, Jan 20{12 + j} - Dec 20{13 + j}, City {j}\n{bullets}")
resume = ("Test Person\nBengaluru | +91 90000 00000 | test@example.com | linkedin.com/in/test-example\n\n"
          "SUMMARY\nAnalyst with twelve years in retail lending, reporting and process improvement.\n\n"
          "EXPERIENCE\n" + "\n\n".join(jobs) +
          "\n\nPROJECTS\nLoan funnel dashboard, 2025: Power BI dashboard on 50,000 synthetic applications.\n"
          "EDUCATION\nMBA, Example School, 2010-2012\nB.Com, Example College, 2007-2010\n"
          "SKILLS\nSQL, Excel, Power BI, Python, stakeholder reporting, process design, Jira\n"
          "CERTIFICATIONS\nSQL Basics (Example Academy, 2024)\nLANGUAGES\nEnglish, Hindi, Kannada\n")
jd = ("Business Analyst, digital lending. You will build dashboards in Power BI, write SQL, run funnel analysis, "
      "report to stakeholders weekly and improve loan processes. Python is a plus.")
print(f"resume {len(resume)} chars, jd {len(jd)} chars")

email = f"rag-long-{secrets.token_hex(4)}@example.test"
pw = secrets.token_urlsafe(16)
u = requests.post(f"{URL}/auth/v1/admin/users", headers=admin, json={"email": email, "password": pw, "email_confirm": True}, timeout=30)
uid = u.json()["id"]
try:
    tok = requests.post(f"{URL}/auth/v1/token?grant_type=password", headers={"apikey": ANON, "Content-Type": "application/json"},
                        json={"email": email, "password": pw}, timeout=30).json()["access_token"]
    t0 = time.time()
    r = requests.post(f"{URL}/functions/v1/generate", headers={"apikey": ANON, "Authorization": f"Bearer {tok}"},
                      json={"resume_text": resume, "jd_text": jd}, timeout=200)
    s = time.time() - t0
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {"raw": r.text[:200]}
    if r.status_code == 200:
        res = body["resume"]
        print(f"PASS generate {r.status_code} in {s:.1f} s: {len(res['experience'])} jobs, "
              f"{sum(len(e['bullets']) for e in res['experience'])} bullets, summary {len(res['summary'])} paragraphs")
    else:
        print(f"FAIL generate {r.status_code} in {s:.1f} s: {json.dumps(body)[:300]}")
finally:
    requests.delete(f"{URL}/rest/v1/resume_sessions?user_id=eq.{uid}", headers=admin, timeout=30)
    requests.delete(f"{URL}/auth/v1/admin/users/{uid}", headers=admin, timeout=30)
    print("test user deleted")
sys.exit(0 if r.status_code == 200 else 1)
