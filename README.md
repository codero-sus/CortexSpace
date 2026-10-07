# CortexSpace

**A self-hosted AI workspace that starts in one command and does the same job as
[Odysseus](https://github.com/odysseus-dev/odysseus) — with none of the ceremony.**

Odysseus is a great project, but it's a heavy, Docker-first stack. This is the
"same features, zero friction" answer: a single Python process (FastAPI + Uvicorn)
serves a hand-rolled, dependency-free web UI — no npm, no build step, no Docker,
no CDN, no tracking.

## Run it

```bash
./run.sh          # or: PORT=9000 ./run.sh
```

That's it. `http://localhost:8787` opens instantly with a working workspace.
The only requirements are Python 3.10+ and pip.

```
requirements: fastapi, uvicorn, httpx   (installed into .venv automatically)
```

## How it compares to Odysseus

| | Odysseus | CortexSpace |
|---|---|---|
| **Start time** | Docker compose, several services | `./run.sh` → <1s cold start, one process |
| **Build tooling** | Node toolchain + static bundles (~3MB JS vendored) | Zero build step, ~100KB of hand-rolled JS/CSS |
| **AI providers** | OpenAI / Anthropic / local | **Ollama, OpenRouter, any OpenAI-compatible API** (Groq, LM Studio, vLLM…) + built-in offline demo |
| **Chat** | Sessions, streaming | Sessions, streaming, **token & latency stats per turn**, copy/regenerate, Markdown export |
| **Workspace files** | Yes | Yes — tree, editor with Markdown preview, download, agent read/write/search |
| **Agent tools** | bash, python, browser, search… | file tools, workspace search, web search, page fetch, Python execution |
| **Safety model** | Tool approvals | Tool approvals — every write/delete/code run shows an **Approve/Deny card** (auto-approve optional) |
| **Web search** | SearXNG (required) | DuckDuckGo out of the box, SearXNG optional |
| **Browser/companion** | Companion app for page context | Built-in Browser panel: load a page, "Add page to chat" |
| **Offline** | Works, but big surface | Entire UI is vendored & offline-safe; demo model needs nothing |
| **Privacy** | Self-hosted | Self-hosted: chats/notes/settings in local SQLite + files; outbound calls only to what you configure |

## The workspace

Your notes and files live in `data/workspace/` (seeded on first boot):

```
welcome.md            projects/roadmap.md
notes/todo.md         snippets/fib.py
notes/ideas.md
```

The agent can read, write, search and (optionally) execute against this folder.
All paths are strictly contained — no `..`, no absolute paths, ever.

## Talking to the agent

The demo model understands a small, honest set of intents so you can try the
full pipeline — streaming, tool cards, approvals, real file changes:

- `list my files`
- `read welcome.md`
- `create a note about my coffee habits`
- `find the word roadmap`
- `run python that prints 21*21` (enable *Python execution* in Settings first)
- `search the web for latest LLM news` (needs outbound network)

## Real models

**Settings → Model provider** (live status dots show which backends are reachable):

- **Ollama (local, private)** — run `ollama serve` and `ollama pull llama3.2`,
  then paste the base URL + model. Tool calling works out of the box.
- **OpenRouter (cloud, any model)** — paste an API key, pick a model
  (`anthropic/claude-sonnet-4`, `openai/gpt-4o`, `openrouter/auto`, …).
  The model list refreshes from the OpenRouter API.
- **OpenAI-compatible** — point the base URL at *anything* speaking the
  OpenAI dialect: OpenAI, Groq, Together, LM Studio, vLLM, llama.cpp server…
  (`https://api.groq.com/openai/v1`, `http://127.0.0.1:1234/v1`, …).

All providers stream natively and support the same tool schemas.

## Architecture

```
app/
  main.py          FastAPI app: REST + SSE chat stream + static UI
  agent.py         provider → tool loop, human-in-the-loop approval gate
  tools.py         tool schemas + executors (files, search, web, python)
  webtools.py      DuckDuckGo / SearXNG search, SSRF-guarded page fetch
  worksp.py        workspace file ops with path containment
  db.py            SQLite (chats, messages, settings)
  config.py        runtime settings store
  providers/       demo (offline) · ollama · openrouter  — one stream interface
static/            hand-rolled SPA: no framework, no CDN, no build step
```

**Chat protocol** (SSE): `token` · `tool_call` · `approval_request` ·
`approval_resolved` · `tool_result` · `done` · `error`. The approval gate
pauses the stream until you decide — the same trust model as Odysseus, with a
visible card for every dangerous action.

## Productivity

- **Global search** (`⌘F`) — one query across your chats *and* the whole workspace, with highlighted matches
- **Chat export** — download any conversation as clean Markdown (tool activity included)
- **Message actions** — copy any message; regenerate the last answer
- **Drag & drop upload** — drop files anywhere to add them to the workspace
- **Rename / new folder** — inline modals for notes, folders, and renames
- **Approvals** — a toast + card whenever the agent needs your sign-off

## Interface polish

- **Live streaming stats** — tok/s and token count stream in the message header;
  each answer ends with a stats line (tools used · tokens in/out · tok/s · time)
- **Typing indicator + jump-to-latest** — a three-dot pulse before the first token,
  and a floating pill with an unread counter when you scroll up mid-stream
- **Resizable sidebar & panel** — drag the hairline between regions (double-click resets);
  widths persist
- **Focus mode** (`⌘\`) — collapses everything to the conversation
- **Collapsible sidebar sections** + expand/collapse-all for the file tree (state persists)
- **Editor niceties** — line-number gutter, `Tab` inserts a tab, dirty-dot indicator,
  live line/word/byte counts, `⌘S` saves from anywhere
- **Activity feed** — filter chips (All / Tools / Approvals), clear, and a live count badge
- **Browser bookmarks** — save URLs in the browser panel (localStorage)
- **Appearance** — light/dark theme, three chat font sizes, reduced-motion toggle
  (also honors your OS `prefers-reduced-motion`), all persisted
- **Time-of-day greeting + “Surprise me”** prompt in the empty state
- **Staggered list animations**, tool-card result flashes, ticking relative times,
  smooth scrolling — every animation respects reduced-motion settings

## Power features

- **Version history** — every save keeps a snapshot (last 20 per file); compare any
  version with a green/red diff viewer and restore in one click
- **Chat forking** — “Fork here” on any answer branches the conversation at that point
- **Pinned chats** — star the chats that matter; they stay on top
- **Slash commands** — `/` in the composer: `/note`, `/python`, `/search`, `/read`,
  `/pin`, `/fork`, `/stats`, `/export`, `/theme`, `/focus` and more
- **Insights panel** — messages & tokens per day (charts), top tools, top models,
  workspace size, over 7/14/30-day ranges
- **Export menu** — any chat as clean Markdown *or* a standalone HTML page
- **Workspace archive** — one click downloads the whole workspace as `.zip`
- **Personas** — preset system prompts (Concise, Detailed, Coder, Writer, Brainstormer)
- **Onboarding tour** — a 5-step guided walk-through on first run (replay from ⌘K)
- **Keyboard reference** — press `?` anytime for the full shortcut cheat-sheet
- **Live status bar** — shows the exact tool the agent is running right now
- **Desktop notifications** — optional alert when a turn finishes in the background
- **Danger zone** — clear chats or reset the workspace with explicit confirmation

## Wave 5 — the long tail

200+ individual features and functions layered on top:

**Composer & chat**
- Live character/word counter, draft autosave per chat, “draft saved” indicator
- Clear-composer button, paste-an-image straight into the workspace
- Quote / edit-&-resend / delete (with Undo) on every message, copy as Markdown
- Regenerate variants + follow-up suggestion chips after each answer
- Quick-action bar: TL;DR · ELI5 · Improve · Shorten · Expand · Bullets · Translate · Hindi
- Save the last answer to a file, print a chat, duplicate a chat,
  “new chat with current context”, pin a message, search & jump within a chat
- Chat mood emoji, 8 more keyboard shortcuts, `[` `]` to step between chats

**Editor**
- In-file find with case / whole-word, match count, next/previous (⌘⇧F)
- Go to line, Ln/Col cursor readout, word wrap, editor font size +/−
- Discard changes, read-only lock, duplicate file, move file, copy contents
- Markdown table-of-contents overlay, favorites in the tree, tree filter,
  sort by name / size / modified, per-file size + modified time in the tree

**Interface preferences (all in Settings → Interface)**
- 6 accent colors · 4 corner radii · compact density · frosted-glass off
- high contrast · monochrome · animation speed (fast / instant) · ambient gradient
- wide chat column · assistant avatar on/off · timestamps on/off
- tool cards open by default · sound effects · toast position (top / bottom)
- character counter · status bar · follow-OS theme · night schedule (auto dark,
  with from/to hours) · custom CSS · reset / export / import your preferences
- settings search box — type a word, jump to the right card

**Agent panel**
- Per-tool on/off for all 9 tools (disabled tools are hidden from the model
  *and* blocked at execution) · approval policy (ask / auto / strict)
- Temperature presets (Focused / Balanced / Creative / Wild)
- Max-steps presets (Quick / Standard / Deep) · live cost estimate
- Latency + connection indicators in the status bar

**Insights v2**
- 7×24 activity heatmap · streak counter (with sidebar flame) · words written
- average response time · busiest day & hour · per-provider breakdown
- previous-period deltas (▲/▼) · today card · CSV export · 90-day range

**Browser tab**
- Back / forward / reload / home / open-in-new-tab / full visit history

**Data & maintenance**
- One-click backup (JSON) and restore · export all chats as a zip
- database vacuum · storage meter · About dialog (version, sizes, runtime)

**Toast & feedback system**
- Sound effects (WebAudio), do-not-disturb, stack cap, hover-to-pause progress
bar, Undo on chat & file deletes, searchable notification history drawer

**Templates & prompts**
- 5 built-in note templates (weekly review, kickoff, meeting notes, bug report,
  reading log) + save your own / delete
- 10 built-in prompts + custom prompts, starring, search, copy-to-composer

**Fun**
- Konami code → party mode · “hullu” reaction · 5 logo taps · daily rotating
  quote in the sidebar + a daily “did you know” fact · 8 unlockable
  achievements with confetti · mood picker

**Focus & productivity**
- Pomodoro timer (25/5, skip, badge in the toolbar) · daily message goal with
  progress ring · focus mode

**Keyboard (additions)**
- `⌘P` quick-open · `⌘L` focus composer · `⌘1–4` panel tabs · `⌘W` clear
  `⌘+/−/0` zoom · `⌘E` export · `⌘I` insights · `⌘D` duplicate file
  `⌘G` jump to message · `F` wrap · `T` new note · `P` pomodoro · `M` mute
  `[` `]` prev/next chat

**30+ new slash commands** — `/tldr`, `/eli5`, `/save`, `/find`, `/goto`, `/toc`,
`/lock`, `/party`, `/confetti`, `/ach`, `/backup`, `/csv`, `/goal` … (see `/` in
the composer) — and 35 new command-palette entries (`⌘K`).

**PWA & offline**
- Web-app manifest + service worker (caches the app shell), offline banner,
  installable on desktop/mobile, connection indicator

**Accessibility**
- Skip link, `aria-live` status region, landmark roles, labeled controls,
  focus-friendly modals, reduced-motion honored globally

**Developer**
- `cortexspace.help()` / `cortexspace.dump()` / `cortexspace.prefs` in the browser console
- Copy-diagnostics, in-memory request log (`GET /api/requests`), version footer

## Wave 6 — 500+ more

The long tail, squared. **503 base items** (plus ~58 option variants: 8 accent
themes, 6 system-prompt presets, 4 server presets, 3 token / 4 temp quick chips,
6 chat tints, font / style option sets, 12 dynamic palette chat entries) across
a self-contained `static/js/w6.js` + `static/styles-w6.css` module.

Counting methodology (same as wave 5): each individually selectable / callable
item counts once — a settings row, a key binding, a slash command, a palette
entry, a text operation, a chip, a card. Tallies per category:

| Category | Items |
|---|---|
| Appearance & behavior settings (new rows) | 42 |
| Agent controls (prompt presets, addendum, quick chips, modes) | 14 |
| Live status-bar widgets | 16 |
| Keyboard shortcuts (⌘⇧ / ⌘⌥ / ⌘⇧⌥) | 55 |
| Slash commands | 79 |
| Command-palette entries | 50 |
| Composer text operations | 43 |
| One-click quick actions | 22 |
| Templates / prompt-library entries | 15 / 20 |
| Achievements | 19 |
| Chat management (archive, tints, tags, unread, import/export, pin…) | 20 |
| Files panel (5 views, watch, info, diff, deep links…) | 16 |
| Browser (autocomplete, zoom, top sites, hard reload…) | 9 |
| Fun & easter eggs (retro/matrix/rainbow, noise, breathing, konami…) | 17 |
| Insights (9 new cards + 10 new backend metrics) | 19 |
| Search (recents, scopes, regex/case/word/filename, jump-to-result) | 9 |
| PWA / a11y / dev (dev-log drawer, state export/import, skip link…) | 14 |
| Toast upgrades (action buttons, position, duration) | 3 |
| New backend endpoints & stats | 21 |

**New backend endpoints**
- `GET /api/uptime` — uptime, request count, memory, **active SSE streams**, version
- `GET /api/sessions` — live stream + request counters
- `GET /api/workspace/info` — by-extension, largest, recent, empty folders
- `POST /api/workspace/cleanup` — removes empty folders (never files)
- `POST /api/settings/preset` — local-first / cautious / turbo / cloud-power
- `POST /api/chats/{cid}/archive` · `GET /api/chats/archived`
- `GET /api/chats/{cid}/export/json` · `GET /api/files/raw?path=`
- `GET /api/stats` gains: active days, longest day, avg chat length,
  first/last activity, top tool, week totals, words today, message-length
  and response-time histograms

**Highlights**
- Chat archive with sidebar tabs, per-chat color tints, multi-tags with
  tag-filter, unread badges + "next unread" jumping
- Import/export whole chats as JSON, copy as text or JSON from any chat
- 43 composer text operations (case transforms, slug/camel/snake, lines→table,
  emoji-fy, counters…) acting on the selection
- Live status bar: clock, date, uptime, memory, streams, requests, words today,
  provider/model/theme/offline/zen/sound/unread/dev-log chips
- 55 shortcuts layered on the existing map without shadowing it
  (`⌘⌥1–9` open chat n, `⌘⇧Z` zen, `⌘⇧X` copy chat JSON, `⌘⌥D` diff, …)
- Request-log dev drawer (`⌘⇧J`) over `GET /api/requests`, auto-refreshing
- Insights: words-today, longest day, top tool, length & response-time
  distributions, 14-day active-day grid
- Files: Largest / Recent / By-extension / Empty views, file watching with
  change toasts, info modal, side-by-side diff, `?file`-style deep links
- Browser: URL autocomplete, top sites, zoom, hard reload, clear history
- Fun: retro / matrix / rainbow / party / snake modes, white noise & rain
  ambience, breathing overlay, 20-20-20 eye break, 1-minute timer,
  konami code, `/hello`, `/ssss`, triple-logo easter egg
- 19 achievements with confetti + toast (streaks, words, easter eggs,
  3-sends-in-20s sprinter…)
- Speech: read the last answer aloud (`/speak`), stop with `/stop`
- State: copy / export / import the full local UI state as JSON;
  `cortexspace.uptime()`, `cortexspace.workspace()`, `cortexspace.state()`, … in the console

## Keyboard

`⌘K` palette · `⌘F` search · `⌘N` new chat · `⌘B` sidebar · `⌘J` panel ·
`⌘\` focus mode · `⌘S` save file · `⌘,` settings · `⌘.` theme · `?` shortcuts ·
`↑` edit last message · `@` attach a file · `/` slash commands

## Roadmap

Model fallback chains · scheduled agent runs · PDF/DOCX export ·
multi-user workspaces · tab-context companion. See `data/workspace/projects/roadmap.md`.

## Privacy

Everything is stored locally in `data/`. The only outbound network calls are the
ones you configure: your Ollama endpoint, OpenRouter, and web search. Page
fetching blocks private/internal IP ranges by default.
