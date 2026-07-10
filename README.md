# Focus Shield

An AI-powered focus blocker for Chrome that judges **intent, not domains** — it can tell a "Binary Search Explained" video from a music megamix on the *same* YouTube, and walls you off only when you're genuinely off-task.

Most blockers block a whole site (`youtube.com`), so they're either too blunt to matter or so strict you disable them by noon. Focus Shield reads the active tab's title, understands what you're actually doing, and interrupts only real distraction — with a gauntlet you have to justify your way past.

---

## Features

- **Intent-based classification** — an 11-step funnel: instant offline rules for ~90% of tabs, an LLM only for the genuinely ambiguous rest (each verdict cached per title).
- **Opaque "Focus Shield" wall** — when you drift onto a distraction, the page goes fully dark, all media is force-paused, and scroll is killed. Nothing runs behind it.
- **A gauntlet with teeth** — answer justification questions one at a time; an LLM judges your answers. A genuine reason lets you straight in. A rationalization sends you to a **15-word / 3-minute typing test**.
- **Honest access model** — the AI approving you is remembered; forcing in via the typing test grants 5 minutes but is *never* cached, so you justify the same site again next time.
- **Presence-aware time tracking** — only counts time when Chrome is focused and you're not idle. The scoreboard measures attention, not wall-clock.
- **Graceful degradation** — if the AI is unavailable, it falls back to cache → keyword rules → a "you decide" self-check. It never fails open, and the typing test (generated locally) means it can never trap you out either.
- **Bring your own key (BYOK)** — supports **Groq** (recommended, reliable free tier) and **OpenRouter** (auto-detected from the key prefix). No backend, no cost, fully local.

---

## Install (unpacked)

1. Clone or download this repo.
2. Go to `chrome://extensions`.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the project folder.
5. Pin the extension, open it, and toggle it **on**.

### Enable the AI (optional but recommended)

1. Get a free key from **[Groq](https://console.groq.com/keys)** (starts with `gsk_`) — recommended.
   Or **[OpenRouter](https://openrouter.ai/keys)** (`sk-or-...`), though its free tier is often rate-limited.
2. Open the extension → **⚙ Settings** → paste the key → **Save**.
3. The popup's status pill turns green when the AI is active.

Without a key, the extension still works using keyword/domain rules.

---

## How it works

```
Active tab title
   │
   ▼
┌─────────────────────────────────────────────┐
│ 1  browser-internal URL        → ignore      │
│ 2  active 5-min access grant   → allow       │
│ 3  search / AI-assistant host  → never block │
│ 4  allow-list domain           → productive  │
│ 5  hard junk domain            → junk        │
│ 6  utility app (WhatsApp…)     → neutral     │
│ 7  instant junk/productive kw  → decided     │
│ 8  cached verdict              → reuse       │
│ 9  everything else, 20s dwell  → LLM judges  │
└─────────────────────────────────────────────┘
   │ junk / unsure, 30s streak
   ▼
Focus Shield  →  questions → LLM verdict
                 pass → 5 min access
                 fail → 15 words / 3 min typing test
```

**Timing:** polls every 3s (presence-gated) · LLM judges after 20s of real presence · wall fires at 30s on a junk tab · each pass grants 5 minutes.

---

## Project structure

```
.
├── manifest.json          # MV3 manifest (must stay at root)
├── src/
│   └── background.js       # service worker: classifier, LLM, injected Focus Shield
├── ui/
│   ├── popup.html/js        # daily cockpit — to-dos, status, scoreboard
│   └── options.html/js      # settings — API key, allow-list
├── assets/
│   └── icon.png
└── docs/
    └── STORY.md             # the build journal / design decisions
```

---

## Configuration

All settings live in the extension's popup and options page — nothing to edit in code for normal use:

- **Today's to-dos** — define what counts as work today (they override the AI's judgment).
- **Always-allowed sites** — domains that are never blocked (e.g. your college portal, cloud-labs).
- **API key** — Groq or OpenRouter; provider is auto-detected.

---

## Privacy

Everything is stored **locally in your browser**. The only data that leaves your machine is the **tab title** (plus your to-dos), sent to your chosen AI provider — and only when a title is ambiguous enough to need judging, and only if you've added a key. No analytics, no server, no tracking.

---

## Tech notes

- **Manifest V3.** The service worker is ephemeral, so the poll uses a self-scheduling timer with an alarm keep-alive, and all state persists to `chrome.storage`.
- **LLM model discovery** at runtime (OpenRouter rotates its free list), with a Groq fast-path.
- **Verdict caching** keyed on title + a to-dos signature, capped at 500 entries.

---

## Roadmap

- [ ] A hosted, shared verdict cache (anonymous title-hash → verdict) so popular videos are judged once across all users.
- [ ] Event-driven timing to fully replace polling.
- [ ] A user-editable block-list and per-site rules in the UI.
- [ ] Debug logging behind a flag (currently verbose in the console).

---

## License

MIT — see [LICENSE](LICENSE).
