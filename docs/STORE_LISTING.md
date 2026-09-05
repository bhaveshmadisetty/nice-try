# Chrome Web Store submission pack — Nice Try

Copy-paste material for the Developer Dashboard. Nothing here is code; it exists so the
listing and the justification fields are filled in properly rather than improvised at
submission time.

---

## Name

```
Nice Try
```

## Short description (132 char limit — this is 118)

```
Blocks distracting tabs with a wall you must justify past. Reads tab titles only; may close a tab you fail to justify.
```

## Category

Productivity → Workflow & Planning

---

## Detailed description

```
Nice Try is a focus blocker that judges what you're doing, not just where you are.

Most blockers work on domains. You block youtube.com and lose the lectures with it, so
you disable the blocker by noon. Nice Try reads the title of your active tab and decides
whether it serves the work you said you were doing — so a system design lecture gets
through and a music video does not, on the same site.

HOW IT WORKS

1. You write your mission — one or two lines on what you're working toward — and
   optionally today's to-dos.
2. Nice Try watches the title of your active tab.
3. If a tab looks like a distraction, the page goes dark behind a wall, media is paused,
   and scrolling stops.
4. To get through, you answer a pointed question about why you opened it. A good honest
   reason gets you in. A vague excuse does not, and the tab may be closed.

Your to-do list always wins. If a task says "revise physics", physics videos count as
work today, even though they normally wouldn't.

BRING YOUR OWN AI KEY

Paste a free API key from Groq or OpenRouter and the judging becomes far more accurate.
The provider is detected automatically from the key format. Without a key, the extension
still works using local keyword matching, and makes no network requests at all.

WHAT IT SENDS

Only the tab's title, your mission, and your to-dos — and only to the provider whose key
you entered, and only if you entered one. Page contents and URLs are never transmitted.
Your key, stats and settings stay on your machine. There is no account, no server, and no
tracking.

WHAT IS STORED, PLAINLY

Nice Try keeps a local record of which pages you spent time on — the title and the URL —
so it can show you your own statistics and link you back to a page. That record never
leaves your computer, and it is deleted automatically after 90 days.

Only the tab's TITLE is ever sent anywhere, only to the AI provider whose key you
personally entered, and only if you entered one. No key means no network requests at all.

WHY IT ASKS FOR ACCESS TO ALL SITES

Chrome shows a broad warning because Nice Try has to be able to put its blocking screen on
whatever page you drift onto — and nobody can predict in advance which page that will be.

Here is what it actually does with that access: it puts its own blocking screen on top of
the page. That is all. It does not read the page, does not touch what you type, does not
see your passwords, and does not read banking or email content. The only thing it ever
reads is the tab's title — the text in the tab strip.

A NOTE ON WHAT IT DOES TO YOUR TABS

This extension is deliberately aggressive. It covers pages with an opaque overlay, pauses
media, and can close a tab you fail to justify. That is the product working as intended.
If you want a gentle reminder, this is the wrong tool.

Full privacy policy: https://github.com/bhaveshmadisetty/nice-try/blob/main/docs/PRIVACY.md
```

---

## Permission justifications

Paste each into its matching field in the dashboard. These fields are where broad-permission
submissions get rejected, so each one names the specific feature that needs it.

### `tabs`

```
The extension's entire function is deciding whether the user's current tab is a
distraction. It uses the tabs permission to read the title of the active tab, which is
the only signal the classifier uses. Titles are not stored beyond the day's local
statistics and page content is never accessed.
```

### `scripting`

```
When a tab is classified as a distraction, the extension injects its blocking overlay
into that tab — a full-page wall that pauses media, disables scrolling, and presents the
justification questions the user must answer to continue. This cannot be done without
script injection into the offending page.
```

### `optional_host_permissions` (`<all_urls>`)

```
The blocking overlay must be injectable into whatever page the user drifts onto. A focus
blocker cannot know in advance which sites will distract a given user — the distracting
site is different for every user and changes daily — so it cannot ship a fixed host list.
The extension injects only its own overlay UI and never reads, collects, or transmits page
content. Only the tab's title is used, and it is sent off-device only when the user has
configured their own AI provider key.

This permission is declared as OPTIONAL and is not granted at install time. The extension
ships inert: until the user explicitly grants host access during onboarding, it classifies
nothing, blocks nothing, and records nothing. The grant is requested from a user gesture on
the setup page, with an on-screen explanation of exactly what it allows, and can be revoked
at any time from chrome://extensions.
```

### `storage`

```
Stores the user's mission statement, to-do list, allowed-site list, their own API key,
local time statistics, and a log of which sites they unblocked and how, so they can review
and revoke that access later. All of it stays in chrome.storage.local on the user's machine.
```

### `alarms`

```
Drives the periodic check of the active tab and the daily reset of the statistics
scoreboard. Without it the service worker cannot re-check tabs after being suspended.
```

### `idle`

```
Used to stop counting focus time when the user locks the screen or steps away, so the
statistics reflect real working time rather than idle time.
```

### `webNavigation`

```
Used to detect when a tab that is currently blocked reloads. Reloading a page destroys the
injected blocking overlay, which allowed the user to bypass the block entirely by pressing
F5 repeatedly. The extension listens for the main-frame commit event so it can re-apply
its overlay before the page paints. The listener exits immediately for any tab that is not
blocked at that moment, and navigation data is never stored, logged, or transmitted.
```

### `notifications`

```
Shows a desktop notification nudging the user back to work when the blocking overlay
cannot be injected into the offending page — for example on a restricted browser page
where script injection is refused. It is the fallback path for the block, not a
promotional or engagement channel.
```

### Remote code

```
No. All code is bundled in the extension package. The extension makes HTTPS API calls to
the user's chosen AI provider for text classification, but never fetches or executes
remote code.
```

---

## Data-use disclosures

Tick in the Privacy tab of the dashboard:

| Question | Answer |
|---|---|
| Collects personally identifiable information | **No** |
| Collects health information | **No** |
| Collects financial and payment information | **No** |
| Collects authentication information | **Yes** — the user's own AI provider API key, stored locally and sent only to that provider |
| Collects personal communications | **No** |
| Collects location | **No** |
| Collects web history | **Yes** — tab titles are sent to the user's chosen AI provider for classification, only when a key is configured |
| Collects user activity | **Yes** — local time-on-task statistics, stored on device |
| Collects website content | **No** |

Then affirm all three certifications:

- Data is **not** sold to third parties.
- Data is **not** used for purposes unrelated to the item's single purpose.
- Data is **not** used to determine creditworthiness or for lending.

**Single purpose statement:**

```
Blocking distracting web pages and holding the user accountable to the work they said
they intended to do.
```

---

## Pre-submission checklist

- [x] Privacy policy hosted at a public URL — https://github.com/bhaveshmadisetty/nice-try/blob/main/docs/PRIVACY.md
- [x] Privacy policy URL confirmed to load publicly (checked 20 Aug 2026 — repo is public)
- [x] Privacy policy URL filled into the detailed description above
- [ ] Privacy policy URL also pasted into the dashboard's own Privacy tab field
- [x] Privacy policy matches actual behaviour: URL storage described, task links described
      as per-page (not per-host), retention stated
- [x] Limited Use affirmative statement present in the privacy policy
- [ ] **Eight** justification fields pasted in — 7 permissions (`tabs`, `storage`, `alarms`,
      `notifications`, `scripting`, `idle`, `webNavigation`) **plus**
      `optional_host_permissions`
- [ ] Data-use disclosures ticked and all three certifications affirmed
- [ ] 1280×800 screenshots: two YouTube tabs (one blocked, one not), the wall, the popup
      scoreboard, the stats page, the settings page
- [x] 128×128 icon confirmed present (`assets/icon128.png`, alongside 16/32/48)
- [x] Tab-closing behavior stated in the description (under "A NOTE ON…")
- [x] Explicit CSP declared in the manifest
- [x] `DEBUG = false` in `src/background.js` (logs include typed answers when true)
- [ ] Loaded unpacked and tested end-to-end after the rename
