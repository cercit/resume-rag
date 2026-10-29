-- Admin panel (29 Oct 2026): admins see every user and can change a user's daily resume limit (default 3).

-- ============ admins, by sign-in email ============
-- No policies: only the security definer functions below read it.
create table public.admins (
  email text primary key check (email = lower(email))
);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;
insert into public.admins (email) values ('cercit@gmail.com');

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

-- ============ per-user daily limit ============
create table public.user_limits (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  daily_limit  int  not null check (daily_limit between 0 and 50),
  updated_at   timestamptz not null default now(),
  updated_by   text
);
alter table public.user_limits enable row level security;
create policy "own limit: read" on public.user_limits
  for select to authenticated using (user_id = auth.uid());
revoke all on public.user_limits from anon;
grant select on public.user_limits to authenticated;

create or replace function public.daily_limit_for(p_user uuid)
returns int
language sql stable security definer
set search_path = public
as $$
  select coalesce((select daily_limit from public.user_limits where user_id = p_user), 3);
$$;

create or replace function public.my_daily_limit()
returns int
language sql stable security definer
set search_path = public
as $$
  select public.daily_limit_for(auth.uid());
$$;

-- start_session now uses the user's own limit instead of a fixed 3
create or replace function public.start_session(p_jd text, p_profile jsonb)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_count int;
  v_id    uuid;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select count(*) into v_count from public.resume_sessions
   where user_id = v_uid and created_at > now() - interval '24 hours';
  if v_count >= public.daily_limit_for(v_uid) then raise exception 'daily_session_limit'; end if;
  insert into public.resume_sessions (user_id, jd_text, profile_json)
  values (v_uid, p_jd, p_profile) returning id into v_id;
  return v_id;
end $$;

-- ============ admin: list users, set a limit ============
create or replace function public.admin_users()
returns table (user_id uuid, email text, joined_at timestamptz, last_sign_in_at timestamptz,
               full_name text, username text, resumes_24h int, resumes_7d int, daily_limit int)
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
           public.daily_limit_for(u.id)
      from auth.users u
      left join public.profiles p on p.user_id = u.id
     order by u.created_at desc
     limit 1000;
end $$;

create or replace function public.admin_set_limit(p_user uuid, p_limit int)
returns int
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  if p_limit is null or p_limit < 0 or p_limit > 50 then raise exception 'bad_limit'; end if;
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'user_not_found'; end if;
  insert into public.user_limits (user_id, daily_limit, updated_at, updated_by)
  values (p_user, p_limit, now(), lower(auth.jwt() ->> 'email'))
  on conflict (user_id) do update
    set daily_limit = excluded.daily_limit, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  return p_limit;
end $$;

-- ============ permissions ============
revoke all on function public.is_admin()                  from public, anon;
revoke all on function public.daily_limit_for(uuid)       from public, anon, authenticated;
revoke all on function public.my_daily_limit()            from public, anon;
revoke all on function public.admin_users()               from public, anon;
revoke all on function public.admin_set_limit(uuid, int)  from public, anon;
grant execute on function public.is_admin()                 to authenticated;
grant execute on function public.my_daily_limit()           to authenticated;
grant execute on function public.admin_users()              to authenticated;
grant execute on function public.admin_set_limit(uuid, int) to authenticated;
