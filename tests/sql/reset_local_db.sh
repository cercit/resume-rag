#!/usr/bin/env bash
# Rebuild the local test database t1 from the shim plus the real migration.
set -euo pipefail
cd "$(dirname "$0")/../.."
P="psql -h ${PGHOST:-/tmp/pg} -p ${PGPORT:-54329} -U postgres -v ON_ERROR_STOP=1 -q"
$P -c "drop database if exists t1 with (force)"
$P -c "create database t1"
$P -d t1 -f tests/sql/supabase_shim.sql
$P -d t1 -f supabase/migrations/0001_schema.sql
$P -d t1 -f supabase/migrations/0002_profiles.sql
$P -d t1 -f supabase/migrations/0003_admin.sql
$P -d t1 -f supabase/migrations/0004_feedback.sql
