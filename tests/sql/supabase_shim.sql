-- Local stand-in for the bits of Supabase the migration relies on.
-- Only for tests on a plain Postgres. Never run this on a real Supabase project.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant anon, authenticated, service_role to postgres;
create schema auth;
create schema extensions;
create extension vector with schema extensions;
create table auth.users (id uuid primary key default gen_random_uuid(), email text,
  created_at timestamptz not null default now(), last_sign_in_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth, extensions, public to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
-- Supabase grants these by default on objects created in public
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
