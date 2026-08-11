# Privacy Policy — Nice Try

**Last updated: 10 August 2026**

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
- **Usage statistics** — time totals per category, and per-tab-title time for the day,
  used to render your scoreboard.

You can erase this at any time by removing the extension, or clear the day's statistics
with the "Reset today's data" button on the settings page.

## What is sent off your machine

**Only if you have entered an API key.** With no key configured, the extension makes no
network requests at all and works purely on local keyword matching.

When you have a key, and only when a tab needs to be classified, the extension sends the
following to the provider your key belongs to:

- the **title** of the active tab (for example, `Two Sum - LeetCode`),
- your **mission statement**,
- your **to-do list** for the day,
- and, if you are answering the unlock questions, **the answers you type**.

This is sent directly from your browser to one of:

- **Groq** — https://api.groq.com — see https://groq.com/privacy-policy/
- **OpenRouter** — https://openrouter.ai — see https://openrouter.ai/privacy

Your data is handled by that provider under their policy. The extension author never
receives it.

## What is never sent

- **Page contents** are never read or transmitted.
- **URLs** are never transmitted. The extension reads a tab's hostname locally, only to
  check it against your always-allowed list.
- Nothing is sent from tabs the extension does not classify, and nothing is sent when
  the extension is paused or no API key is set.

## What the permissions are for

- **`tabs`** — to read the title of the active tab, which is the only signal used to
  decide whether you are distracted.
- **`scripting`** and **`host_permissions: <all_urls>`** — to inject the blocking overlay
  into whichever tab you drift onto. The extension cannot know in advance which sites
  those will be, so it must be able to act on any page. It injects only its own overlay
  and does not read or modify page content.
- **`storage`** — to save your settings and statistics locally.
- **`alarms`** and **`idle`** — to check tabs periodically and to stop counting time when
  you are away from the computer.
- **`notifications`** — to show a desktop nudge when you drift.

## Tab closing

If you fail to justify a blocked page, the extension may close that tab. This is the
intended behavior of the product. It affects only the blocked tab.

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
