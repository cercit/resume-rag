# Resume RAG tool

A public web page where someone uploads or pastes their resume, pastes a job description and gets a tailored 2-page PDF in Sameer's resume format. They can then ask for up to 10 changes ("shorten the summary"). Facts come only from their own resume. The writing advice comes from the documents in `knowledge/`.

- Front end: `web/` (plain HTML and JS, GitHub Pages)
- Back end: Supabase project `jkionnbbtnwloavmhcdn` (Postgres + pgvector, Edge Functions `generate` and `tweak`)
- LLM: OpenRouter, models set in `.env`

## Where the keys go

| Key | Where | Who sets it |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD`, `LLM_API_KEY` | `.env` on your PC only (gitignored) | you |
| `LLM_API_KEY`, model names, `ALLOWED_ORIGIN` | Supabase Edge Function secrets | `python scripts/set_secrets.py` copies them from `.env` |
| Supabase URL and anon key | `web/config.js` (public values, safe to commit) | you, once |

Never put the service-role key or the OpenRouter key in `web/` or in a commit.

## First-time setup (about 15 minutes)

1. Copy `.env.example` to `.env` and fill it in. The values are in Supabase under Project Settings > API and Project Settings > Database, and the OpenRouter key is in your OpenRouter account.
2. Log the CLI in: `npx supabase login`.
3. Run everything: `bash scripts/deploy.sh`. It links the project, pushes the database migration, applies the auth settings from `supabase/config.toml`, sets the Edge Function secrets, deploys the functions, loads `knowledge/` into the database, checks the embeddings and runs the live tests. Each step prints ok or FAILED.
   - If the migration stops at `pg_cron`: Dashboard > Database > Extensions, turn on `pg_cron`, then run `npx supabase db push` again.
4. Put the Supabase URL and anon key in `web/config.js`.
5. Set up email sending (next section). Without it, sign-in codes only reach members of your own Supabase organization, so visitors cannot sign in.

## Sign-in emails: set up free SMTP (needed before going public)

Supabase's built-in email sender only delivers to email addresses of your own Supabase organization's members, and only a few emails an hour, so visitors would never get their code. Use a free SMTP service instead. Brevo works without owning a domain:

1. Create a free account at brevo.com (300 emails a day).
2. Senders, Domains & Dedicated IPs > Senders > Add a sender: use your own email address and click the link Brevo sends you.
3. SMTP & API > SMTP tab > Generate a new SMTP key. Note the login shown on that page.
4. Supabase Dashboard > Authentication > Emails > SMTP Settings > Enable custom SMTP:
   - Host `smtp-relay.brevo.com`, port `587`
   - Username: the Brevo SMTP login, password: the SMTP key
   - Sender email: the address you verified in step 2, sender name `Resume tailor`
5. Supabase Dashboard > Authentication > Rate Limits: set "emails sent per hour" to 30.
6. Send yourself a code from the site to check it arrives (look in spam the first time).

Resend's free plan also works but can only email your own address until you verify a domain, so it does not suit a public tool without a domain.

## Going live on GitHub Pages

The repo is private. GitHub Pages on a free account only publishes public repos, so pick one: make the repo public (nothing secret is in it), or upgrade to GitHub Pro. Then:

1. Settings > Pages > Source: GitHub Actions.
2. Merge the work into `main`. `.github/workflows/pages.yml` publishes `web/` on every push to `main`.
3. The site is at `https://cercit.github.io/resume-rag/`. That address is already the Site URL in `supabase/config.toml` and `ALLOWED_ORIGIN` in `.env`.

## Adding or changing knowledge documents

1. Put `.md`, `.txt` or `.pdf` files in `knowledge/` (images are skipped).
2. `pip install -r ingest/requirements.txt` (first time only).
3. `python ingest/ingest.py`. It only adds what changed and removes chunks of files you deleted or edited. `python ingest/ingest.py --dry-run` shows the chunks without touching the database.
4. `python ingest/ingest.py --check` confirms the database finds a chunk by its own text (similarity above 0.95).

## Rotating keys

- OpenRouter: create a new key, put it in `.env`, run `python scripts/set_secrets.py`, then delete the old key in OpenRouter.
- Supabase service-role or anon key: Project Settings > API > roll the key. Update `.env`. For the anon key, also update `web/config.js` and push. The Edge Functions pick up the new keys by themselves.
- Database password: Project Settings > Database > reset, then update `.env`.

## Changing the models

Edit `LLM_MODEL_GENERATE` and `LLM_MODEL_TWEAK` in `.env` and run `python scripts/set_secrets.py`. Free OpenRouter models are reasoning models: keep the output limits in `supabase/functions/_shared/pipeline.ts` (`TOKENS`) at 2500 or more for generate and 1500 or more for tweaks.

## Limits and privacy

- 3 sessions per user per day, 10 tweaks per session. Undo is free. A failed or refused change does not use a tweak. All of this is enforced in the database (`supabase/migrations/0001_schema.sql`).
- Only text goes to the LLM. Files are turned into text in the visitor's browser.
- Sessions (resume text, job description, versions) are deleted after 7 days by the `purge-old-sessions` job.

## Tests

`bash tests/run_all.sh` runs the offline tests: ingestion, database rules, both Edge Function flows with a fake LLM, the render port against `base/build_resume.py`, and the web page in a browser. `python tests/live/live_test.py` runs the same rules against the real project with two throwaway users and deletes them afterwards. The `running_note.md` file records every step and test result.
