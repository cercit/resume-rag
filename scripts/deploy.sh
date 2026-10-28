#!/usr/bin/env bash
# Full backend setup for project jkionnbbtnwloavmhcdn. Run from the repo root after .env is filled in
# and `npx supabase login` is done (or SUPABASE_ACCESS_TOKEN is set). Never prints key values.
set -euo pipefail
cd "$(dirname "$0")/.."
REF=jkionnbbtnwloavmhcdn
set -a; source .env; set +a          # values stay in this shell, never echoed
export SUPABASE_DB_PASSWORD

echo "== 0. preflight"
for k in SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY LLM_API_KEY SUPABASE_DB_PASSWORD; do
  [ -n "${!k:-}" ] && echo "$k set" || { echo "$k EMPTY"; exit 1; }
done
npx --yes supabase projects list | grep -q "$REF" || { echo "Project $REF not visible: run npx supabase login"; exit 1; }

echo "== 1. link";        npx --yes supabase link --project-ref "$REF"
echo "== 2. migration";   npx --yes supabase db push
                          npx --yes supabase db lint --linked || true
echo "== 3. auth config"; npx --yes supabase config push
echo "== 4. secrets";     python3 scripts/set_secrets.py; npx --yes supabase secrets list
echo "== 5. functions";   npx --yes supabase functions deploy generate tweak rag-check
                          npx --yes supabase functions list
echo "== 6. ingest";      python3 ingest/ingest.py && python3 ingest/ingest.py --check
echo "== 7. live tests";  python3 tests/live/live_test.py
