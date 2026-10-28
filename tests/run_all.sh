#!/usr/bin/env bash
# Run every offline test. Needs: local Postgres 16 with pgvector + pg_cron on /tmp/pg:54329 (see tests/README),
# Deno 2, Python 3 with pymupdf + pymupdf4llm + playwright, Node 22 with playwright, and WEBDEPS pointing at a
# folder where `npm i @supabase/supabase-js@2.45.4 mammoth@1.8.0 pdfjs-dist@4.4.168` was run.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== ingest (python)";        python3 tests/test_ingest.py
echo "== database (sql)";         tests/sql/reset_local_db.sh >/dev/null 2>&1
psql -h /tmp/pg -p 54329 -U postgres -d t1 -q -f tests/sql/test_schema.sql 2>&1 | grep -E "PASS|FAIL|ALL_"
echo "== functions (deno)";       tests/sql/reset_local_db.sh >/dev/null 2>&1; deno test -A tests/functions/
echo "== render vs build_resume.py"
PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-/tmp/pwb} python3 base/build_resume.py tests/out/sameer_job >/dev/null
node tests/render/html_match.test.mjs
NODE_PATH=$(npm root -g) node tests/render/pdf_match.test.mjs
echo "== web (browser)";          NODE_PATH=$(npm root -g) node tests/web/e2e.test.cjs
