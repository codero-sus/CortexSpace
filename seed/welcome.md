# Welcome to CortexSpace 🚀

A self-hosted AI workspace — chat, files, search, code execution, web tools, all in one fast web app.

## Start here

1. **Chat with the agent.** It ships with a zero-config **demo model** so everything works
   instantly — no Docker, no API key, no npm build.
2. **Point it at a real brain** in *Settings*:
   - **Ollama** — run models locally, 100% private (`ollama pull llama3.2`).
   - **OpenRouter** — one API key unlocks 300+ models (Claude, GPT, Gemini…).
3. **Try the tools.** The agent can read/write/search this workspace, run Python,
   search the web and fetch pages. Dangerous actions ask for your approval first.

## Things to try in chat

- “list my files”
- “read roadmap.md”
- “create a note about my coffee habits”
- “find the word focus”
- “run python that prints 21*21”

## Design notes

- Single `uvicorn` process serves the API **and** the UI — cold start under a second.
- Everything is stored locally in `data/` (SQLite + your workspace files). Nothing leaves
  your machine except the calls you explicitly make to Ollama/OpenRouter/search.
- No build step, no CDN, no tracking. The whole UI is hand-rolled and offline-safe.
