-- Database tests for 0001_schema.sql. Run against the local shim database:
--   tests/sql/reset_local_db.sh && psql ... -d t1 -f tests/sql/test_schema.sql
-- Every check raises an exception on failure, so ON_ERROR_STOP makes the run fail.
\set ON_ERROR_STOP 1
\set QUIET 1

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@test.local'),
  ('00000000-0000-0000-0000-00000000000b', 'b@test.local');

create or replace function pg_temp.act_as(p_role text, p_uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  execute format('set role %I', p_role);
end $$;

-- 1. RLS is on for every public table
do $$ declare n int; begin
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if n > 0 then raise exception 'FAIL: % public tables without RLS', n; end if;
  raise notice 'PASS rls enabled on all public tables';
end $$;

-- 2. anon cannot call any RPC
do $$ declare f text; ok boolean; begin
  foreach f in array array[
    'public.start_session(text,jsonb)', 'public.begin_work(uuid)', 'public.save_version(uuid,jsonb,text)',
    'public.end_work(uuid)', 'public.undo_version(uuid)',
    'public.match_documents(extensions.vector,integer,double precision,text)'] loop
    select has_function_privilege('anon', f, 'execute') into ok;
    if ok then raise exception 'FAIL: anon can execute %', f; end if;
  end loop;
  raise notice 'PASS anon cannot execute any RPC';
end $$;

-- 3. authenticated cannot call match_documents, can call the session RPCs
do $$ begin
  if has_function_privilege('authenticated', 'public.match_documents(extensions.vector,integer,double precision,text)', 'execute')
    then raise exception 'FAIL: authenticated can execute match_documents'; end if;
  if not has_function_privilege('authenticated', 'public.save_version(uuid,jsonb,text)', 'execute')
    then raise exception 'FAIL: authenticated cannot execute save_version'; end if;
  if not has_function_privilege('service_role', 'public.match_documents(extensions.vector,integer,double precision,text)', 'execute')
    then raise exception 'FAIL: service_role cannot execute match_documents'; end if;
  raise notice 'PASS function grants';
end $$;

-- 4. anon really gets an error when calling, not just a missing grant flag
select pg_temp.act_as('anon', null);
do $$ begin
  perform public.start_session('jd', '{}'::jsonb);
  raise exception 'FAIL: anon start_session succeeded';
exception when insufficient_privilege then raise notice 'PASS anon start_session denied';
end $$;
reset role;

-- 5. user A starts a session and saves version 1 (generation, no tweak charged)
select pg_temp.act_as('authenticated', '00000000-0000-0000-0000-00000000000a');
create temp table ctx as select public.start_session('JD text', '{"name":"A"}'::jsonb) as sid;
do $$ declare r record; begin
  select * into r from public.save_version((select sid from ctx), '{"v":1}'::jsonb, null);
  if r.out_version <> 1 or r.out_tweaks_used <> 0 then raise exception 'FAIL: first save %', r; end if;
  raise notice 'PASS first save is version 1, 0 tweaks';
end $$;

-- 6. begin_work: the second parallel claim is refused (Edge Function turns this into 409)
do $$ begin
  if not public.begin_work((select sid from ctx)) then raise exception 'FAIL: first claim refused'; end if;
  if public.begin_work((select sid from ctx)) then raise exception 'FAIL: second claim accepted'; end if;
  perform public.end_work((select sid from ctx));
  if not public.begin_work((select sid from ctx)) then raise exception 'FAIL: claim after end_work refused'; end if;
  perform public.end_work((select sid from ctx));
  raise notice 'PASS begin_work blocks a parallel claim; end_work releases it';
end $$;

-- 7. 10 tweaks pass, the 11th is refused; a failed call (end_work) charges nothing
do $$ declare i int; r record; used int; begin
  perform public.begin_work((select sid from ctx));
  perform public.end_work((select sid from ctx));   -- simulated LLM failure
  select tweaks_used into used from public.resume_sessions where id = (select sid from ctx);
  if used <> 0 then raise exception 'FAIL: failed call charged a tweak'; end if;
  for i in 1..10 loop
    if not public.begin_work((select sid from ctx)) then raise exception 'FAIL: claim % refused', i; end if;
    select * into r from public.save_version((select sid from ctx), jsonb_build_object('v', i + 1), 'tweak ' || i);
  end loop;
  if r.out_tweaks_used <> 10 then raise exception 'FAIL: expected 10 tweaks used, got %', r.out_tweaks_used; end if;
  begin
    perform public.save_version((select sid from ctx), '{"v":"x"}'::jsonb, 'tweak 11');
    raise exception 'FAIL: 11th tweak accepted';
  exception when raise_exception then
    if sqlerrm <> 'tweak_limit_reached' then raise; end if;
  end;
  raise notice 'PASS 10 tweaks pass, 11th refused, failure not charged';
end $$;

-- 8. undo is free and returns the previous JSON; cannot undo past version 1
do $$ declare j jsonb; s record; begin
  j := public.undo_version((select sid from ctx));
  if j <> '{"v":10}'::jsonb then raise exception 'FAIL: undo returned %', j; end if;
  select current_version, tweaks_used into s from public.resume_sessions where id = (select sid from ctx);
  if s.current_version <> 10 or s.tweaks_used <> 10 then raise exception 'FAIL: after undo %', s; end if;
  raise notice 'PASS undo returns previous version, tweak count unchanged';
end $$;

-- 9. direct writes are blocked (no insert/update policies)
do $$ begin
  update public.resume_sessions set tweaks_used = 0 where id = (select sid from ctx);
  if exists (select 1 from public.resume_sessions where id = (select sid from ctx) and tweaks_used = 0)
    then raise exception 'FAIL: direct update reset tweaks'; end if;
  raise notice 'PASS direct update has no effect';
exception when insufficient_privilege then raise notice 'PASS direct update denied';
end $$;
do $$ begin
  insert into public.resume_versions (session_id, version, resume_json) values ((select sid from ctx), 99, '{}');
  raise exception 'FAIL: direct insert into resume_versions worked';
exception when insufficient_privilege then raise notice 'PASS direct insert denied';
end $$;

-- 10. daily cap: sessions 2 and 3 pass, the 4th in 24 hours is refused
do $$ begin
  perform public.start_session('jd2', '{}'::jsonb);
  perform public.start_session('jd3', '{}'::jsonb);
  begin
    perform public.start_session('jd4', '{}'::jsonb);
    raise exception 'FAIL: 4th session accepted';
  exception when raise_exception then
    if sqlerrm <> 'daily_session_limit' then raise; end if;
  end;
  raise notice 'PASS 4th session in 24h refused';
end $$;

-- 11. documents are invisible to authenticated users (RLS, no policies)
reset role;
insert into public.documents (source, content, content_hash, embedding)
values ('t.md', 'hello', 'h1', array_fill(0.05::real, array[384])::extensions.vector);
select pg_temp.act_as('authenticated', '00000000-0000-0000-0000-00000000000a');
do $$ begin
  if exists (select 1 from public.documents) then raise exception 'FAIL: authenticated can read documents'; end if;
  raise notice 'PASS authenticated cannot read documents';
end $$;
reset role;

-- 12. user B cannot read A's sessions or versions, or act on them
select pg_temp.act_as('authenticated', '00000000-0000-0000-0000-00000000000b');
do $$ declare sid_a uuid; begin
  if exists (select 1 from public.resume_sessions) then raise exception 'FAIL: B sees sessions'; end if;
  if exists (select 1 from public.resume_versions) then raise exception 'FAIL: B sees versions'; end if;
  select sid into sid_a from ctx;
  if public.begin_work(sid_a) then raise exception 'FAIL: B claimed A''s session'; end if;
  begin
    perform public.save_version(sid_a, '{}'::jsonb, 'x');
    raise exception 'FAIL: B saved into A''s session';
  exception when raise_exception then if sqlerrm <> 'session_not_found' then raise; end if;
  end;
  begin
    perform public.undo_version(sid_a);
    raise exception 'FAIL: B undid A''s version';
  exception when raise_exception then if sqlerrm <> 'session_not_found' then raise; end if;
  end;
  raise notice 'PASS user B cannot read or change user A''s data';
end $$;
reset role;

-- 13. match_documents works for service_role and returns the closest row
set role service_role;
do $$ declare r record; begin
  select * into r from public.match_documents(array_fill(0.05::real, array[384])::extensions.vector, 8, 0.0, null);
  if r.content <> 'hello' or r.similarity < 0.99 then raise exception 'FAIL: match_documents %', r; end if;
  raise notice 'PASS match_documents as service_role';
end $$;
reset role;

-- 14. profiles (0002): own row only, username rules, my_resumes returns only own sessions
select pg_temp.act_as('authenticated', '00000000-0000-0000-0000-00000000000a');
insert into public.profiles (full_name, username) values ('Asha Verma', 'asha_v');
do $$ declare n int; begin
  begin
    insert into public.profiles (user_id, username) values ('00000000-0000-0000-0000-00000000000b', 'not_mine');
    raise exception 'FAIL: inserted a profile for another user';
  exception when insufficient_privilege then null; end;
  begin
    update public.profiles set username = 'Bad Name!';
    raise exception 'FAIL: bad username accepted';
  exception when check_violation then null; end;
  select count(*) into n from public.my_resumes();
  if n < 1 then raise exception 'FAIL: my_resumes returned nothing for user A'; end if;
  raise notice 'PASS profiles and my_resumes for the owner';
end $$;
select pg_temp.act_as('authenticated', '00000000-0000-0000-0000-00000000000b');
do $$ declare n int; begin
  select count(*) into n from public.profiles;
  if n <> 0 then raise exception 'FAIL: user B sees % profiles', n; end if;
  select count(*) into n from public.my_resumes() where session_id in
    (select id from public.resume_sessions where user_id = '00000000-0000-0000-0000-00000000000a');
  if n <> 0 then raise exception 'FAIL: user B sees user A resumes'; end if;
  begin
    insert into public.profiles (username) values ('asha_v');
    raise exception 'FAIL: duplicate username accepted';
  exception when unique_violation then null; end;
  raise notice 'PASS user B cannot see A''s profile or resumes; usernames unique';
end $$;
reset role;

\echo ALL_SCHEMA_TESTS_PASSED
