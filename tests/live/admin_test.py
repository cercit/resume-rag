"""Live check of 0003_admin.sql with throwaway users (created and deleted with the admin API).
A test admin email is added to public.admins for the run and removed after. Reads .env; never prints a key."""
import secrets
from pathlib import Path

import requests

env = dict(l.split("=", 1) for l in Path(".env").read_text(encoding="utf-8").splitlines() if "=" in l and not l.startswith("#"))
URL, ANON, SERVICE = env["SUPABASE_URL"].strip(), env["SUPABASE_ANON_KEY"].strip(), env["SUPABASE_SERVICE_ROLE_KEY"].strip()
admin = {"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}", "Content-Type": "application/json"}
fails = 0


def check(name, ok, detail=""):
    global fails
    fails += 0 if ok else 1
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f": {detail}"))


def make_user(email):
    pw = secrets.token_urlsafe(16)
    uid = requests.post(f"{URL}/auth/v1/admin/users", headers=admin, json={"email": email, "password": pw, "email_confirm": True}).json()["id"]
    t = requests.post(f"{URL}/auth/v1/token?grant_type=password", headers={"apikey": ANON}, json={"email": email, "password": pw}).json()
    return uid, {"apikey": ANON, "Authorization": f"Bearer {t['access_token']}", "Content-Type": "application/json"}


def rpc(h, name, body=None):
    return requests.post(f"{URL}/rest/v1/rpc/{name}", headers=h, json=body or {})


tag = secrets.token_hex(4)
admin_email = f"admin-test-{tag}@test.local"
users = []
try:
    r = requests.post(f"{URL}/rest/v1/admins", headers=admin, json={"email": admin_email})
    check("test admin email added (service role)", r.status_code in (200, 201), r.text)
    u, hu = make_user(f"user-test-{tag}@test.local"); users.append(u)
    a, ha = make_user(admin_email); users.append(a)

    check("anon cannot list users", rpc({"apikey": ANON, "Authorization": f"Bearer {ANON}", "Content-Type": "application/json"}, "admin_users").json().get("code") == "42501")
    check("normal user: my_daily_limit is 3", rpc(hu, "my_daily_limit").json() == 3)
    check("normal user: is_admin false", rpc(hu, "is_admin").json() is False)
    r = rpc(hu, "admin_users"); check("normal user cannot list users", r.json().get("code") == "42501", r.text)
    r = rpc(hu, "admin_set_limit", {"p_user": u, "p_limit": 9}); check("normal user cannot set a limit", r.json().get("code") == "42501", r.text)
    r = requests.get(f"{URL}/rest/v1/admins?select=email", headers=hu); check("normal user cannot read admins", r.status_code in (401, 403) or r.json() == [], r.text)

    check("admin: is_admin true", rpc(ha, "is_admin").json() is True)
    r = rpc(ha, "admin_users"); rows = r.json() if r.ok else []
    me = [x for x in rows if x["user_id"] == u]
    check("admin lists users with counts", r.ok and len(me) == 1 and me[0]["daily_limit"] == 3 and me[0]["resumes_24h"] == 0, r.text[:200])
    r = rpc(ha, "admin_set_limit", {"p_user": u, "p_limit": 7}); check("admin sets limit to 7", r.json() == 7, r.text)
    check("user now sees limit 7", rpc(hu, "my_daily_limit").json() == 7)
    r = rpc(ha, "admin_set_limit", {"p_user": u, "p_limit": 99}); check("limit over 50 refused", not r.ok, r.text)
finally:
    for x in users:
        requests.delete(f"{URL}/auth/v1/admin/users/{x}", headers=admin)
    requests.delete(f"{URL}/rest/v1/admins?email=eq.{admin_email}", headers=admin)
    left = requests.get(f"{URL}/rest/v1/admins?select=email&email=eq.{admin_email}", headers=admin).json()
    print(f"{len(users)} test users deleted, test admin removed: {left == []}; {'ALL PASS' if not fails else f'{fails} FAILED'}")
