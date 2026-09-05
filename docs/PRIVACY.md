# Privacy Policy — Nice Try

**Last updated: 20 August 2026**

Nice Try is a browser extension that blocks distracting tabs. This policy explains
exactly what it does with your data. In short: everything stays on your machine,
except tab titles sent to an AI provider you choose and configure yourself.

## What is stored, and where

All of the following is stored locally in your browser using `chrome.storage.local`.
None of it is transmitted to the developer, and the developer has no server:

- **Your mission statement** — the text you write describing what you're working toward.
- **Your to-do list** — the tasks you enter for the day.
- **Your API key** — stored as you entered it, used only to authenticate directly with
  your chosen AI provider.
- **Your always-allowed sites** — the domains you exempt from blocking.
- **Usage statistics** — time totals per category, and per-page time for the day, used to
  render your scoreboard. Each entry keeps the page's title and its URL, so the statistics
  page can link back to a page you spent time on. Statistics older than 90 days are
  deleted automatically.
- **Your access log** — when you get past a block, the site's hostname, the page title,
  and whether you were let through by justifying yourself or by completing the typing
  test. This is what the "What got past the wall" page shows you, so you can revoke a
  site you talked your way into. It is capped at the 300 most recent entries.

You can erase this at any time by removing the extension, clear the day's statistics
with the "Reset today's data" button on the settings page, or clear the access log with
the button on the access-log page.

## What is sent off your machine

**Only if you have entered an API key.** With no key configured, the extension makes no
network requests at all and works purely on local keyword matching.

When you have a key, and only when a tab needs to be classified, the extension sends the
following to the provider your key belongs to:

- the **title** of the active tab (for example, `Two Sum - LeetCode`),
- your **mission statement**,
- your **to-do list** for the day,
- and, if you are answering the unlock questions, **the answers you type**.

A link you paste into a to-do is **not** sent anywhere. It exempts that one exact page
from being blocked — and nothing else. The rest of the site is still checked normally, so
a single lecture link does not unlock the whole of YouTube. Remove the task and the
exemption goes with it.

This is sent directly from your browser to one of:

- **Groq** — https://api.groq.com — see https://groq.com/privacy-policy/
- **OpenRouter** — https://openrouter.ai — see https://openrouter.ai/privacy

Your data is handled by that provider under their policy. The extension author never
receives it.

## URLs

The URL of a page you spend time on is stored locally, on your machine only, so the
statistics page can link back to pages you visited. This never leaves your device — it is
not sent to the AI provider, to the developer, or to anyone else.

The extension also reads a tab's hostname locally to check it against your always-allowed
list, and to group the access log by site.

You can erase all of this with "Reset today's data" on the settings page, or by removing
the extension.

## What is never sent off your machine

- **Page contents** are never read or transmitted.
- **URLs** are never transmitted anywhere. They are stored locally only, as described
  above.
- Nothing is sent from tabs the extension does not classify, and nothing is sent when
  the extension is paused or no API key is set.

## What the permissions are for

- **`tabs`** — to read the title of the active tab, which is the only signal used to
  decide whether you are distracted.
- **`scripting`** and **`optional_host_permissions: <all_urls>`** — to inject the blocking
  overlay into whichever tab you drift onto. The extension cannot know in advance which
  sites those will be, so it must be able to act on any page. It injects only its own
  overlay and does not read or modify page content.

  This one is **optional and is not requested at install**. The extension is inert until
  you grant it during setup (or from the popup), and until then it classifies nothing,
  blocks nothing and tracks nothing. You can revoke it at any time from Chrome's
  extensions page, which returns it to that inert state.
- **`storage`** — to save your settings and statistics locally.
- **`alarms`** and **`idle`** — to check tabs periodically and to stop counting time when
  you are away from the computer.
- **`webNavigation`** — to notice when a tab that is currently blocked reloads. Reloading
  destroys the blocking overlay, so without this the block could be bypassed by pressing
  F5. It is used only for tabs that are blocked at that moment, and no navigation data is
  stored or transmitted.
- **`notifications`** — to show a desktop nudge when the blocking overlay cannot be shown
  on a restricted page.

## Tab closing

If you fail to justify a blocked page, the extension may close that tab. This is the
intended behavior of the product. It affects only the blocked tab.

## Limited Use

Nice Try's use of information received from Google APIs, and from your browser, adheres to
the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements. Data is used only for the extension's single
purpose — blocking distracting pages and holding you to the work you said you intended to
do — and for no other purpose.

## Data retention

- **Statistics** are kept for 90 days, then deleted automatically.
- **The access log** keeps the 300 most recent entries; older ones are dropped.
- **Remembered verdicts** are capped at 500 entries.
- **Your mission, to-dos, API key and allowed sites** are kept until you change or remove
  them, or until you uninstall the extension.

## Data sale and transfer

The developer does not collect, sell, rent, or transfer your data to anyone. There is no
analytics, no tracking, and no third-party code in this extension beyond the AI provider
request described above.

## Children

This extension is not directed at children under 13.

## Changes

Any change to this policy will be published at this URL with an updated date.

## Contact

Questions about this policy: **safestorage.in@gmail.com**
