"""Live check of 0004_feedback.sql with throwaway users (created and deleted with the admin API).
A test admin email is added to public.admins for the run and removed after. Reads .env; never prints a key.
Checks: public counter, daily limit then request more, admin approves a changed number, extra resumes used,
feedback rules, signals, admin feedback view, weekly numbers, and that normal users and anon are refused."""
import secrets
from pathlib import Path

import requests

env = dict(l.split("=", 1) for l in Path(".env").read_text(encoding="utf-8").splitlines() if "=" in l and not l.startswith("#"))
URL, ANON, SERVICE = env["SUPABASE_URL"].strip(), env["SUPABASE_ANON_KEY"].strip(), env["SUPABASE_SERVICE_ROLE_KEY"].strip()
admin = {"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}", "Content-Type": "application/json"}
anon = {"apikey": ANON, "Authorization": f"Bearer {ANON}", "Content-Type": "application/json"}
fails = 0


def check(name, ok, detail=""):
    global fails
    fails += 0 if ok else 1
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f": {str(detail)[:300]}"))


def make_user(email):
    pw = secrets.token_urlsafe(16)
    uid = requests.post(f"{URL}/auth/v1/admin/users", headers=admin, json={"email": email, "password": pw, "email_confirm": True}).json()["id"]
    t = requests.post(f"{URL}/auth/v1/token?grant_type=password", headers={"apikey": ANON}, json={"email": email, "password": pw}).json()
    return uid, {"apikey": ANON, "Authorization": f"Bearer {t['access_token']}", "Content-Type": "application/json"}


def rpc(h, name, body=None):
    return requests.post(f"{URL}/rest/v1/rpc/{name}", headers=h, json=body or {})


def code(r):
    try:
        return r.json().get("message") or r.json().get("code")
    except Exception:
        return r.text


tag = secrets.token_hex(4)
admin_email = f"admin-test-{tag}@test.local"
users = []
try:
    before = rpc(anon, "public_stats")
    check("anon reads public_stats", before.ok and "users" in before.json(), before.text)
    for name in ["my_allowance", "request_more", "submit_feedback", "record_signal", "admin_stats", "admin_requests", "admin_feedback", "admin_weekly_reports", "build_weekly_report"]:
        r = rpc(anon, name)
        check(f"anon refused: {name}", r.status_code in (401, 403, 404), f"{r.status_code} {r.text}")

    requests.post(f"{URL}/rest/v1/admins", headers=admin, json={"email": admin_email})
    u, hu = make_user(f"user-test-{tag}@test.local"); users.append(u)
    a, ha = make_user(admin_email); users.append(a)

    sids = [rpc(hu, "start_session", {"p_jd": "test jd", "p_profile": {}}).json() for _ in range(3)]
    r = rpc(hu, "start_session", {"p_jd": "test jd", "p_profile": {}})
    check("4th resume refused (daily_session_limit)", code(r) == "daily_session_limit", r.text)
    al = rpc(hu, "my_allowance").json()
    check("allowance shows 0 left", al.get("left") == 0 and al.get("daily_limit") == 3, al)
    r = rpc(hu, "request_more", {"p_requested": 5, "p_reason": "live test"})
    check("request for 5 sent", r.ok, r.text)
    r = rpc(hu, "request_more", {"p_requested": 2})
    check("second pending request refused", code(r) == "request_pending", r.text)
    r = rpc(hu, "admin_requests", {"p_status": "pending"})
    check("user cannot list requests", r.json().get("code") == "42501", r.text)

    reqs = rpc(ha, "admin_requests", {"p_status": "pending"}).json()
    mine = [x for x in reqs if x["user_id"] == u]
    check("admin sees the request", len(mine) == 1 and mine[0]["requested"] == 5, reqs)
    d = rpc(ha, "admin_decide_request", {"p_id": mine[0]["id"], "p_approve": True, "p_granted": 2}).json()
    check("admin approves 2 instead of 5", d.get("status") == "approved" and d.get("extra") == 2, d)
    al = rpc(hu, "my_allowance").json()
    check("user now has 2 left, decision shown", al.get("left") == 2 and al.get("last_decision", {}).get("granted") == 2, al)
    check("my_daily_limit = 3 + 2 for the edge check", rpc(hu, "my_daily_limit").json() == 5)
    ok_extra = all(rpc(hu, "start_session", {"p_jd": "test jd", "p_profile": {}}).ok for _ in range(2))
    r = rpc(hu, "start_session", {"p_jd": "test jd", "p_profile": {}})
    check("2 extra resumes used, then refused", ok_extra and code(r) == "daily_session_limit", r.text)
    after = rpc(anon, "public_stats").json()
    check("public counter went up by 1 person and 5 resumes",
          after["users"] == before.json()["users"] + 1 and after["resumes"] == before.json()["resumes"] + 5, (before.json(), after))

    r = rpc(hu, "submit_feedback", {"p_kind": "bug", "p_message": "Live test: PDF cut off", "p_rating": 3, "p_context": "after_generate", "p_session": sids[0]})
    check("feedback saved", r.ok, r.text)
    r = rpc(hu, "submit_feedback", {"p_kind": "bug", "p_message": "hey"})
    check("too-short feedback refused", code(r) == "feedback_length", r.text)
    r = requests.get(f"{URL}/rest/v1/feedback?select=id", headers=hu)
    check("user cannot read the feedback table", r.status_code in (401, 403) or r.json() == [], r.text)
    r = rpc(hu, "record_signal", {"p_kind": "generate", "p_session": sids[0],
                                  "p_data": {"role": "live test role", "keywords_dropped": ["Power BI"], "keywords_missing": ["Power BI"], "ms": 1000}})
    check("signal saved", r.ok, r.text)
    rpc(hu, "record_signal", {"p_kind": "download", "p_session": sids[0], "p_data": {}})
    r = rpc(hu, "record_signal", {"p_kind": "hack"})
    check("bad signal kind refused", code(r) == "bad_signal", r.text)

    fb = rpc(ha, "admin_feedback", {"p_days": 1}).json()
    mine = [x for x in fb if x["message"] == "Live test: PDF cut off"]
    check("admin sees feedback with role and dropped keyword",
          len(mine) == 1 and mine[0]["resume_role"] == "live test role" and mine[0]["keywords_dropped"] == ["Power BI"], fb[:2])
    r = rpc(ha, "admin_set_feedback_status", {"p_id": mine[0]["id"], "p_status": "planned"}) if mine else None
    check("admin sets feedback status", r is not None and r.json() == "planned", r.text if r is not None else "")
    weeks = rpc(ha, "admin_weekly_reports").json()
    check("weekly numbers include this week", isinstance(weeks, list) and len(weeks) >= 1 and weeks[0]["numbers"]["resumes"] >= 1, str(weeks)[:300])
    st = rpc(ha, "admin_stats").json()
    check("admin totals", st.get("users_all_time", 0) >= 1 and st.get("signed_up", 0) >= 2, st)
finally:
    for x in users:
        # feedback, sessions, usage totals and requests go with the user (on delete cascade); signals keep no user
        requests.delete(f"{URL}/auth/v1/admin/users/{x}", headers=admin)
    requests.delete(f"{URL}/rest/v1/admins?email=eq.{admin_email}", headers=admin)
    if "sids" in globals() and sids:
        requests.delete(f"{URL}/rest/v1/quality_signals?session_id=in.({','.join(str(s) for s in sids)})", headers=admin)
    left = requests.get(f"{URL}/rest/v1/admins?select=email&email=eq.{admin_email}", headers=admin).json()
    print(f"{len(users)} test users deleted, test admin removed: {left == []}; {'ALL PASS' if not fails else f'{fails} FAILED'}")
