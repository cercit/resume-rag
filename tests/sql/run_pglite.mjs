// Runs the shim, every migration and the SQL tests in PGlite (Postgres in Node), for Windows without a local Postgres.
//   npm i @electric-sql/pglite@0.2.17 in any folder, then:
//   PGLITE_DIR=<that folder> node tests/sql/run_pglite.mjs
// Supabase-only bits are stubbed here: auth.jwt(), the cron schema, and the pg_cron extension line.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const lib = join(process.env.PGLITE_DIR ?? ".", "node_modules/@electric-sql/pglite/dist");
const { PGlite } = await import(pathToFileURL(join(lib, "index.js")).href);
const { vector } = await import(pathToFileURL(join(lib, "vector/index.js")).href);

const db = new PGlite({ extensions: { vector } });
const notices = [];
const run = async (label, sql) => {
  try { await db.exec(sql, { onNotice: (n) => notices.push(n.message) }); }
  catch (e) { console.error(`FAIL in ${label}: ${e.message}`); for (const n of notices.slice(-3)) console.error("  last notice:", n); process.exit(1); }
};
const file = (p) => readFileSync(join(root, p), "utf8");
// psql meta-commands (\set, \echo) are not SQL, and PGlite's roles cannot use pg_temp, so helpers move to schema testh
const plain = (sql) => sql.split("\n").filter((l) => !l.trimStart().startsWith("\\")).join("\n").replaceAll("pg_temp.", "testh.");

await run("shim", file("tests/sql/supabase_shim.sql"));
await run("stubs", `
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  grant execute on function auth.jwt() to anon, authenticated, service_role;
  grant temporary on database template1 to anon, authenticated, service_role;
  create schema testh; grant usage on schema testh to anon, authenticated, service_role;
  alter default privileges in schema testh grant execute on functions to anon, authenticated, service_role;
  create schema cron;
  create function cron.schedule(a text, b text, c text) returns bigint language sql as $$ select 1::bigint $$;`);
for (const m of readdirSync(join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort()) {
  await run(m, file(`supabase/migrations/${m}`).replace(/create extension if not exists pg_cron;/i, ""));
}
for (const t of ["test_schema.sql", "test_feedback.sql"]) {
  await run(t, plain(file(`tests/sql/${t}`)));
}
for (const n of notices) if (n.startsWith("PASS")) console.log(n);
console.log(`${notices.filter((n) => n.startsWith("PASS")).length} PASS, all SQL tests passed`);
