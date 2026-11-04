# salisbury re desk

> **Portfolio snapshot.** A sanitized, history-free copy of a private repository, published to show the work.
> Credentials, customer and lead data, internal notes and third-party material were removed, and real client
> and people names were replaced with fictional ones, so this copy is not meant to run as-is.

- **What it is:** Local-first desktop client-management app for a Utah real estate practice, built with Tauri and React and running local AI models.
- **Stack:** React, Tailwind, Tauri, Vitest, Zod
- **Languages:** TypeScript, SQL, Rust, Python
- **Private repo history:** 44 commits, 2026-09-05 to 2026-09-10
- **This snapshot:** 158 files, 39 test files
- **Built by:** Cory Salisbury, with Claude Code

_All rights reserved. Shared for portfolio review only; no license is granted to copy, modify or redistribute this code._

---

Local-first desktop client-management app for Cory Salisbury, REALTOR (Simple Choice Real Estate, Utah).
Intake a signed contract, and the app builds the client file, the folder, the packet checklist, the REPC
deadlines and the follow-up tasks. Everything runs on this laptop: SQLite, a document engine (PyMuPDF +
RapidOCR) and a local LLM (llama.cpp, Qwen3-4B). Nothing leaves the machine.

## Layout
- `src/` React 19 + TypeScript + Tailwind (Vite). Pages: Today, Clients, Calendar, Intake, Packets, Settings.
- `src/lib/deadlines.ts` pure REPC deadline engine (tests in `deadlines.test.ts`).
- `src/lib/extract/` REPC extractor: tier 1 AcroForm fields, tier 2 text layer with geometry, tier 3 OCR lines.
- `src/lib/extract/agreement.ts` UAR listing agreement / buyer-broker agreement extractor (flat forms, zone-based; fixtures from `tests/make_agreement_fixtures.py`).
- `src/lib/intake.ts` analyze -> review -> commit orchestration (REPC, listing agreement, BBA). `src/lib/repo.ts` is the only reader/writer of row shapes.
- `src/lib/forms.ts` forms library: every PDF in `Forms\State` and `Forms\UAR` is indexed into the `forms` table (sha256, pages, fillable, revision).
- `src/lib/formfill.ts` + `templates/form-fills.json` prefill packet forms after intake (flat UAR forms are stamped at measured blank positions; state AcroForms are filled); `src/lib/google.ts` Google Calendar push + Gmail drafts (desktop OAuth with PKCE, loopback on 127.0.0.1:8794, permission asked in-app first); `src/lib/cma.ts` CMA grid + seller net sheet (Tools page); `src/lib/engine.ts` the Daily Engine; `src/lib/agents.ts` the five local-model agents; `src/lib/leads.ts` drip / nurture; `src/lib/openHouses.ts`.
- `tests/make_sample_listing.py` writes a fully filled sample listing agreement (fake people) into Downloads for testing Intake.
- `src/lib/automations.ts` the in-app automations (deterministic, no model): Broker File clocks + Complete File readiness, HOA 14-day clock (Utah 57-8a-227), Showing Digest into the Monday update, Compliance Critic over templates and task bodies, REPC Version Watch, Off-Drive encrypted backup, Disk Encryption Check. Run at boot, every 15 min, after intake; every run is on the Audit page. `src/lib/showings.ts` parses pasted showing-service emails. `src/lib/extract/aiFallback.ts` is the Extraction Agent (model reads only the blanks, must quote, capped at 0.6 so the 95% two-person rule always applies).
- `src/lib/packetAi.ts` packet auto-build: a rule table maps each Exhibit B line to form titles; the local model proposes situational additions with reasons; Cory confirms before anything is added. `templates/exhibit-b.json` is Pat's checklist verbatim.
- `src-tauri/` Rust shell: splash/main choreography, SQLite migrations, scoped file helpers, sidecar management.
- `sidecar/doc/server.py` document engine (JSON-RPC over stdio), frozen with PyInstaller into `src-tauri/resources/doc/`.
- `src-tauri/resources/llama/` llama.cpp Vulkan build; the launcher is named `redesk-llm.exe` (see the project note for why).
- `migrations/0001_init.sql` schema. `templates/packets.json` (Exhibit B), `templates/cadences.json` (Pat's drips + chase rules).
- Data: `Documents\Salisbury RE\` (db, forms, one folder per client). Models: `%USERPROFILE%\.salisbury-re\models\`.
- AI providers: `src/lib/providers.ts` routes each job (extraction, packet, canary, agents, drafts, polish, cma) to the local Qwen or to Claude Haiku/Sonnet through Claude Code's headless mode on Cory's subscription (Rust `claude_run`, no API key); local is the fallback.
- salisburyre.com CRM: `src/lib/crm.ts` (Supabase Auth as Cory's CRM user, pull leads/contacts into an inbox, push clients/deals/milestones/showings, idempotent via `crm_links`, migration 0010), automation `crm_sync`.
- CMA from an address: `src/lib/compImport.ts` (MLS CSV export -> comps), `src/lib/compSelect.ts` (Pat's ladder: same style, 1 -> 1.5 -> 2 mi, 90 -> 365 days, sqft band, 6 preferred / 4 minimum, context sets), `src/lib/cmaFlow.ts` (geocode through Rust: Utah address points -> Census -> OpenStreetMap, cached; pool, grid, PDF via the doc engine), tables in migration 0009.
- Agents: programmed first (`src/lib/reports.ts` + `src/lib/drafts.ts` over the `v_at_risk` / `v_packet_gaps` views); model jobs run inside `src/lib/loop.ts` (5 passes, 95% bar, strategy ladder, lessons in `agent_lessons`) with zod shapes (`src/lib/schemas.ts`) and the Monitor's grounding check (`src/lib/monitor.ts`); `templates/canary.json` is the daily drift check.
- Google: `src/lib/google.ts` (Calendar events, Gmail drafts, Drive upload + share, Contacts; scopes listed in `GOOGLE_PERMISSIONS`). Cloud project `salisbury-re-desk`, Desktop-app client, secrets in DPAPI. Every push is idempotent (lock + local link + read-back from Google); the calendar card's Check Google reports and removes the app's own duplicate events.
- Documents: `src/lib/documents.ts` files every document into the client folder's numbered subfolder by kind (copy, sha256, `documents` row); one click opens it in the Windows default app (`opener:allow-open-path`, scoped in `src-tauri/capabilities/default.json`).

## Develop
```bash
pnpm install
pnpm vitest run                # 136 tests (REDESK_LIVE=1 adds a live model check)
pnpm tauri dev                 # splash -> main window; boot log in Documents\Salisbury RE\Backups\boot.log
```
Rust needs MSVC Build Tools + Windows SDK; `.cargo/config.toml` pins the MSVC linker because Git's `link.exe` shadows it in bash.

## Build the installer
```bash
cd sidecar/doc && ./.venv/Scripts/pyinstaller --noconfirm --onedir --console --name redesk-doc --collect-all rapidocr_onnxruntime --hidden-import fitz --hidden-import pypdf --hidden-import PIL server.py && cp -r dist/redesk-doc ../../src-tauri/resources/doc
PATH="$HOME/.cargo/bin:$PATH" pnpm tauri build   # -> src-tauri/target/release/bundle/nsis/*.exe (per-user, desktop shortcut)
```
The model is not in the installer: copy `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` into `%USERPROFILE%\.salisbury-re\models\` (Settings shows the expected path).

## Keyboard
Ctrl+1..6 sections (Today, Daily Engine, Clients, Calendar, Tools, Settings), Ctrl+I intake, Ctrl+P packets, Ctrl+9 audit, Ctrl+Enter confirms an intake review, Ctrl+E exports the Complete File, Ctrl+D drafts with the AI panel.
