-- Database tests for 0004_feedback.sql: extra resumes and requests, stats counter, feedback, signals, weekly numbers.
-- Runs after the migrations on the local shim (tests/sql/run_pglite.mjs on Windows, or psql on Linux).
-- Every check raises an exception on failure.

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'boss@test.local'),
  ('00000000-0000-0000-0000-0000000000d1', 'dev@test.local'),
  ('00000000-0000-0000-0000-0000000000e1', 'eve@test.local');
insert into public.admins (email) values ('boss@test.local');

create or replace function pg_temp.as_user(p_role text, p_uid text, p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  perform set_config('request.jwt.claims', json_build_object('email', p_email)::text, false);
  execute format('set role %I', p_role);
end $$;

-- F1. anon: only public_stats; every new user/admin function refused
do $$ declare f text; begin
  foreach f in array array['public.my_allowance()', 'public.request_more(integer,text)', 'public.record_signal(text,uuid,jsonb)',
    'public.submit_feedback(text,text,integer,text,uuid)', 'public.admin_requests(text)', 'public.admin_decide_request(bigint,boolean,integer)',
    'public.admin_set_extra(uuid,integer)', 'public.admin_feedback(integer)', 'public.admin_stats()', 'public.admin_weekly_reports()',
    'public.build_weekly_report(date)', 'public.extra_for(uuid)', 'public.admin_users()'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception 'FAIL: anon can execute %', f; end if;
  end loop;
  if has_function_privilege('authenticated', 'public.build_weekly_report(date)', 'execute') then raise exception 'FAIL: users can build reports'; end if;
  if not has_function_privilege('anon', 'public.public_stats()', 'execute') then raise exception 'FAIL: anon cannot read public_stats'; end if;
  raise notice 'PASS F1 grants';
end $$;

-- F2. daily limit 3, then refused; request more; second pending request refused
select pg_temp.as_user('authenticated', '00000000-0000-0000-0000-0000000000d1', 'dev@test.local');
do $$ declare a jsonb; begin
  perform public.start_session('jd', '{}'::jsonb); perform public.start_session('jd', '{}'::jsonb); perform public.start_session('jd', '{}'::jsonb);
  begin perform public.start_session('jd', '{}'::jsonb); raise exception 'FAIL: 4th resume allowed';
  exception when raise_exception then if sqlerrm <> 'daily_session_limit' then raise; end if; end;
  a := public.my_allowance();
  if (a ->> 'left')::int <> 0 or (a ->> 'used_today')::int <> 3 then raise exception 'FAIL: allowance %', a; end if;
  begin perform public.request_more(0, null); raise exception 'FAIL: 0 requested accepted';
  exception when raise_exception then if sqlerrm <> 'bad_amount' then raise; end if; end;
  perform public.request_more(5, 'Applying to many roles this week');
  begin perform public.request_more(2, null); raise exception 'FAIL: second pending request accepted';
  exception when raise_exception then if sqlerrm <> 'request_pending' then raise; end if; end;
  a := public.my_allowance();
  if (a -> 'pending' ->> 'requested')::int <> 5 then raise exception 'FAIL: pending not shown %', a; end if;
  begin perform public.admin_requests('pending'); raise exception 'FAIL: user listed requests';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS F2 limit, request, one pending, user cannot list';
end $$;
reset role;

-- F3. admin approves with a changed number (2 instead of 5); user gets exactly 2 more, then refused
select pg_temp.as_user('authenticated', '00000000-0000-0000-0000-0000000000c1', 'boss@test.local');
do $$ declare r record; d jsonb; s jsonb; begin
  select * into r from public.admin_requests('pending') limit 1;
  if r.requested <> 5 or r.email <> 'dev@test.local' then raise exception 'FAIL: admin_requests %', r; end if;
  d := public.admin_decide_request(r.id, true, 2);
  if d ->> 'status' <> 'approved' or (d ->> 'extra')::int <> 2 then raise exception 'FAIL: decide %', d; end if;
  begin perform public.admin_decide_request(r.id, true, 2); raise exception 'FAIL: decided twice';
  exception when raise_exception then if sqlerrm <> 'request_not_pending' then raise; end if; end;
  s := public.admin_stats();
  if (s ->> 'users_all_time')::int < 1 or (s ->> 'pending_requests')::int <> 0 then raise exception 'FAIL: admin_stats %', s; end if;
  raise notice 'PASS F3 admin approves a changed amount';
end $$;
reset role;
select pg_temp.as_user('authenticated', '00000000-0000-0000-0000-0000000000d1', 'dev@test.local');
do $$ declare a jsonb; n int; begin
  a := public.my_allowance();
  if (a ->> 'left')::int <> 2 or (a -> 'last_decision' ->> 'granted')::int <> 2 then raise exception 'FAIL: allowance after approval %', a; end if;
  if public.my_daily_limit() <> 5 then raise exception 'FAIL: my_daily_limit %', public.my_daily_limit(); end if;
  perform public.start_session('jd', '{}'::jsonb); perform public.start_session('jd', '{}'::jsonb);
  select count(*) into n from public.resume_sessions where via_extra;
  if n <> 2 then raise exception 'FAIL: % extra sessions', n; end if;
  begin perform public.start_session('jd', '{}'::jsonb); raise exception 'FAIL: resume beyond extra allowed';
  exception when raise_exception then if sqlerrm <> 'daily_session_limit' then raise; end if; end;
  -- the edge check: non-extra sessions today (3) >= my_daily_limit (3 + 0 extra)
  if public.my_daily_limit() <> 3 then raise exception 'FAIL: limit after using extra %', public.my_daily_limit(); end if;
  raise notice 'PASS F3 extra resumes used once each, then refused';
end $$;
reset role;

-- F4. public counter counts people and resumes
set role anon;
do $$ declare s jsonb; begin
  s := public.public_stats();
  if (s ->> 'users')::int < 1 or (s ->> 'resumes')::int < 5 then raise exception 'FAIL: public_stats %', s; end if;
  raise notice 'PASS F4 public_stats %', s;
end $$;
reset role;

-- F5. feedback: rules, 5 a day, linked session only if own; users cannot read the table
select pg_temp.as_user('authenticated', '00000000-0000-0000-0000-0000000000d1', 'dev@test.local');
do $$ declare sid uuid; n int; begin
  select id into sid from public.resume_sessions order by created_at limit 1;
  begin perform public.submit_feedback('bug', 'bad', null, 'general', null); raise exception 'FAIL: 3-letter message accepted';
  exception when raise_exception then if sqlerrm <> 'feedback_length' then raise; end if; end;
  begin perform public.submit_feedback('rant', 'hello there', null, 'general', null); raise exception 'FAIL: bad kind accepted';
  exception when raise_exception then if sqlerrm <> 'bad_feedback' then raise; end if; end;
  perform public.submit_feedback('bug', 'PDF cut off on page 2', 2, 'after_generate', sid);
  perform public.submit_feedback('idea', 'Add a cover letter too', null, 'general', null);
  perform public.submit_feedback('improvement', 'Summary is too long', 3, 'after_tweak', sid);
  perform public.submit_feedback('improvement', 'Skills order', null, 'general', null);
  perform public.submit_feedback('idea', 'Dark PDF theme', null, 'general', null);
  begin perform public.submit_feedback('idea', 'One more idea', null, 'general', null); raise exception 'FAIL: 6th feedback accepted';
  exception when raise_exception then if sqlerrm <> 'feedback_limit' then raise; end if; end;
  begin select count(*) into n from public.feedback; raise exception 'FAIL: user read feedback';
  exception when insufficient_privilege then null; end;
  perform public.record_signal('generate', sid, '{"role":"credit manager","keywords_dropped":["Power BI"],"keywords_missing":["Kubernetes"],"ms":30000}'::jsonb);
  perform public.record_signal('tweak', sid, '{"category":"shorten","outcome":"applied"}'::jsonb);
  perform public.record_signal('tweak', sid, '{"category":"shorten","outcome":"refused"}'::jsonb);
  perform public.record_signal('download', sid, '{}'::jsonb);
  perform public.record_signal('rating', sid, '{"up":false,"context":"after_generate"}'::jsonb);
  begin perform public.record_signal('hack', null, '{}'::jsonb); raise exception 'FAIL: bad signal kind accepted';
  exception when raise_exception then if sqlerrm <> 'bad_signal' then raise; end if; end;
  begin perform public.record_signal('tweak', null, jsonb_build_object('text', repeat('x', 5000))); raise exception 'FAIL: big signal accepted';
  exception when raise_exception then if sqlerrm <> 'signal_too_big' then raise; end if; end;
  raise notice 'PASS F5 feedback rules and signals';
end $$;
reset role;
-- another user's session id is not linked
select pg_temp.as_user('authenticated', '00000000-0000-0000-0000-0000000000e1', 'eve@test.local');
do $$ declare sid uuid; begin
  select id into sid from public.resume_sessions where user_id = '00000000-0000-0000-0000-0000000000d1' limit 1;
  if sid is not null then raise exception 'FAIL: eve can see dev sessions'; end if;
  begin perform public.admin_feedback(30); raise exception 'FAIL: eve read admin feedback';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS F5 other users cannot see sessions or feedback';
end $$;
reset role;
do $$ declare sid uuid; fid bigint; begin
  select id into sid from public.resume_sessions where user_id = '00000000-0000-0000-0000-0000000000d1' limit 1;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', false);
  set role authenticated;
  fid := public.submit_feedback('bug', 'Linking someone else', null, 'general', sid);
  reset role;
  if (select session_id from public.feedback where id = fid) is not null then raise exception 'FAIL: foreign session linked'; end if;
  raise notice 'PASS F5 foreign session id dropped';
end $$;

-- F6. admin sees feedback with role and dropped keywords; status change; weekly numbers
select pg_temp.as_user('authenticated', '00000000-0000-0000-0000-0000000000c1', 'boss@test.local');
do $$ declare r record; w record; n jsonb; begin
  select * into r from public.admin_feedback(30) where kind = 'bug' and session_id is not null limit 1;
  if r.resume_role <> 'credit manager' or r.keywords_dropped ->> 0 <> 'Power BI' then raise exception 'FAIL: admin_feedback %', r; end if;
  if public.admin_set_feedback_status(r.id, 'planned') <> 'planned' then raise exception 'FAIL: status'; end if;
  select * into w from public.admin_weekly_reports() limit 1;
  n := w.numbers;
  if (n ->> 'resumes')::int <> 1 or (n ->> 'download_rate')::int <> 100 or (n ->> 'refusal_rate')::int <> 50
     or n -> 'tweak_types' -> 0 ->> 'type' <> 'shorten' or n -> 'top_dropped_keywords' -> 0 ->> 'keyword' <> 'power bi'
     or (n ->> 'thumbs_down')::int <> 1 or (n -> 'feedback' ->> 'idea')::int <> 2 then
    raise exception 'FAIL: weekly numbers %', n;
  end if;
  raise notice 'PASS F6 admin feedback view and weekly numbers';
end $$;
reset role;

-- F7. undo leaves a signal
select pg_temp.as_user('authenticated', '00000000-0000-0000-0000-0000000000d1', 'dev@test.local');
do $$ declare sid uuid; begin
  select id into sid from public.resume_sessions order by created_at limit 1;
  perform public.save_version(sid, '{"v":1}'::jsonb, null);
  perform public.save_version(sid, '{"v":2}'::jsonb, 'shorten');
  perform public.undo_version(sid);
end $$;
reset role;
do $$ begin
  if not exists (select 1 from public.quality_signals where kind = 'undo') then raise exception 'FAIL: no undo signal'; end if;
  raise notice 'PASS F7 undo signal';
end $$;



-- F8. admin_overview (0005): admin only, daily series and funnel
select testh.as_user('authenticated', '00000000-0000-0000-0000-0000000000d1', 'dev@test.local');
do $$ begin
  begin perform public.admin_overview(30); raise exception 'FAIL: user read admin_overview';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS F8 user refused admin_overview';
end $$;
reset role;
select testh.as_user('authenticated', '00000000-0000-0000-0000-0000000000c1', 'boss@test.local');
do $$ declare o jsonb; begin
  o := public.admin_overview(30);
  if jsonb_array_length(o -> 'daily') <> 30 then raise exception 'FAIL: % days', jsonb_array_length(o -> 'daily'); end if;
  if (o -> 'daily' -> 29 ->> 'resumes')::int < 5 or (o -> 'daily' -> 29 ->> 'signups')::int < 3 then raise exception 'FAIL: today %', o -> 'daily' -> 29; end if;
  if (o -> 'funnel' ->> 'downloaded')::int <> 1 or (o -> 'funnel' ->> 'made_resume')::int < 2 then raise exception 'FAIL: funnel %', o -> 'funnel'; end if;
  if o -> 'tweak_types' -> 0 ->> 'label' <> 'shorten' or o -> 'dropped_keywords' -> 0 ->> 'label' <> 'power bi' then raise exception 'FAIL: lists %', o; end if;
  if (o ->> 'extra_granted')::int <> 2 or jsonb_array_length(public.admin_overview(500) -> 'daily') <> 180 then raise exception 'FAIL: extra or day cap'; end if;
  raise notice 'PASS F8 admin_overview numbers';
end $$;
reset role;
select 'ALL_FEEDBACK_TESTS_PASSED';
