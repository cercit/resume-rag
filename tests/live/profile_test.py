"""Live check of 0002_profiles.sql with two throwaway users (created and deleted with the admin API).
Checks: own profile save and read, bad username refused, duplicate username refused, user B cannot read A,
my_resumes answers for a signed-in user. Reads .env; never prints a key."""
import json
import secrets
from pathlib import Path

import requests

env = dict(l.split("=", 1) for l in Path(".env").read_text(encoding="utf-8").splitlines() if "=" in l and not l.startswith("#"))
URL, ANON, SERVICE = env["SUPABASE_URL"].strip(), env["SUPABASE_ANON_KEY"].strip(), env["SUPABASE_SERVICE_ROLE_KEY"].strip()
admin = {"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}"}
fails = 0


def check(name, ok, detail=""):
    global fails
    fails += 0 if ok else 1
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f": {detail}"))


def make_user():
    email, pw = f"profile-test-{secrets.token_hex(4)}@test.local", secrets.token_urlsafe(16)
    r = requests.post(f"{URL}/auth/v1/admin/users", headers=admin, json={"email": email, "password": pw, "email_confirm": True})
    uid = r.json()["id"]
    t = requests.post(f"{URL}/auth/v1/token?grant_type=password", headers={"apikey": ANON}, json={"email": email, "password": pw}).json()
    return uid, {"apikey": ANON, "Authorization": f"Bearer {t['access_token']}", "Content-Type": "application/json"}


users = []
try:
    a, ha = make_user(); users.append(a)
    b, hb = make_user(); users.append(b)
    name = "u" + secrets.token_hex(4)
    r = requests.post(f"{URL}/rest/v1/profiles", headers={**ha, "Prefer": "resolution=merge-duplicates"},
                      json={"user_id": a, "full_name": "Test A", "username": name})
    check("A saves own profile", r.status_code in (200, 201), r.text)
    r = requests.get(f"{URL}/rest/v1/profiles?select=full_name,username", headers=ha)
    check("A reads own profile", r.json() == [{"full_name": "Test A", "username": name}], r.text)
    r = requests.post(f"{URL}/rest/v1/profiles", headers=hb, json={"user_id": b, "username": "Bad Name!"})
    check("bad username refused", r.status_code == 400 and r.json().get("code") == "23514", r.text)
    r = requests.post(f"{URL}/rest/v1/profiles", headers=hb, json={"user_id": b, "username": name})
    check("duplicate username refused", r.json().get("code") == "23505", r.text)
    r = requests.post(f"{URL}/rest/v1/profiles", headers=hb, json={"user_id": a, "username": "b_" + name})
    check("B cannot write A's profile", r.json().get("code") == "42501", r.text)
    r = requests.get(f"{URL}/rest/v1/profiles?select=user_id", headers=hb)
    check("B cannot read A's profile", r.json() == [], r.text)
    r = requests.post(f"{URL}/rest/v1/rpc/my_resumes", headers=hb, json={})
    check("my_resumes answers for a signed-in user", r.status_code == 200 and r.json() == [], r.text)
finally:
    for u in users:
        requests.delete(f"{URL}/auth/v1/admin/users/{u}", headers=admin)
    print(f"{len(users)} test users deleted; {'ALL PASS' if not fails else f'{fails} FAILED'}")
