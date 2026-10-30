-- 0004 (30 Oct 2026): all-time stats counter, "request more resumes" with admin approval,
-- feedback form, quality signals (no resume text) and the weekly numbers report.
-- Plan: docs/feedback-and-weekly-review-plan.md

-- ============ extra resumes granted by an admin (used after the daily limit, never expire) ============
alter table public.user_limits alter column daily_limit set default 3;
alter table public.user_limits add column if not exists extra int not null default 0 check (extra between 0 and 500);
alter table public.resume_sessions add column if not exists via_extra boolean not null default false;

create or replace function public.extra_for(p_user uuid)
returns int
language sql stable security definer
set search_path = public
as $$
  select coalesce((select extra from public.user_limits where user_id = p_user), 0);
$$;

-- daily limit + unused extra; the Edge Functions compare it with today's non-extra sessions
create or replace function public.my_daily_limit()
returns int
language sql stable security definer
set search_path = public
as $$
  select public.daily_limit_for(auth.uid()) + public.extra_for(auth.uid());
$$;

-- ============ all-time usage: counts only, kept after the 7-day session purge ============
create table if not exists public.usage_totals (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  first_at  timestamptz not null default now(),
  last_at   timestamptz not null default now(),
  resumes   int not null default 0
);
alter table public.usage_totals enable row level security;
revoke all on public.usage_totals from anon, authenticated;
insert into public.usage_totals (user_id, first_at, last_at, resumes)
select user_id, min(created_at), max(created_at), count(*) from public.resume_sessions group by user_id
on conflict (user_id) do nothing;

-- start_session: daily limit first, then one extra resume; counts every resume in usage_totals
create or replace function public.start_session(p_jd text, p_profile jsonb)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_count int;
  v_extra boolean := false;
  v_id    uuid;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select count(*) into v_count from public.resume_sessions
   where user_id = v_uid and created_at > now() - interval '24 hours' and not via_extra;
  if v_count >= public.daily_limit_for(v_uid) then
    update public.user_limits set extra = extra - 1 where user_id = v_uid and extra > 0;
    if not found then raise exception 'daily_session_limit'; end if;
    v_extra := true;
  end if;
  insert into public.resume_sessions (user_id, jd_text, profile_json, via_extra)
  values (v_uid, p_jd, p_profile, v_extra) returning id into v_id;
  insert into public.usage_totals (user_id, resumes) values (v_uid, 1)
  on conflict (user_id) do update set resumes = public.usage_totals.resumes + 1, last_at = now();
  return v_id;
end $$;

-- public counter for the home page
create or replace function public.public_stats()
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object('users', count(*), 'resumes', coalesce(sum(resumes), 0)) from public.usage_totals;
$$;

-- ============ requests for more resumes ============
create table if not exists public.limit_requests (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  requested   int not null check (requested between 1 and 20),
  reason      text check (char_length(reason) <= 500),
  status      text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  granted     int check (granted between 0 and 50),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  text
);
create unique index if not exists limit_requests_one_pending on public.limit_requests (user_id) where status = 'pending';
alter table public.limit_requests enable row level security;
revoke all on public.limit_requests from anon, authenticated;

create or replace function public.request_more(p_requested int, p_reason text default null)
returns bigint
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id  bigint;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if p_requested is null or p_requested < 1 or p_requested > 20 then raise exception 'bad_amount'; end if;
  if exists (select 1 from public.limit_requests where user_id = v_uid and status = 'pending') then
    raise exception 'request_pending';
  end if;
  if (select count(*) from public.limit_requests where user_id = v_uid and created_at > now() - interval '24 hours') >= 3 then
    raise exception 'request_limit';
  end if;
  insert into public.limit_requests (user_id, requested, reason)
  values (v_uid, p_requested, nullif(left(trim(coalesce(p_reason, '')), 500), '')) returning id into v_id;
  return v_id;
end $$;

-- what the profile panel and the limit message need
create or replace function public.my_allowance()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_used  int;
  v_daily int;
  v_extra int;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select count(*) into v_used from public.resume_sessions
   where user_id = v_uid and created_at > now() - interval '24 hours' and not via_extra;
  v_daily := public.daily_limit_for(v_uid);
  v_extra := public.extra_for(v_uid);
  return jsonb_build_object(
    'daily_limit', v_daily, 'used_today', v_used, 'extra', v_extra,
    'left', greatest(v_daily - v_used, 0) + v_extra,
    'pending', (select jsonb_build_object('requested', requested, 'created_at', created_at)
                  from public.limit_requests where user_id = v_uid and status = 'pending'),
    'last_decision', (select jsonb_build_object('status', status, 'requested', requested, 'granted', granted, 'decided_at', decided_at)
                        from public.limit_requests where user_id = v_uid and status <> 'pending'
                       order by decided_at desc nulls last limit 1));
end $$;

create or replace function public.admin_requests(p_status text default 'pending')
returns table (id bigint, user_id uuid, email text, full_name text, requested int, reason text, status text,
               granted int, created_at timestamptz, decided_at timestamptz, daily_limit int, extra int, resumes_all_time int)
language plpgsql stable security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  return query
    select r.id, r.user_id, u.email::text, p.full_name, r.requested, r.reason, r.status, r.granted, r.created_at, r.decided_at,
           public.daily_limit_for(r.user_id), public.extra_for(r.user_id),
           coalesce((select t.resumes from public.usage_totals t where t.user_id = r.user_id), 0)
      from public.limit_requests r
      join auth.users u on u.id = r.user_id
      left join public.profiles p on p.user_id = r.user_id
     where p_status = 'all' or r.status = p_status
     order by (r.status = 'pending') desc, r.created_at desc
     limit 500;
end $$;

-- approve with the requested number or a changed one (adds to extra), or decline
create or replace function public.admin_decide_request(p_id bigint, p_approve boolean, p_granted int default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  r public.limit_requests;
  v_grant int;
  v_admin text := lower(auth.jwt() ->> 'email');
begin
  if not public.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  select * into r from public.limit_requests where id = p_id and status = 'pending' for update;
  if not found then raise exception 'request_not_pending'; end if;
  if p_approve then
    v_grant := coalesce(p_granted, r.requested);
    if v_grant < 1 or v_grant > 50 then raise exception 'bad_amount'; end if;
    insert into public.user_limits (user_id, extra, updated_at, updated_by)
    values (r.user_id, v_grant, now(), v_admin)
    on conflict (user_id) do update
      set extra = least(public.user_limits.extra + v_grant, 500), updated_at = now(), updated_by = v_admin;
    update public.limit_requests set status = 'approved', granted = v_grant, decided_at = now(), decided_by = v_admin where id = p_id;
  else
    v_grant := 0;
    update public.limit_requests set status = 'declined', granted = 0, decided_at = now(), decided_by = v_admin where id = p_id;
  end if;
  return jsonb_build_object('status', case when p_approve then 'approved' else 'declined' end,
                            'granted', v_grant, 'extra', public.extra_for(r.user_id));
end $$;

-- set a user's unused extra resumes directly (admin users table)
create or replace function public.admin_set_extra(p_user uuid, p_extra int)
returns int
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  if p_extra is null or p_extra < 0 or p_extra > 500 then raise exception 'bad_amount'; end if;
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'user_not_found'; end if;
  insert into public.user_limits (user_id, extra, updated_at, updated_by)
  values (p_user, p_extra, now(), lower(auth.jwt() ->> 'email'))
  on conflict (user_id) do update set extra = excluded.extra, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  return p_extra;
end $$;

-- admin user list now also shows extra resumes, all-time resumes and a pending request
drop function if exists public.admin_users();
create function public.admin_users()
returns table (user_id uuid, email text, joined_at timestamptz, last_sign_in_at timestamptz,
               full_name text, username text, resumes_24h int, resumes_7d int, daily_limit int,
               extra int, resumes_all_time int, pending_request int)
language plpgsql stable security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  return query
    select u.id, u.email::text, u.created_at, u.last_sign_in_at, p.full_name, p.username,
           (select count(*)::int from public.resume_sessions s
             where s.user_id = u.id and s.created_at > now() - interval '24 hours'),
           (select count(*)::int from public.resume_sessions s where s.user_id = u.id),
           public.daily_limit_for(u.id), public.extra_for(u.id),
           coalesce((select t.resumes from public.usage_totals t where t.user_id = u.id), 0),
           (select r.requested from public.limit_requests r where r.user_id = u.id and r.status = 'pending')
      from auth.users u
      left join public.profiles p on p.user_id = u.id
     order by u.created_at desc
     limit 1000;
end $$;

-- ============ quality signals: numbers and keywords only, never resume or JD text ============
create table if not exists public.quality_signals (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id) on delete set null,
  session_id  uuid,
  kind        text not null check (kind in ('generate', 'tweak', 'undo', 'download', 'rating')),
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists quality_signals_created_idx on public.quality_signals (created_at);
create index if not exists quality_signals_session_idx on public.quality_signals (session_id);
alter table public.quality_signals enable row level security;
revoke all on public.quality_signals from anon, authenticated;

create or replace function public.record_signal(p_kind text, p_session uuid default null, p_data jsonb default '{}'::jsonb)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_session uuid := p_session;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if p_kind not in ('generate', 'tweak', 'undo', 'download', 'rating') then raise exception 'bad_signal'; end if;
  if octet_length(coalesce(p_data, '{}'::jsonb)::text) > 4096 then raise exception 'signal_too_big'; end if;
  if (select count(*) from public.quality_signals where user_id = v_uid and created_at > now() - interval '1 hour') >= 200 then
    return;  -- quietly drop a flood
  end if;
  if v_session is not null and not exists (select 1 from public.resume_sessions where id = v_session and user_id = v_uid) then
    v_session := null;
  end if;
  insert into public.quality_signals (user_id, session_id, kind, data)
  values (v_uid, v_session, p_kind, coalesce(p_data, '{}'::jsonb));
end $$;

-- undo now leaves an "undo" signal (still does not refund the tweak)
create or replace function public.undo_version(p_session uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  s public.resume_sessions;
  v_json jsonb;
begin
  select * into s from public.resume_sessions
   where id = p_session and user_id = auth.uid() for update;
  if not found then raise exception 'session_not_found'; end if;
  if s.current_version <= 1 then raise exception 'nothing_to_undo'; end if;
  delete from public.resume_versions where session_id = p_session and version = s.current_version;
  update public.resume_sessions set current_version = s.current_version - 1, busy_until = null
   where id = p_session;
  select resume_json into v_json from public.resume_versions
   where session_id = p_session and version = s.current_version - 1;
  insert into public.quality_signals (user_id, session_id, kind, data)
  values (auth.uid(), p_session, 'undo', jsonb_build_object('from_version', s.current_version));
  return v_json;
end $$;

-- ============ feedback: bugs, improvements, ideas ============
create table if not exists public.feedback (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null check (kind in ('bug', 'improvement', 'idea')),
  message     text not null check (char_length(message) between 5 and 2000),
  rating      int check (rating between 1 and 5),
  context     text not null default 'general' check (context in ('general', 'after_generate', 'after_tweak')),
  session_id  uuid,
  status      text not null default 'new' check (status in ('new', 'planned', 'done', 'wont_do')),
  created_at  timestamptz not null default now()
);
create index if not exists feedback_created_idx on public.feedback (created_at desc);
alter table public.feedback enable row level security;
revoke all on public.feedback from anon, authenticated;

create or replace function public.submit_feedback(p_kind text, p_message text, p_rating int default null,
                                                  p_context text default 'general', p_session uuid default null)
returns bigint
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_msg text := trim(coalesce(p_message, ''));
  v_session uuid := p_session;
  v_id bigint;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if p_kind not in ('bug', 'improvement', 'idea') or coalesce(p_context, 'general') not in ('general', 'after_generate', 'after_tweak')
     or (p_rating is not null and (p_rating < 1 or p_rating > 5)) then
    raise exception 'bad_feedback';
  end if;
  if char_length(v_msg) < 5 or char_length(v_msg) > 2000 then raise exception 'feedback_length'; end if;
  if (select count(*) from public.feedback where user_id = v_uid and created_at > now() - interval '24 hours') >= 5 then
    raise exception 'feedback_limit';
  end if;
  if v_session is not null and not exists (select 1 from public.resume_sessions where id = v_session and user_id = v_uid) then
    v_session := null;
  end if;
  insert into public.feedback (user_id, kind, message, rating, context, session_id)
  values (v_uid, p_kind, v_msg, p_rating, coalesce(p_context, 'general'), v_session) returning id into v_id;
  return v_id;
end $$;

create or replace function public.admin_feedback(p_days int default 90)
returns table (id bigint, created_at timestamptz, email text, full_name text, kind text, message text, rating int,
               context text, status text, session_id uuid, resume_role text, keywords_dropped jsonb, session_expired boolean)
language plpgsql stable security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  return query
    select f.id, f.created_at, u.email::text, p.full_name, f.kind, f.message, f.rating, f.context, f.status, f.session_id,
           g.data ->> 'role', g.data -> 'keywords_dropped',
           f.session_id is not null and not exists (select 1 from public.resume_sessions s where s.id = f.session_id)
      from public.feedback f
      left join auth.users u on u.id = f.user_id
      left join public.profiles p on p.user_id = f.user_id
      left join lateral (select q.data from public.quality_signals q
                          where q.session_id = f.session_id and q.kind = 'generate'
                          order by q.created_at desc limit 1) g on true
     where f.created_at > now() - make_interval(days => greatest(coalesce(p_days, 90), 1))
     order by f.created_at desc
     limit 1000;
end $$;

create or replace function public.admin_set_feedback_status(p_id bigint, p_status text)
returns text
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  if p_status not in ('new', 'planned', 'done', 'wont_do') then raise exception 'bad_status'; end if;
  update public.feedback set status = p_status where id = p_id;
  if not found then raise exception 'feedback_not_found'; end if;
  return p_status;
end $$;

-- ============ weekly numbers ============
create table if not exists public.weekly_reports (
  week_start   date primary key,
  numbers      jsonb not null,
  suggestions  jsonb,
  created_at   timestamptz not null default now()
);
alter table public.weekly_reports enable row level security;
revoke all on public.weekly_reports from anon, authenticated;

create or replace function public.build_weekly_report(p_week_start date default (date_trunc('week', now()) - interval '7 days')::date)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_from timestamptz := p_week_start;
  v_to   timestamptz := p_week_start + 7;
  v      jsonb;
begin
  with g as (select * from public.quality_signals where created_at >= v_from and created_at < v_to),
  c as (select
          count(*) filter (where kind = 'generate')                                   as resumes,
          count(distinct user_id) filter (where kind = 'generate')                    as people,
          round(avg((data ->> 'ms')::numeric) filter (where kind = 'generate') / 1000, 1) as avg_seconds,
          count(distinct session_id) filter (where kind = 'download')                 as downloads,
          count(*) filter (where kind = 'tweak')                                      as tweaks,
          count(*) filter (where kind = 'tweak' and data ->> 'outcome' = 'refused')   as refused,
          count(*) filter (where kind = 'undo')                                       as undos,
          count(*) filter (where kind = 'rating' and (data ->> 'up')::boolean)        as thumbs_up,
          count(*) filter (where kind = 'rating' and not (data ->> 'up')::boolean)    as thumbs_down
        from g)
  select jsonb_build_object(
    'week_start', p_week_start,
    'resumes', c.resumes, 'people', c.people, 'avg_seconds', c.avg_seconds,
    'downloads', c.downloads,
    'download_rate', round(100.0 * c.downloads / nullif(c.resumes, 0)),
    'tweaks', c.tweaks,
    'tweaks_per_resume', round(c.tweaks::numeric / nullif(c.resumes, 0), 1),
    'refusal_rate', round(100.0 * c.refused / nullif(c.tweaks, 0)),
    'undos', c.undos, 'thumbs_up', c.thumbs_up, 'thumbs_down', c.thumbs_down,
    'tweak_types', (select coalesce(jsonb_agg(jsonb_build_object('type', t, 'count', n) order by n desc), '[]'::jsonb)
                      from (select data ->> 'category' t, count(*) n from g where kind = 'tweak' group by 1) x),
    'top_dropped_keywords', (select coalesce(jsonb_agg(jsonb_build_object('keyword', k, 'count', n) order by n desc), '[]'::jsonb)
                      from (select lower(e.k) k, count(*) n from g, jsonb_array_elements_text(coalesce(g.data -> 'keywords_dropped', '[]'::jsonb)) e(k)
                             where g.kind = 'generate' group by 1 order by 2 desc limit 15) x),
    'top_missing_keywords', (select coalesce(jsonb_agg(jsonb_build_object('keyword', k, 'count', n) order by n desc), '[]'::jsonb)
                      from (select lower(e.k) k, count(*) n from g, jsonb_array_elements_text(coalesce(g.data -> 'keywords_missing', '[]'::jsonb)) e(k)
                             where g.kind = 'generate' group by 1 order by 2 desc limit 15) x),
    'top_roles', (select coalesce(jsonb_agg(jsonb_build_object('role', r, 'count', n) order by n desc), '[]'::jsonb)
                      from (select data ->> 'role' r, count(*) n from g where kind = 'generate' and coalesce(data ->> 'role', '') <> ''
                             group by 1 order by 2 desc limit 10) x),
    'feedback', (select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb)
                   from (select kind, count(*) n from public.feedback where created_at >= v_from and created_at < v_to group by kind) x),
    'new_users', (select count(*) from public.usage_totals where first_at >= v_from and first_at < v_to),
    'requests', (select count(*) from public.limit_requests where created_at >= v_from and created_at < v_to))
  into v from c;
  insert into public.weekly_reports (week_start, numbers) values (p_week_start, v)
  on conflict (week_start) do update set numbers = excluded.numbers, created_at = now();
  return v;
end $$;

-- admin: all-time totals, plus the last 12 weeks (this week so far is rebuilt on each call)
create or replace function public.admin_stats()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  return jsonb_build_object(
    'users_all_time',   (select count(*) from public.usage_totals),
    'resumes_all_time', (select coalesce(sum(resumes), 0) from public.usage_totals),
    'signed_up',        (select count(*) from auth.users),
    'resumes_7d',       (select count(*) from public.resume_sessions),
    'pending_requests', (select count(*) from public.limit_requests where status = 'pending'),
    'new_feedback',     (select count(*) from public.feedback where status = 'new'));
end $$;

create or replace function public.admin_weekly_reports()
returns setof public.weekly_reports
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  perform public.build_weekly_report(date_trunc('week', now())::date);
  return query select * from public.weekly_reports order by week_start desc limit 12;
end $$;

-- ============ permissions ============
revoke all on function public.extra_for(uuid)                                   from public, anon, authenticated;
revoke all on function public.build_weekly_report(date)                         from public, anon, authenticated;
revoke all on function public.my_daily_limit()                                  from public, anon;
revoke all on function public.my_allowance()                                    from public, anon;
revoke all on function public.request_more(int, text)                           from public, anon;
revoke all on function public.record_signal(text, uuid, jsonb)                  from public, anon;
revoke all on function public.submit_feedback(text, text, int, text, uuid)      from public, anon;
revoke all on function public.admin_requests(text)                              from public, anon;
revoke all on function public.admin_decide_request(bigint, boolean, int)        from public, anon;
revoke all on function public.admin_set_extra(uuid, int)                        from public, anon;
revoke all on function public.admin_users()                                     from public, anon;
revoke all on function public.admin_feedback(int)                               from public, anon;
revoke all on function public.admin_set_feedback_status(bigint, text)           from public, anon;
revoke all on function public.admin_stats()                                     from public, anon;
revoke all on function public.admin_weekly_reports()                            from public, anon;
grant execute on function public.public_stats()                                 to anon, authenticated;
grant execute on function public.my_daily_limit()                               to authenticated;
grant execute on function public.my_allowance()                                 to authenticated;
grant execute on function public.request_more(int, text)                        to authenticated;
grant execute on function public.record_signal(text, uuid, jsonb)               to authenticated;
grant execute on function public.submit_feedback(text, text, int, text, uuid)   to authenticated;
grant execute on function public.admin_requests(text)                           to authenticated;
grant execute on function public.admin_decide_request(bigint, boolean, int)     to authenticated;
grant execute on function public.admin_set_extra(uuid, int)                     to authenticated;
grant execute on function public.admin_users()                                  to authenticated;
grant execute on function public.admin_feedback(int)                            to authenticated;
grant execute on function public.admin_set_feedback_status(bigint, text)        to authenticated;
grant execute on function public.admin_stats()                                  to authenticated;
grant execute on function public.admin_weekly_reports()                         to authenticated;

-- ============ schedules ============
-- Monday 02:00 UTC (07:30 IST): numbers for the week that just ended
select cron.schedule('weekly-report', '0 2 * * 1', $$select public.build_weekly_report()$$);
-- daily: feedback after 90 days, tweak text after 30 days, signals after 180 days, old decided requests after 180 days
select cron.schedule('purge-feedback', '27 3 * * *', $$
  delete from public.feedback where created_at < now() - interval '90 days';
  update public.quality_signals set data = data - 'text' where kind = 'tweak' and data ? 'text' and created_at < now() - interval '30 days';
  delete from public.quality_signals where created_at < now() - interval '180 days';
  delete from public.limit_requests where status <> 'pending' and created_at < now() - interval '180 days';
$$);
