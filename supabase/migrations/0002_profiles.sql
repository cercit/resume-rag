-- Profile panel (29 Oct 2026): an optional name and username, and the visitor's own recent resumes.

-- ============ optional name and username ============
create table public.profiles (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  full_name   text check (full_name is null or char_length(full_name) between 1 and 80),
  username    text unique check (username is null or username ~ '^[a-z0-9_]{3,20}$'),
  updated_at  timestamptz not null default now()
);
alter table public.profiles enable row level security;

create policy "own profile: read" on public.profiles
  for select to authenticated using (user_id = auth.uid());
create policy "own profile: insert" on public.profiles
  for insert to authenticated with check (user_id = auth.uid());
create policy "own profile: update" on public.profiles
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.profiles from anon;
grant select, insert, update on public.profiles to authenticated;

-- ============ the visitor's resumes from the last 7 days, newest first, with the current version ============
-- security invoker: RLS on resume_sessions and resume_versions decides what is returned.
create or replace function public.my_resumes()
returns table (session_id uuid, created_at timestamptz, tweaks_used int, max_tweaks int,
               current_version int, resume jsonb)
language sql stable security invoker
set search_path = public
as $$
  select s.id, s.created_at, s.tweaks_used, s.max_tweaks, s.current_version, v.resume_json
    from public.resume_sessions s
    join public.resume_versions v on v.session_id = s.id and v.version = s.current_version
   where s.user_id = auth.uid()
   order by s.created_at desc
   limit 25;
$$;
revoke all on function public.my_resumes() from public, anon;
grant execute on function public.my_resumes() to authenticated;
