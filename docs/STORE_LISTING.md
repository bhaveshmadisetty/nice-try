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

A NOTE ON WHAT IT DOES TO YOUR TABS

This extension is deliberately aggressive. It covers pages with an opaque overlay, pauses
media, and can close a tab you fail to justify. That is the product working as intended.
If you want a gentle reminder, this is the wrong tool.

Full privacy policy: <PRIVACY_POLICY_URL>
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

### `host_permissions` (`<all_urls>`)

```
The blocking overlay must be injectable into whatever page the user drifts onto. A focus
blocker cannot know in advance which sites will distract a given user — the distracting
site is different for every user and changes daily — so it cannot ship a fixed host list.
The extension injects only its own overlay UI and never reads, collects, or transmits page
content. Only the tab's title is used, and it is sent off-device only when the user has
configured their own AI provider key.
```

### `storage`

```
Stores the user's mission statement, to-do list, allowed-site list, their own API key, and
local time statistics. All of it stays in chrome.storage.local on the user's machine.
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

### `notifications`

```
Shows a desktop notification nudging the user back to work when they drift onto a
distracting tab.
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

- [ ] Privacy policy hosted at a public URL and pasted into the dashboard
- [ ] `<PRIVACY_POLICY_URL>` replaced in the detailed description above
- [ ] All seven permission justifications pasted in
- [ ] Data-use disclosures ticked and all three certifications affirmed
- [ ] 1280×800 screenshots: the wall, the questions, the popup scoreboard, the settings page
- [ ] 128×128 icon confirmed present (`assets/icon.png`)
- [ ] Tab-closing behavior stated in the description (it is, under "A NOTE ON…")
- [ ] Loaded unpacked and tested end-to-end after the rename
