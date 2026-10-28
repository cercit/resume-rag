-- ============ extensions ============
create extension if not exists vector with schema extensions;
create extension if not exists pg_cron;   -- for the 7-day purge; skip the cron block if unavailable

-- ============ RAG documents ============
create table public.documents (
  id            bigserial primary key,
  source        text not null,                 -- relative file path in knowledge/
  title         text,
  heading       text,                          -- nearest markdown heading
  topic         text,                          -- optional tag: 'bullets','ats','research','format'
  chunk_index   int  not null default 0,
  content       text not null,
  content_hash  text not null,
  metadata      jsonb not null default '{}'::jsonb,
  embedding     extensions.vector(384) not null,   -- gte-small = 384 dims
  created_at    timestamptz not null default now()
);
create unique index documents_content_hash_key on public.documents (content_hash);
create index documents_embedding_idx
  on public.documents using hnsw (embedding extensions.vector_cosine_ops);
create index documents_topic_idx on public.documents (topic);

alter table public.documents enable row level security;
-- no policies on purpose: only the service role (Edge Functions, ingest script) can read/write.

create or replace function public.match_documents(
  query_embedding extensions.vector(384),
  match_count     int   default 8,
  min_similarity  float default 0.0,
  filter_topic    text  default null
)
returns table (id bigint, source text, heading text, content text, similarity float)
language sql stable
set search_path = public, extensions
as $$
  select d.id, d.source, d.heading, d.content,
         1 - (d.embedding <=> query_embedding) as similarity
  from public.documents d
  where (filter_topic is null or d.topic = filter_topic)
    and 1 - (d.embedding <=> query_embedding) >= min_similarity
  order by d.embedding <=> query_embedding
  limit least(match_count, 20);
$$;
revoke all on function public.match_documents(extensions.vector, int, float, text) from public, anon, authenticated;
grant execute on function public.match_documents(extensions.vector, int, float, text) to service_role;

-- ============ sessions and versions ============
create table public.resume_sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  jd_text          text not null check (char_length(jd_text) <= 12000),
  profile_json     jsonb not null,            -- facts extracted from the visitor's resume
  current_version  int  not null default 0,
  tweaks_used      int  not null default 0,
  max_tweaks       int  not null default 10,
  busy_until       timestamptz,               -- blocks parallel LLM calls on one session
  created_at       timestamptz not null default now(),
  constraint tweaks_in_range check (tweaks_used between 0 and max_tweaks)
);
create index resume_sessions_user_created_idx on public.resume_sessions (user_id, created_at desc);

create table public.resume_versions (
  id           bigserial primary key,
  session_id   uuid not null references public.resume_sessions(id) on delete cascade,
  version      int  not null,
  resume_json  jsonb not null,
  tweak_text   text,                          -- null for the first generation
  created_at   timestamptz not null default now(),
  unique (session_id, version)
);

alter table public.resume_sessions enable row level security;
alter table public.resume_versions enable row level security;

create policy "own sessions: read" on public.resume_sessions
  for select to authenticated using (user_id = auth.uid());
create policy "own versions: read" on public.resume_versions
  for select to authenticated
  using (exists (select 1 from public.resume_sessions s
                 where s.id = session_id and s.user_id = auth.uid()));
-- no insert/update/delete policies: all writes go through the functions below.

-- ============ start a session (daily cap: 3 sessions / 24h / user) ============
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
  if v_count >= 3 then raise exception 'daily_session_limit'; end if;
  insert into public.resume_sessions (user_id, jd_text, profile_json)
  values (v_uid, p_jd, p_profile) returning id into v_id;
  return v_id;
end $$;

-- ============ claim the session before an LLM call ============
create or replace function public.begin_work(p_session uuid)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  update public.resume_sessions
     set busy_until = now() + interval '90 seconds'
   where id = p_session and user_id = auth.uid()
     and (busy_until is null or busy_until < now());
  return found;
end $$;

-- ============ save a version. Counts a tweak only when p_tweak is not null ============
create or replace function public.save_version(p_session uuid, p_json jsonb, p_tweak text default null)
returns table (out_version int, out_tweaks_used int)
language plpgsql security definer
set search_path = public
as $$
declare
  s public.resume_sessions;
  v_new_version int;
  v_new_tweaks  int;
begin
  select * into s from public.resume_sessions
   where id = p_session and user_id = auth.uid() for update;
  if not found then raise exception 'session_not_found'; end if;
  if p_tweak is not null and s.tweaks_used >= s.max_tweaks then
    raise exception 'tweak_limit_reached';
  end if;
  v_new_version := s.current_version + 1;
  v_new_tweaks  := s.tweaks_used + case when p_tweak is null then 0 else 1 end;
  insert into public.resume_versions (session_id, version, resume_json, tweak_text)
  values (p_session, v_new_version, p_json, p_tweak);
  update public.resume_sessions
     set current_version = v_new_version, tweaks_used = v_new_tweaks, busy_until = null
   where id = p_session;
  return query select v_new_version, v_new_tweaks;
end $$;

-- ============ release the claim when an LLM call fails (no tweak is charged) ============
create or replace function public.end_work(p_session uuid)
returns void
language sql security definer
set search_path = public
as $$
  update public.resume_sessions set busy_until = null
   where id = p_session and user_id = auth.uid();
$$;

-- ============ undo: drops the latest version, does NOT refund the tweak ============
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
  return v_json;
end $$;

-- ============ permissions ============
revoke all on function public.start_session(text, jsonb)       from public, anon;
revoke all on function public.begin_work(uuid)                 from public, anon;
revoke all on function public.save_version(uuid, jsonb, text)  from public, anon;
revoke all on function public.end_work(uuid)                   from public, anon;
revoke all on function public.undo_version(uuid)               from public, anon;
grant execute on function public.start_session(text, jsonb)       to authenticated;
grant execute on function public.begin_work(uuid)                 to authenticated;
grant execute on function public.save_version(uuid, jsonb, text) to authenticated;
grant execute on function public.end_work(uuid)                   to authenticated;
grant execute on function public.undo_version(uuid)               to authenticated;

-- ============ privacy: delete sessions after 7 days ============
select cron.schedule('purge-old-sessions', '17 3 * * *',
  $$delete from public.resume_sessions where created_at < now() - interval '7 days'$$);
