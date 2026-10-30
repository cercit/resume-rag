# Feedback and weekly review plan

**Goal:** Learn every week how to make the tailored resumes better, using three sources:
1. how well each resume matched its job description;
2. what people changed with tweaks after generation;
3. what they tell us in a feedback form (bugs, improvements, other ideas).

**How it works, in one picture:**

```
generate / tweak / undo / download  ──►  quality_signals (no resume text)
feedback form (bug / improvement / idea) ──►  feedback
                       every Monday
          build_weekly_report()  ──►  weekly_reports (numbers)
          weekly-review function ──►  weekly_reports.suggestions (top 5 ideas, with evidence)
                       you, in admin
          read report, pick changes ──► I change prompts/guards with a test ──► next week shows if it helped
```

Nothing changes the prompts on its own. The weekly review suggests; you decide; changes go through the existing tests.

**Stack:** Supabase (Postgres + pg_cron + Edge Functions), the existing site (`site/`), OpenRouter (already used).

## Ground rules (apply to every step)

- **Privacy:** the 7-day promise stays.
  - Resume text and JD text are never copied out of `resume_sessions`. The purge still deletes them after 7 days.
  - Signals hold only JD keywords, counts, categories, timings and the role title.
  - Tweak text is kept as its category plus a scrubbed copy of up to 200 characters, for 30 days.
  - Feedback is kept for 90 days.
- **Scrub before any LLM call:** remove emails, phone numbers, URLs and numbers of 4 or more digits from feedback and tweak text first.
- **Signals never break the user's flow:** if writing a signal fails, the resume or tweak still returns normally (log only).
- **Feedback is for signed-in users only:** at most 5 per user per day, message length 5–2000 characters.
- **Live SQL:** you run it in the SQL editor. I put it on your clipboard and check its length, then probe it (PGRST202 means missing, 42501 means it exists).
- **Workflow:** commit after each step, and add a row to `running_note.md` after each step.

## What the weekly report shows

| Number | Why it matters |
|---|---|
| Resumes made, people, average time, errors by type | Health |
| **Download rate** (resumes downloaded ÷ resumes made) | Headline success measure: did they use it? |
| **Dropped keywords:** JD keywords that are in the uploaded resume but missing from the tailored one | Our misses. This is the main "improve from the JD" signal |
| Missing keywords: JD keywords not in the resume at all | The candidate's gaps, not ours. Shows which roles people apply for |
| Top role types (from the JD title) | Which kinds of jobs to tune for first |
| Tweaks per resume, top tweak types, undo rate, refusal rate | What the first draft gets wrong. Example: lots of "shorten" tweaks means the default should be shorter |
| Thumbs up % and feedback count by type | How people feel |
| Top 5 suggestions, each with its evidence count | What to change next |

---

## Phase 1: Collect signals (backend)

### Step 1: Database tables (migration `0004_feedback.sql`)

**Files:** create `supabase/migrations/0004_feedback.sql`; add section 15 to `tests/sql/test_schema.sql`; apply 0004 in `tests/sql/reset_local_db.sh`.

**Tables:**
- `quality_signals`:
  - `id`, `user_id`, `session_id` (nullable, no foreign key, so the purge doesn't remove it), `kind`, `data jsonb`, `created_at`;
  - `kind` is one of `generate`, `tweak`, `undo`, `download`, `rating`.
- `feedback`:
  - `id`, `user_id`, `kind`, `message`, `rating` (1–5, nullable), `context`, `session_id` (nullable);
  - `kind` is one of `bug`, `improvement`, `idea`;
  - `context` is one of `general`, `after_generate`, `after_tweak`;
  - `status` is one of `new`, `planned`, `done`, `wont_do` (default `new`);
  - plus `created_at`.
- `weekly_reports`: `week_start date pk`, `numbers jsonb`, `suggestions jsonb` (nullable), `created_at`.

**Functions:**
- `record_signal(p_kind text, p_session uuid, p_data jsonb)`:
  - security definer, granted to `authenticated`;
  - refuses unknown kinds and `p_data` over 4 KB.
- `submit_feedback(p_kind, p_message, p_rating, p_context, p_session) returns bigint`:
  - enforces 5 per day and 5–2000 characters;
  - error codes `feedback_limit` and `feedback_length`.
- `admin_feedback(p_days int default 30)` and `admin_set_feedback_status(p_id bigint, p_status text)`: admins only (42501 otherwise).
- `undo_version` also writes an `undo` signal.

**Row-level security and grants:**
- All three tables have RLS on and no policies, so direct access goes only through the functions above.
- Users can't read `feedback` or `quality_signals` directly.

**Cron jobs:**
- `purge-feedback`: daily; deletes feedback over 90 days, tweak-text in signals over 30 days, and signals over 180 days.

**SQL tests:**
- unknown kind refused;
- 6th feedback in a day refused;
- 4-character message refused;
- normal user can't call `admin_feedback`;
- `undo_version` writes a signal;
- purge removes 91-day-old feedback.

**Live:** you run 0004, then I probe `record_signal` and `submit_feedback` as anon and expect 42501.

### Step 2: Signals from generate

**Files:**
- create `supabase/functions/_shared/signals.ts` and `tests/functions/signals_test.ts`;
- modify `_shared/pipeline.ts` (in `generate`, after `final` is built);
- modify `_shared/supabase.ts` and `tests/functions/harness.ts`.

**Code:**
- `signalsFromGenerate(sourceText: string, final: Resume, notes: Notes, ms: number): GenerateSignal`. The result holds:
  - `role` (JD title, lowercase, max 60 characters);
  - `keywords_missing: string[]`;
  - `keywords_dropped: string[]` (keywords in `notes.keywords_missing` that appear in `sourceText`, case-insensitive, whole word);
  - `jobs`, `bullets`, `guard_fixes`, `ms`.
- `Db` gets `recordSignal(kind: string, session: string | null, data: unknown): Promise<void>`. The real version calls the RPC and swallows errors.

**Tests:**
- "Power BI" in the source but missing from the output → shows up in `keywords_dropped`;
- "Kubernetes" not in the source → only in `keywords_missing`;
- `recordSignal` throwing still returns 200 from `generate`.

### Step 3: Signals from tweaks, downloads and undo

**Files:** modify `signals.ts`, `pipeline.ts` (`tweak`), `site/app.js` (download button), `site/api.js`; add tests to `signals_test.ts`.

**Code:**
- `tweakCategory(instruction: string): TweakCategory`. Rule-based, no extra LLM call. The categories are `shorten | lengthen | add_keyword | tone | reorder | remove | format | other`. Order of checks: remove, shorten, lengthen, reorder, format, tone, add_keyword, other.
- `scrub(text: string): string` (emails, phones, URLs, 4+ digit numbers → `[x]`), capped at 200 characters.
- The tweak signal records the category, the outcome (`applied | refused | failed`), the scrubbed text and the ms.
- Site: `API.recordSignal('download', sessionId, {})` when the PDF is downloaded.

**Tests:**
- "make the summary shorter" → `shorten`;
- "add SQL to skills" → `add_keyword`;
- "call me on 98220 41736" → scrubbed to "call me on [x]";
- a refused tweak records `refused`.

## Phase 2: Feedback form (site)

### Step 4: Feedback dialog and thumbs strip

**Files:** modify `site/index.html` (dialog plus the "Feedback" link in the header menu and the footer), `site/app.js`, `site/api.js`, `site/styles.css` (14px floor).

**Dialog:**
- **Type:** Bug / Improvement / Idea (three buttons, Improvement selected).
- **Message:** the placeholder changes with the type. For Idea it reads "What else would make this better for you?"
- **Rating:** optional 1–5.
- **Checkbox:** "Link this resume so we can see which job it was for", ticked when opened from a result. Only the session id is sent.

**After a resume is generated, and after each tweak:** a strip under the result reads "How did this turn out? 👍 👎".
- 👍 records a `rating` signal.
- 👎 records it and opens the dialog with the context set to `after_generate` or `after_tweak`.

**Signed out:** the link opens sign-in first, the same way Tailor does.

**API:** `API.sendFeedback({ kind, message, rating, context, sessionId }) → id`. Errors map to the messages "You've sent 5 today, thank you. Try again tomorrow." and "Please write 5 to 2000 characters."

**Check:** run a local preview, send one of each type, check the 6th is refused, then **stop the server**.

### Step 5: Privacy text

**File:** `site/index.html`. Add one privacy item:

> **Improving the tool:** We keep anonymous numbers, such as which job keywords were matched, which kinds of changes people ask for and whether the PDF was downloaded. They never include your resume text. Feedback you send is kept for 90 days.

Also update the short note under the Tailor button to match.

## Phase 3: Weekly review

### Step 6: Weekly numbers in SQL

**Files:** create `supabase/migrations/0005_weekly_report.sql`; add tests to `test_schema.sql`.

- `build_weekly_report(p_week_start date default date_trunc('week', now())::date - 7) returns jsonb`. It fills every number in the table above from `quality_signals`, `feedback` and `resume_sessions`, and upserts `weekly_reports`.
- Cron `weekly-report`: Monday 02:00 UTC (07:30 IST).

**Test:** seed 3 generate signals, 2 shorten tweaks, 1 download and 1 bug, then check the counts, download rate 33%, and top tweak type `shorten`.

### Step 7: Weekly suggestions (Edge Function `weekly-review`)

**Files:** create `supabase/functions/weekly-review/index.ts`, `_shared/weekly.ts` and `tests/functions/weekly_test.ts`.

- **Trigger:** pg_cron at Monday 02:15 UTC calls the function through `pg_net`, with a secret header (`WEEKLY_SECRET` in function secrets). Requests without the secret get 401.
- **Input:** last week's `numbers`, plus at most 100 feedback messages and 100 tweak texts, all scrubbed again.
- **Prompt rule:**
  - give the top 5 changes, each with `what`, `why`, `evidence_count` and `area`;
  - `area` is one of `prompt | guard | ui | bug`;
  - only suggest what the evidence shows;
  - no personal details.
  - The output is checked with a zod schema and saved to `weekly_reports.suggestions`.
- **Tests:** scrubbing runs before the LLM call (a fake LLM sees no email), there's a 401 without the secret, and invalid LLM output gets one retry, then is saved as `null` with an error note.

### Step 8: Admin page tabs

**Files:** `site/admin.html` and `site/admin.js`; `site/api.js` gets `adminFeedback`, `adminSetFeedbackStatus` and `adminWeeklyReports`.

There are three tabs: **Users** (as now), **Feedback** and **Weekly review**.

- **Feedback tab:**
  - filter by type and status;
  - each row shows date, type, message, rating, context, and "linked resume: role + dropped keywords";
  - a status dropdown per row.
- **Weekly review tab:**
  - pick a week;
  - the numbers card shows each number with its change from last week (▲▼);
  - then the top dropped keywords, top tweak types and the 5 suggestions.

**Check:** live, with a temporary admin and test users, the same way as `admin_test.py`, in a new `tests/live/feedback_test.py`.

## Phase 4: Closing the loop (every week, about 30 minutes)

1. On Monday, open Admin → Weekly review.
2. Pick 1–2 suggestions and tell me which.
3. I make the change (a prompt, guard or UI change) with a test that shows it, deploy it, and log it in `docs/improvement_log.md`, noting the week, the change, and the number it should move.
4. The next Monday, the report shows whether that number moved. If it didn't, we revert or try again.
5. Mark the related feedback as `done` so people's reports are tracked to the end.

**Optional, later:** a scheduled GitHub Action runs `tests/live/live_test.py` on synthetic resumes every Sunday. Prompt changes then get checked on the same fixed examples each week, with no real user data. The cost is about 4 free-model calls a week.

## Review focus (things tests must also cover)

- Personal details typed into feedback or tweaks (phone, email): scrubbed before the LLM, and only admins can read the raw feedback.
- A spammy user: the 6th feedback in a day is refused, and over-long text is refused at the database, not just in the browser.
- A signal write that fails or is slow must not delay or fail a resume. Test: `recordSignal` throws, and `generate` still returns 200.
- A week with no data: the report shows zeros, and the suggestions say "not enough data".
- A purged session linked from feedback: the admin row shows "resume expired" instead of an error.

## Build order and size

| Step | What | Who runs live SQL |
|---|---|---|
| 1 | Tables + functions (0004) | You |
| 2–3 | Signals from generate / tweak / download / undo | – (edge deploy) |
| 4–5 | Feedback form, thumbs strip, privacy text | – (site push) |
| 6 | Weekly numbers (0005) | You |
| 7 | Weekly suggestions function | – (edge deploy + secret) |
| 8 | Admin tabs | – |

Steps 1–5 give you feedback and signals straight away. Steps 6–8 need at least one week of data before the report shows anything useful.

## Added on 30 Oct 2026: counter and "request more"

- **All-time counter:** `usage_totals` keeps one row per person with their resume count. It holds counts only, so it survives the 7-day purge. `public_stats()` feeds "N people have tailored M resumes here" under the hero. The admin page shows the same totals, plus sign-ups.
- **Request more resumes:** when the daily limit is used up, the error and the profile panel show **Request more resumes**. The visitor asks for 1 to 20 and can add an optional reason.
  - They can have one request waiting at a time, and send at most 3 a day.
  - In Admin → Requests, you approve the number asked for or type a different one (1 to 50), or decline.
  - Approved resumes are added as **extra** resumes. They're used after the daily limit and never expire.
  - The profile shows: waiting, approved (how many), or not approved.
- Built in this order, together with Phase 1, Phase 2 and the weekly numbers (Step 6).
- Step 7 (AI suggestions) waits until there's at least one week of data.
