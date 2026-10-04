# Nice Try

An AI-powered focus blocker for Chrome that judges **intent, not domains** — it can tell a "Binary Search Explained" video from a music megamix on the *same* YouTube, and walls you off only when you're genuinely off-task.

Most blockers block a whole site (`youtube.com`), so they're either too blunt to matter or so strict you disable them by noon. Nice Try reads the active tab's title, understands what you're actually doing, and interrupts only real distraction — with a gauntlet you have to justify your way past.

You define what "on-task" means by writing your **mission** in the settings page; every verdict is judged against it.

---

## Features

- **Intent-based classification** — an 11-step funnel: instant offline rules for ~90% of tabs, an LLM only for the genuinely ambiguous rest (each verdict cached per title).
- **Your mission, your rules** — one or two lines in settings define what counts as work; the classifier judges every tab against it, so the tool fits any field, not just one.
- **Opaque wall** — when you drift onto a distraction, the page goes fully dark, all media is force-paused, and scroll is killed. Nothing runs behind it.
- **A gauntlet with teeth** — answer justification questions one at a time; an LLM judges your answers. A genuine reason lets you straight in. A rationalization sends you to a **15-word / 3-minute typing test**.
- **Page-specific access** — a hard-wall approval or completed typing test opens that tab and page for 3 minutes. Other tabs remain protected, and the approval is not cached as a permanent verdict.
- **An appeal that teaches it** — a wrong verdict can be corrected from the wall itself. Say what the page is actually for and it unblocks *and remembers*, so the misfire doesn't repeat. Every correction is logged where you can audit it.
- **Focus sessions** — pick a task, start a 15/25/50/90-minute clock, and for that window the wall has *nothing* to negotiate with: no questions, no typing test, no appeal. A pre-commitment you make while thinking clearly, for the moment you aren't.
- **Timed breaks** — switching off opens 10/30/60-minute pause choices that turn blocking back on automatically. One free pause is available each day before the downtime budget is spent; later pauses show their coin price. Manual off remains available through a separate confirmation.
- **Scheduled hours** — "strict 9-1 on weekdays, off after 8pm." Outside your windows it stands down completely. Set none and it runs all the time.
- **Week in review** — focus rate against last week, the shape of your seven days, your best day, and the site that cost you most.
- **Presence-aware time tracking** — only counts time when Chrome is focused and you're not idle. The scoreboard measures attention, not wall-clock.
- **Graceful degradation** — if the AI is unavailable, it falls back to cache → keyword rules → a "you decide" self-check. It never fails open, and the typing test (generated locally) means it can never trap you out either.
- **Bring your own key (BYOK)** — supports **Google Gemini**, **Groq** and **OpenRouter**. Select a provider or detect it from a recognized key prefix. No Nice Try backend; API usage is subject to your provider's pricing and quotas.
- **Inert until you say otherwise** — host access is an *optional* permission, requested during setup rather than at install. Until you grant it, nothing is classified, blocked or tracked.

---

## Install (unpacked)

For a small distribution folder, run `node scripts/build-extension.cjs` (no npm install needed). The runtime-only extension is written to `build/extension`; load that folder for a **new installation**. Phone dependencies, source artwork, tests and development files are excluded even when the mobile app's dependencies are installed.

If Nice Try is already installed from this project folder, keep that existing path and click **Reload** to preserve its extension identity and local data. Do not remove/reinstall it just to use the smaller bundle.

1. Clone or download this repo.
2. Go to `chrome://extensions`.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the project folder.
5. Pin the extension, open it, and toggle it **on**.

### Enable the AI (optional but recommended)

1. Create a key in **[Google AI Studio](https://aistudio.google.com/apikey)**, **[Groq](https://console.groq.com/keys)** or **[OpenRouter](https://openrouter.ai/keys)**.
2. Open **⚙ Settings**, select your AI provider, paste the key and **Save**. Existing Groq/OpenRouter keys continue to work with automatic detection.
3. Click **Test the key** to make a real AI request. This consumes a small amount of your provider's quota.

For Gemini, explicitly choose **Google Gemini** if your key is not recognized automatically. The default model is `gemini-3.5-flash-lite`; its model ID is editable in Settings. Nice Try does not automatically switch Gemini models or enable billing. Free-tier access has project/model limits; billing-enabled projects may incur charges. Check [current Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing). Google sign-in and Gemini API access are separate.

After updating an unpacked extension, click **Reload** for Nice Try on `chrome://extensions` and reopen Settings.

Without a key, the extension still works using keyword/domain rules.

---

## Google account and phone access

The `mobile/` companion app supports adding, editing, scheduling, completing and searching tasks on a phone, with local persistence and an installable web app shell. Settings includes **Export tasks**; import that file in the phone app's **Your account** panel to transfer tasks before cloud sync is enabled.

The Chrome extension needs no npm dependencies. Run `npm ci` inside `mobile/` only when developing the phone app; its dependencies take hundreds of MB and are excluded by the extension packaging command. Removing `mobile/node_modules` and `mobile/dist` frees that space without deleting phone source code or changing the deployed phone app.

Google sign-in and task-sync code are included but remain disabled until the app owner completes the one-time [Firebase setup](docs/GOOGLE_SETUP.md). After that setup, users only need to sign in with the same Google account on both devices. API keys and browsing history are not part of task sync. Gemini is independent and unchanged.

The sync protocol keeps stable task IDs, merges individual tasks, and retains deletion records. Concurrent edits to the same task use the latest record by timestamp (change ID breaks ties); deletion always wins. A stale editor on one device changes only its edited fields. The original extension task list is backed up locally before migration. Account-specific local copies are retained separately; disconnect restores the guest/local list.

## How it works

```
Active tab title
   │
   ▼
┌──────────────────────────────────────────────┐
│  0  no host permission         → inert        │
│  0  outside scheduled hours    → stand down   │
│  1  browser-internal URL       → ignore       │
│  2  active 3-min page grant    → allow page   │
│  3  YOUR always-allowed list   → productive   │
│  4  YOUR never-allowed list    → junk         │
│  5  search / AI-assistant host → never block  │
│  6  built-in allow-list        → productive   │
│  7  hard junk domain           → junk         │
│  8  utility app (WhatsApp…)    → neutral      │
│  9  instant junk/productive kw → decided      │
│ 10  cached verdict             → reuse        │
│ 11  everything else, 20s dwell → LLM judges   │
└──────────────────────────────────────────────┘
   │ junk / unsure, 30s streak
   ▼
The wall    →  questions → LLM verdict
                 pass → 3 min on this page
                 fail → 15 words / 3 min typing test
                      → or appeal: "this was flagged by mistake"
```

**Timing:** polls every 3s (presence-gated) · LLM judges after 20s of real presence · wall fires at 30s on a junk tab · each hard-wall pass grants 3 minutes on that page.

---

## Project structure

```
.
├── manifest.json          # MV3 manifest (must stay at root)
├── src/
│   └── background.js       # service worker: classifier, LLM, injected wall
├── ui/
│   ├── popup.html/js        # daily cockpit — to-dos, status, scoreboard
│   └── options.html/js      # settings — mission, API key, allow-list
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
- **API key** — Gemini, Groq or OpenRouter; select a provider or use automatic detection.

---

## Privacy

Tasks are stored locally and, if you enable Google task sync, in your Firebase account's task collection. Synced fields include task text, dates, completion, ordering, attached links and other task metadata. API keys, browsing logs, stats and your mission are not uploaded by task sync. AI judging separately sends titles, relevant tasks, your mission and submitted appeal answers to your selected AI provider. No analytics are added.

---

## Tech notes

- **Manifest V3.** The service worker is ephemeral, so the poll uses a self-scheduling timer with an alarm keep-alive, and all state persists to `chrome.storage`.
- **LLM model discovery** at runtime (OpenRouter rotates its free list), with a Groq fast-path.
- **Verdict caching** keyed on title + a to-dos signature, capped at 500 entries.

---

## Roadmap

- [ ] A hosted, shared verdict cache (anonymous title-hash → verdict) so popular videos are judged once across all users.
- [ ] Event-driven timing to fully replace polling.
- [x] A user-editable block-list and per-site rules in the UI.
- [x] Debug logging behind a flag (`DEBUG` in `src/background.js`).
- [ ] Settings sync across devices (`chrome.storage.sync` for mission/allow-list/schedule).
- [ ] Use the appeal log to actually retrain the keyword rules, rather than only recording corrections.

---

## License

MIT — see [LICENSE](LICENSE).
