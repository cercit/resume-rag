# Resume Tailor

A new website and interactive waiting experience for the Resume Tailor PRD. Everything is contained in this folder. Since 29 Oct 2026 this folder is the live site: `.github/workflows/pages.yml` publishes it to https://cercit.github.io/resume-rag/ on every push to `main` (the `work/` folder and `START_SITE.cmd` are left out). The older `../web/` page is kept for reference and its tests.

The design follows [Sameer's portfolio](https://samsm.vercel.app/): DM Sans, charcoal `#0a0a0f`, amber `#f5a623`, white `#f1f2f5`, thin borders, restrained corners, and bold type. A light theme is also included. The font is served locally, copied from the portfolio's public font asset.

## Open it

Double-click `START_SITE.cmd` and keep its terminal window open. It serves this folder at **http://127.0.0.1:4173** using the Python already installed on this computer. Press Ctrl+C in that window when finished.

Or run this from this folder:

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

The landing page and sample demo also work by opening `index.html` directly. Use the local server for sign-in and PDF/DOCX extraction because browser restrictions vary for local files.

No build step or package installation is needed.

## Try the experience

The sample demo ("See it in action", "Use a sample", Replay and the `/#waiting` and `/#result` demo links) was removed on 29 Oct 2026. Every run is a real, signed-in request.

- **Review your resume** opens the PDF preview, keyword coverage, honest gaps, and edit controls.
- **Undo** restores the previous version without using another tweak. It does not refund an already completed tweak.
- A direct link or reload of `/#waiting` or `/#result` goes back to the start page. It never re-submits a resume.

## Waiting page

The sample runs five stages over 30 seconds: reading the resume (4s), understanding the role (5s), rewriting (10s), checking facts (7s), and preparing the layout (4s).

The page includes a real elapsed timer, twelve cycling tips, including encouragement and reminders to tailor for each role, Previous/Next/Pause controls, and three optional quizzes. Tips rotate every eight seconds. Manual navigation pauses rotation. Rotation pauses while the tab is hidden or focus is inside the tip card. A new run begins with a different tip. The result never replaces a quiz while someone is reading; a review button appears when ready.

The existing generation endpoint returns one response and does not stream stage events. Live requests therefore show an indeterminate activity bar and an elapsed timer. The stage list explains the process and is explicitly labelled as **not live status**. It gets completion marks only after the response arrives. It does not show fabricated percentages, stage completions, or countdowns. Slow-request messages appear at 75 and 90 seconds. After 180 seconds, the browser stops waiting and preserves the inputs. The server may continue processing after a browser cancellation.

## Motion and interaction

- Resume illustration with pointer tilt, a scanning highlight, slow orbit, and floating detail cards.
- Button hover movement and focus outlines.
- Soft page entrances and section reveals.
- Animated progress transitions and active stage marker.
- Tip carousel transitions and a small animated paper illustration.
- Light/dark toggle and a footer motion toggle.
- System `prefers-reduced-motion` disables nonessential animation and starts tips paused.
- Drag-and-drop or click-to-select PDF, DOCX, or TXT, with editable extracted text.

## Existing backend

`config.js` contains only the public Supabase URL and anonymous browser key copied from the existing app. Do not place service-role keys, OpenRouter keys, or other secrets here.

`api.js` uses the existing contracts:

| Action | Existing service |
| --- | --- |
| Email code | Supabase Auth `signInWithOtp` and `verifyOtp` |
| Generate | `POST /functions/v1/generate` with `resume_text`, `jd_text` |
| Tweak | `POST /functions/v1/tweak` with `session_id`, `instruction` |
| Undo | Supabase RPC `undo_version`, parameter `p_session` |

Auth and parsing libraries load only when needed. The landing page and demo do not contact the resume service. Supabase and Mammoth use the same pinned versions as the existing app. PDF.js uses the existing 4.4.168 version with eval disabled. Resume files are parsed locally; only text is submitted when the visitor generates a resume after signing in.

The backend remains responsible for factual guards, daily limits, tweak limits, access controls, and seven-day deletion. The UI cannot enforce or verify those guarantees on its own. Email delivery and production AI generation require a live signed-in check; they were not triggered as part of design testing.

This design replaced the older `../web/` page as the live website on 29 Oct 2026.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Landing page, workspace, waiting page, result editor, and dialogs |
| `styles.css` | Portfolio-derived styling, responsive layouts, animations, and reduced motion |
| `app.js` | Page state, controls, elapsed timers, demo, auth UI, editing, and preview |
| `api.js` | Lazy auth client, existing API calls, and browser file extraction |
| `demo-data.js` | Fictional candidate, sample role, tips, and quiz content |
| `render.js` | Existing A4 renderer, with an oversized-block page-count fix |
| `config.js` | Public browser configuration only |
| `assets/` | Local font and favicon |
| `work/` | Design reference notes and validation artifacts |

The browser print dialog is the PDF export. Choose **Save as PDF**, A4, and turn off headers and footers. Review all details and the resulting page count before applying.
