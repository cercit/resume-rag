-- 0005 (30 Oct 2026): one admin-only call that feeds the Admin Console charts.
-- Counts only; no resume or JD text. Resumes per day take the larger of the generate signals (kept 180 days,
-- from 30 Oct 2026) and the sessions still stored (kept 7 days), so days before the signals began still show.
create or replace function public.admin_overview(p_days int default 30)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_days int := least(greatest(coalesce(p_days, 30), 7), 180);
  v_from date := current_date - (v_days - 1);
begin
  if not public.is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  return jsonb_build_object(
    'days', v_days,
    'daily', (
      select jsonb_agg(jsonb_build_object(
               'day', d::date,
               'resumes', greatest(
                  (select count(*) from public.quality_signals q where q.kind = 'generate' and q.created_at::date = d::date),
                  (select count(*) from public.resume_sessions s where s.created_at::date = d::date)),
               'signups', (select count(*) from auth.users u where u.created_at::date = d::date),
               'downloads', (select count(distinct q.session_id) from public.quality_signals q where q.kind = 'download' and q.created_at::date = d::date),
               'feedback', (select count(*) from public.feedback f where f.created_at::date = d::date))
             order by d)
        from generate_series(v_from, current_date, interval '1 day') d),
    'funnel', jsonb_build_object(
      'signed_up',   (select count(*) from auth.users),
      'made_resume', (select count(*) from public.usage_totals),
      'downloaded',  (select count(distinct user_id) from public.quality_signals where kind = 'download' and user_id is not null)),
    'tweak_types', (
      select coalesce(jsonb_agg(jsonb_build_object('label', t, 'count', n) order by n desc), '[]'::jsonb)
        from (select coalesce(data ->> 'category', 'other') t, count(*) n from public.quality_signals
               where kind = 'tweak' and created_at >= v_from group by 1) x),
    'tweak_outcomes', (
      select coalesce(jsonb_agg(jsonb_build_object('label', t, 'count', n) order by n desc), '[]'::jsonb)
        from (select coalesce(data ->> 'outcome', 'unknown') t, count(*) n from public.quality_signals
               where kind = 'tweak' and created_at >= v_from group by 1) x),
    'dropped_keywords', (
      select coalesce(jsonb_agg(jsonb_build_object('label', k, 'count', n) order by n desc), '[]'::jsonb)
        from (select lower(e.k) k, count(*) n
                from public.quality_signals q, jsonb_array_elements_text(coalesce(q.data -> 'keywords_dropped', '[]'::jsonb)) e(k)
               where q.kind = 'generate' and q.created_at >= v_from group by 1 order by 2 desc limit 10) x),
    'roles', (
      select coalesce(jsonb_agg(jsonb_build_object('label', r, 'count', n) order by n desc), '[]'::jsonb)
        from (select data ->> 'role' r, count(*) n from public.quality_signals
               where kind = 'generate' and created_at >= v_from and coalesce(data ->> 'role', '') <> ''
               group by 1 order by 2 desc limit 8) x),
    'feedback_kinds', (
      select coalesce(jsonb_agg(jsonb_build_object('label', kind, 'count', n) order by n desc), '[]'::jsonb)
        from (select kind, count(*) n from public.feedback where created_at >= v_from group by 1) x),
    'feedback_status', (
      select coalesce(jsonb_agg(jsonb_build_object('label', status, 'count', n) order by n desc), '[]'::jsonb)
        from (select status, count(*) n from public.feedback group by 1) x),
    'requests', (
      select coalesce(jsonb_agg(jsonb_build_object('label', status, 'count', n) order by n desc), '[]'::jsonb)
        from (select status, count(*) n from public.limit_requests group by 1) x),
    'extra_granted', (select coalesce(sum(granted), 0) from public.limit_requests where status = 'approved'),
    'ratings', jsonb_build_object(
      'up',   (select count(*) from public.quality_signals where kind = 'rating' and (data ->> 'up')::boolean and created_at >= v_from),
      'down', (select count(*) from public.quality_signals where kind = 'rating' and not (data ->> 'up')::boolean and created_at >= v_from)));
end $$;

revoke all on function public.admin_overview(int) from public, anon;
grant execute on function public.admin_overview(int) to authenticated;
