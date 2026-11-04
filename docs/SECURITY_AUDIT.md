# Security audit — Salisbury RE Desk (local desktop app)

Scope: single-user Windows desktop app holding client PII (names, contacts, addresses, birthdays), signed transaction
PDFs and a Google account link for a licensed REALTOR. No accounts, no server, no multi-tenancy. Standing gate
(enterprise-security-audit) applied as a local threat model. Re-audited 2026-09-07 after the Google, agents and
prefill work.

## Data at rest
- SQLite `Documents\Salisbury RE\redesk.db` + PDFs under `Documents\Salisbury RE\Clients\`. Protected by the Windows
  user account and whatever disk encryption the laptop has. **Open:** BitLocker status not verified; turn it on.
- Google Drive File Stream syncs `Documents\` (Cory's choice for backup). Transaction records therefore also live in
  Cory's Google account. Broker copy still required by ICA 3.4 (Complete File export).
- **Secrets never touch the synced folder.** The Google OAuth client secret, refresh token and access token are stored
  DPAPI-encrypted for Cory's Windows account under `%USERPROFILE%\.salisbury-re\secrets\*.bin` (Rust `secret_set` /
  `secret_get`, `CryptProtectData` with `CRYPTPROTECT_UI_FORBIDDEN`). A copy of those files on another machine or
  user account does not decrypt. The settings table holds only the public client id, the token expiry timestamp and
  the account email. A one-time migration blanks any secret an earlier build wrote to the settings table.
- Daily `VACUUM INTO` backup under `Backups\` (14 kept). Backups contain PII; same folder, same protection.
- **Client documents (2026-09-07).** Every filed document is COPIED (never moved, never deleted by the app) into
  `Clients\<Last, First - Address>\<numbered subfolder>` chosen by its kind (`src/lib/documents.ts` `KIND_FOLDER`:
  01 Agreements, 02 Disclosures, 03 Contract & Addenda, 04 Inspection & Appraisal, 05 Title & Closing,
  06 Communications, 00 Intake), registered in `documents` with its sha256 and logged as `document.filed`. The kind is
  guessed from page 1 but Cory confirms it before filing (no silent classification).

## Network
- **Google (2026-09-07, four scopes, one consent).** OAuth 2.0 Desktop-app client with PKCE and a loopback redirect
  (127.0.0.1:8794), Google Cloud project `salisbury-re-desk` owned by Cory's own account. Scopes and what the code does
  with them: `calendar.events` (create/update only the events it made, tracked in `calendar_links`), `gmail.compose`
  (drafts only, never send, never read), `drive.file` (upload files Cory picks into Drive > "Salisbury RE Desk" >
  <client folder>, share view-only with one address or by link, tracked in `google_drive_files`; the scope cannot see
  any other Drive file), `contacts` (create/update one Google Contact per client on click, tracked in
  `google_contacts`). No `gmail.send`, no `gmail.readonly`, no full `drive`. Granted scopes are recorded at connect time
  (`google_scopes`); a token that predates a scope disables that feature with a "reconnect" message instead of failing.
  The "unverified app" screen is expected: the client is private to Cory, not submitted for Google verification.
  Endpoints allowed by the webview CSP: oauth2.googleapis.com, www.googleapis.com, gmail.googleapis.com,
  people.googleapis.com.
- **Idempotent pushes (2026-09-07).** Every Google write is guarded three ways: an in-process lock per key (a
  second click joins the running push), the local link tables (`calendar_links`, `google_drive_files`,
  `google_contacts`, `google_gmail_drafts`), and a read-back from Google before anything is created (events by the
  private tag `redesk_key`/`redesk_tx` or by summary + day, Drive by file name inside the app's folder, Contacts by
  client-id tag / email / phone, drafts by id). The app deletes from Google in exactly three cases, all limited to events it made itself and all logged with
  ids: a full calendar purge that runs only on request (Settings button or the `google_calendar_purge_requested`
  flag, `google.calendar.purged`; recognises its events by tag, signature, .ics UID or an exact app-written title), "Remove duplicates" on the calendar card (`google.calendar.duplicates_removed`, one copy always kept) and the
  Calendar Scope automation / push, which removes its own events of kinds that Settings no longer allows on the
  calendar (`google.calendar.out_of_scope_removed`; default scope is deadlines only).
- **Address lookups (2026-09-08, CMA from an address).** The only non-Google network calls, made from Rust
  (`geocode_lookup`, `ureq`), never from the webview: Utah's statewide address points (UGRC, ArcGIS Online, public,
  county-maintained, knows new subdivisions), then the US Census geocoder, then OpenStreetMap Nominatim (one request
  per second, User-Agent "SalisburyREDesk/0.1 (https://salisburyre.com)", house- or street-level matches only). Each
  receives a property address (the subject or a comp from an MLS export), never a client name, phone or document;
  replies are cached in `geocache` so an address is sent once. Settings `geocoder = off` disables all three; Cory
  can paste coordinates instead. The webview CSP allows no geocoder host. MLS export rows live in `mls_comps` (public listing data Cory is
  licensed to use as a member; never redistributed); saved CMAs in `cmas` with the PDF in the client folder or
  `Documents\Salisbury RE\CMAs`.
- Credentials import: the console's `client_secret_*.json` can be picked from Downloads (fs scope) and is split at once
  into the public client id (settings table) and the secret (DPAPI blob). The JSON file itself is never copied.
- Outbound HTTPS only to: `commerce.utah.gov` (state forms), the model download host (opt-in), and, only after Cory
  connects it, `oauth2.googleapis.com`, `www.googleapis.com`, `gmail.googleapis.com`. Enforced by the webview CSP
  `connect-src` list in `tauri.conf.json`; every other host is blocked at the browser layer.
- The LLM is `redesk-llm.exe` on `127.0.0.1:8093` (or Ollama on `127.0.0.1:11434`); nothing leaves the machine.
- The only listener the app ever opens is the OAuth loopback (`oauth_listen`, `127.0.0.1:8794`): it accepts one
  connection, reads one request line, answers a static HTML page and exits; it is only alive for the minutes of a
  connect flow and never on a non-loopback address. State + PKCE are verified before a code is exchanged.
- Google scopes are the minimum for the feature: `calendar.events` (create/update the app's own events) and
  `gmail.compose` (drafts only; the app cannot send mail). Disconnect wipes the tokens.

## Process isolation
- Sidecars are spawned by the Rust shell with `CREATE_NO_WINDOW`, stdin/stdout piped (doc engine) or null (LLM).
  They run as Cory's user. The doc engine only reads and writes paths handed to it by the UI: the data root,
  Downloads, Desktop, or a path Cory typed. `pdf.stamp` / `pdf.make` write only under the client folder.
- Tauri capabilities are deny-by-default; fs scope = `$DOCUMENT/Salisbury RE`, `$HOME/.salisbury-re`, `$DOWNLOAD`,
  `$DESKTOP`. `shell:allow-open` is limited to opening URLs/paths in the default handler.

## Local-model agents (Coordinator, Listing, Follow-up, Packet, Content)
- **Programmed first (2026-09-08, Cory: stay fully local, improve the programmed agents).** The questions each agent
  exists for (what is at risk, what is missing from each Complete File, today's ten touches, this week's seller
  updates, the reel plan) are computed by code from the database (`src/lib/reports.ts`, two read-only SQL views
  `v_at_risk` and `v_packet_gaps`) and rendered from templates (`src/lib/drafts.ts`, `templates/drafts.json`).
  No model runs, nothing can be invented, and the answer is labelled "exact: computed from your database".
- **Every remaining model call has a hard shape and a reviewer.** zod schemas (`src/lib/schemas.ts`) gate the four
  model jobs and every tool argument (unknown keys, wrong types and out-of-range values are refused before a query
  runs). The Monitor (`src/lib/monitor.ts`, no model) extracts every date, amount, percentage, phone, email, address,
  time and name pair from a model output and requires each to appear in the data the model was given; an unverified
  fact marks the output amber, lists it, and blocks Copy and Gmail draft until Cory edits the text.
- **Confidence loop (`src/lib/loop.ts`).** Each model job runs read -> research -> task -> test up to five passes and
  completes only above the accuracy bar (Settings, 95%). Passes 1 and 2 keep the approach and feed the reviewer's
  findings back; from pass 3 the job steps down its strategy ladder (extraction: whole page -> one field in a narrowed
  window -> re-read the scan at 300 dpi -> rules only; drafts: polish -> strict -> drop unverifiable sentences -> the
  computed draft; packet picks: model -> strict -> name similarity -> none; agents: tools -> briefing only -> drop
  unverifiable sentences). After the last pass it fails loudly: nothing committed, nothing sent, every pass in
  `model_runs` (grounding score, unverified facts, passes, strategy).
- **Self-improvement is memory, never code.** `agent_lessons` records, per job and failure kind, the strategy that
  failed and the one that passed; the next run with the same failure starts there and gets a one-line hint built from
  problem kinds only (never from document text). Bounded to 20 rows per job; the Audit page lists and can forget them.
- **Drift canary.** Once a day the Model Canary automation runs the fake sample listing agreement through the
  Extraction Agent and compares three known values; a miss turns the Audit row red before the model touches a real
  file. Model outputs never reach a calendar, a form or a client without the two-person rule.
- **Independence.** No import, path or dependency points at any older project; `src/lib/independence.test.ts` fails
  the suite if one appears.
- **Read-only by construction.** Every tool is a SELECT-style read (`src/lib/agents.ts` `runTool`); there is no tool
  that writes, sends, signs or deletes. Anything the agent proposes is text that Cory copies or a draft Gmail he
  reviews. The model cannot reach Google, the filesystem or the DB except through those named reads.
- **Per-agent allowlist enforced in code**, not in the prompt: a tool call naming a tool outside the agent's own list
  returns an error object to the model instead of running. Tool rounds are capped at 4, calls per round at 4, tool
  output at 6,000 characters, user input at 8,000 characters.
- **Prompt-injection posture:** all tool results, pasted email threads and extracted document text are wrapped in
  `<data>` tags and the system prompt states that data is never an instruction. Because there are no write tools,
  a successful injection can at worst produce a bad draft, which still passes the deterministic compliance gate
  (`src/lib/compliance.ts`) before it is shown.
- **Audit:** every run is logged to `model_runs` (purpose, latency, tools called, compliance verdict).
- The packet auto-build uses a JSON-schema-constrained call and shows proposals behind checkboxes; nothing is added
  to a template without a click.

## Claude on Cory's subscription (2026-09-10, opt-in)
- Settings > AI switches the model jobs from the local Qwen to **Claude Code's headless mode** (`claude -p`), which
  runs on Cory's own Claude subscription: no API key exists anywhere, nothing is billed per token. Rust `claude_run`
  spawns the CLI with our own system prompt, every built-in tool disallowed, `--bare`, no session persistence, an
  empty scratch working directory and a hard timeout; the model can only read the prompt and answer. Per-job model
  choice (Haiku 4.5 / Sonnet 5 / local) in Settings; local is the automatic fallback when the CLI is signed out,
  offline or at its usage limit, and each fallback is logged (`ai.fallback_local`). `model_runs.model` records which
  model answered. What leaves the laptop with Claude on: the text of that job (a contract page, a briefing). The
  Monitor's grounding check, the compliance gate and the 95% loop apply to Claude's answers exactly as to the local
  model's. Cory is asked to turn off "Help improve Claude" in claude.ai privacy settings so client text is not used
  for training.

## salisburyre.com CRM link (2026-09-10)
- The app signs in to Cory's own Supabase project (`nlnahfapzrmihqflwrac`) as Cory's CRM user with Supabase Auth's
  password grant; the password is used for one request and never stored; refresh/access tokens are DPAPI-encrypted.
  The project's public anon key is embedded (it ships to every browser visiting the site); row access is governed by
  RLS as the signed-in user. Two policies were added on the site side so signed-in users may read website `leads`
  and mark them worked (inserts stay service-role only). The app pulls leads and contacts into `crm_inbox` (Cory
  decides who becomes a client) and pushes clients, deals, contract milestones and showings; `crm_links` makes every
  push idempotent; the app never deletes on either side. CSP allows the project host only.

## In-app automations (no model): Broker File, HOA Clock, Showing Digest, Compliance Critic, REPC Version Watch, Off-Drive Backup, Disk Encryption Check
- Deterministic code in `src/lib/automations.ts`, run at boot, every 15 minutes and after each intake. They create
  tasks and deadline clocks they own (deduplicated by title/type), stamp settings, and log every run to
  `automation_runs` (Audit page). None of them sends anything or touches Google.
- The Off-Drive Backup writes a DPAPI-encrypted copy of the newest daily backup to `~\.salisbury-re\backups`
  (14 kept). The Disk Encryption Check calls `manage-bde -status C:` read-only; when Windows denies a standard
  user, Settings shows an amber banner asking Cory to confirm in Windows Settings instead of a green light.
- **Two-person rule on contract values:** the review screen refuses to build a file while any value read below the
  accuracy bar (`agent_confidence_min`, default 0.95) has not been viewed on its page crop. The Extraction Agent's
  suggestions are hard-capped at 0.6 confidence and carry the quote they came from, so they can never bypass it.

## Input handling
- PDFs are parsed by PyMuPDF/pypdf in the sidecar process, not in the webview. A malicious PDF can at worst crash the
  sidecar (the shell restarts it on next call).
- Extracted values are never auto-committed: the review screen is mandatory; every value carries page + bbox + tier
  + confidence. Prefilled forms are saved as unsigned drafts flagged `draft=1`; the packet item stays "missing"
  until a signed copy is filed.
- Secret names are validated (`[A-Za-z0-9_-]{1,64}`) before touching the filesystem.
- **Opening files in other apps.** "Open" hands the path to Windows (`opener` plugin `open_path`, ShellExecute with the
  default app). The capability `opener:allow-open-path` is scoped to `$DOCUMENT/Salisbury RE/**`,
  `$HOME/.salisbury-re/**`, `$DOWNLOAD/**` and `$DESKTOP/**`; a path outside those folders is refused by the Tauri
  ACL before Rust runs, and the UI shows a plain-language message. `opener:default` alone allows URLs and
  reveal-in-Explorer only, which is why clicks did nothing before 2026-09-07. Executables are never filed into the
  vault by the app; the Add-document picker filters to PDF, Word, images, text and mail files.

## Compliance controls in code
- `src/lib/compliance.ts`: brokerage attribution, EHO, Fair Housing framing, mortgage disclaimer, no client-count
  claims, no wire instructions in writing (ICA 10.3), no legal/tax advice (ICA 11.4).
- Deadline engine follows REPC 21/24 exactly (5 PM Mountain, calendar days, no rollover). Business days only for ICA.
- Text messages: `sms_consent` per client; the UI warns on any text task when consent is not on file. The app never
  sends texts.
- Mountain Time gate (`check_timezone.py`) passes: every formatted time carries `America/Denver`; number formatting
  goes through `src/lib/fmt.ts` (NUMBER-NOT-A-DATE).

## Retention
- R162-2f-401k: broker keeps 3 calendar years after the year of close/fail. The app computes `retentionEnd()` and
  never deletes a document; the Complete File export is the broker hand-off.

## Open items
- BitLocker check. Code signing of the installer (SmartScreen warning until then). In-app updater needs signing keys.
- Norton flagged the original `llama-server.exe` path; the launcher ships as `redesk-llm.exe`. Watch for prompts.
- Google OAuth client is Cory's own (Desktop app type); rotate the client secret in Google Cloud if the laptop is lost.
