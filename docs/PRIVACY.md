# Privacy Policy — Nice Try

**Last updated: 5 October 2026**

Nice Try is a browser extension that blocks distracting tabs. This policy explains exactly
what it does with your data.

In short: everything stays on your machine, with two exceptions, and both are features you
switch on yourself. If you configure an AI provider, tab titles are sent to it. If you sign
in with Google to sync your to-do list, your tasks are stored in the developer's Firebase
project. With neither enabled, the extension makes no network requests at all.

## What is stored, and where

All of the following is stored locally in your browser using `chrome.storage.local`:

- **Your mission statement** — the text you write describing what you're working toward.
- **Your to-do list** — the tasks you enter for the day, and any link you attach to one.
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
- **Your coin balance and ledger** — the earnings and charges the scoreboard shows, capped
  at the 200 most recent entries.
- **Your Google account details, only if you sign in for task sync** — your email address,
  your Firebase user id, and the OAuth tokens that keep the session alive. See
  **Task sync** below.

Statistics, the access log, your coin ledger and your remembered verdicts are **never**
transmitted anywhere. They are local to the device that recorded them.

You can erase this at any time by removing the extension, clear the day's statistics with
the "Reset today's data" button on the settings page, or clear the access log with the
button on the access-log page.

## What is sent off your machine

There are exactly two paths off your machine. Both are off until you turn them on.

### 1. Tab titles, to the AI provider you configure

**Only if you have entered an API key.** With no key configured, the extension classifies
pages using local keyword matching and makes no network requests at all.

When you have a key, and only when a tab needs to be classified, the extension sends the
following to the provider your key belongs to:

- the **title** of the active tab (for example, `Two Sum - LeetCode`),
- your **mission statement**,
- your **to-do list** for the day — the task text only, never any link attached to a task,
- the **name of the course platform** the tab is on, when it is on one (for example,
  `Coursera`), so a lesson is not mistaken for entertainment,
- and, if you are answering the unlock questions, **the answers you type**.

This is sent directly from your browser to whichever one of these your key belongs to:

- **Groq** — https://api.groq.com — see https://groq.com/privacy-policy/
- **OpenRouter** — https://openrouter.ai — see https://openrouter.ai/privacy
- **Google Gemini** — https://generativelanguage.googleapis.com — see
  https://ai.google.dev/gemini-api/terms

Your data is handled by that provider under their policy. The extension author never
receives it. When you paste a key, a single request is made to that provider to check the
key works; it carries no page data.

### 2. Your to-do list, to task sync — only if you sign in

Task sync is **off by default and requires an explicit Google sign-in**. Until you sign in,
your tasks are local, nothing is uploaded, and no account exists. The extension works fully
without ever signing in.

If you do sign in, this is what happens:

- You are sent to Google's own sign-in page, requesting the `openid email profile` scopes.
  Nice Try never sees your Google password.
- Google returns an identity token, which is exchanged with Firebase for a session. Your
  **email address**, Firebase **user id**, and the session **tokens** are stored locally on
  your device so you stay signed in. Your email is shown on the account page so you can see
  which account is connected.
- Your **to-do list is then stored in the developer's Firebase project** (Google Cloud
  Firestore, project `nice-try-3174b`), under a path only your account can read or write.
  This is what lets the same list appear in the companion phone app.

**What a synced task contains.** The whole task record is uploaded: the task's text, its
position in your list, whether it is done, its date — **and the page link attached to it, if
you attached one.** A task you created from a page keeps that page's URL so the task can
link back to it, and that URL is uploaded with the task. If you do not want a particular
page's URL leaving your device, do not attach it to a task, or remove the link before
signing in.

Nothing else is synced. Your statistics, access log, coin ledger, API key, mission,
always-allowed list and remembered verdicts stay on your device and are never uploaded.

**Who can read it.** Only you. The Firestore security rules restrict every task document to
the signed-in account that owns it; no other user and no unauthenticated request can read or
write your tasks. The developer does not read, mine, analyse, sell or transfer synced tasks.

**Turning it off and deleting it.** "Disconnect" on the account page signs you out, removes
the stored tokens, and returns the extension to local-only tasks. To have the task data held
in Firestore deleted, email the address at the bottom of this policy from the account you
signed in with and it will be removed.

## URLs

The URL of a page you spend time on is stored **locally only**, so the statistics page can
link back to pages you visited. It is never sent to an AI provider, and never to the
developer.

The one exception is described above: **a URL you yourself attach to a to-do is uploaded
with that task when task sync is signed in.** It travels only to Google Firestore under your
own account, and only because the task has to carry its own link to be useful on another
device.

The extension also reads a tab's hostname locally to check it against your always-allowed
list, and to group the access log by site.

You can erase all of this with "Reset today's data" on the settings page, or by removing the
extension.

## What is never sent off your machine

- **Page contents** are never read or transmitted. The extension injects its own overlay
  into a blocked page; it does not read what the page says.
- **Browsing history** is never collected or transmitted. No list of the pages you visited
  leaves your device.
- **Page URLs** are never transmitted to an AI provider, and never to the developer. The
  single exception is a link you attach to a to-do once you have signed in to task sync, as
  described above.
- **Your statistics, access log, coin ledger and API key** are never transmitted anywhere.
- Nothing is sent from tabs the extension does not classify, and nothing is sent when the
  extension is paused, when no API key is set, or when you are not signed in.

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
- **`storage`** — to save your settings, statistics and tasks locally.
- **`alarms`** and **`idle`** — to check tabs periodically and to stop counting time when
  you are away from the computer.
- **`webNavigation`** — to notice when a tab that is currently blocked reloads. Reloading
  destroys the blocking overlay, so without this the block could be bypassed by pressing
  F5. It is used only for tabs that are blocked at that moment, and no navigation data is
  stored or transmitted.
- **`notifications`** — to show a desktop nudge when the blocking overlay cannot be shown
  on a restricted page.
- **`identity`** — to run the Google sign-in flow for optional task sync, and only when you
  start that flow yourself. It is not used at install, and not used at all if you never sign
  in.
- **Host access to `identitytoolkit.googleapis.com`, `securetoken.googleapis.com` and
  `firestore.googleapis.com`** — the three Google endpoints task sync talks to: signing in,
  refreshing the session, and reading and writing your task list. They are contacted only
  while you are signed in.

## Tab closing

If you fail to justify a blocked page, the extension may close that tab. This is the
intended behavior of the product. It affects only the blocked tab.

## Limited Use

Nice Try's use of information received from Google APIs, and from your browser, adheres to
the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements. Data is used only for the extension's single
purpose — blocking distracting pages and holding you to the work you said you intended to
do — and for no other purpose. Specifically: data is not sold or transferred to third
parties, is not used for advertising, creditworthiness or lending, and is not read by humans
except where required for security, to comply with law, or with your explicit consent.

## Data retention

- **Statistics** are kept for 90 days, then deleted automatically.
- **The access log** keeps the 300 most recent entries; older ones are dropped.
- **Remembered verdicts** are capped at 500 entries.
- **The coin ledger** keeps the 200 most recent entries.
- **Your mission, to-dos, API key and allowed sites** are kept until you change or remove
  them, or until you uninstall the extension.
- **Synced tasks** remain in Firestore until you request deletion by email. Deleting a task
  in the app marks it deleted and hides it everywhere, but — so that a device which was
  offline cannot resurrect it — the record itself is kept, including the task's text and any
  link attached to it. Disconnecting signs you out and does not by itself delete anything
  already stored. Email the address below to have your task data erased for good.

## Data sale and transfer

The developer does not sell, rent, or transfer your data to anyone. There is no analytics,
no advertising, and no third-party tracking code in this extension. The only outbound
requests are the AI provider request and the task sync request described above, and both
require you to enable them.

## Children

This extension is not directed at children under 13.

## Changes

Any change to this policy will be published at this URL with an updated date.

## Contact

Questions about this policy, or a request to delete synced task data:
**safestorage.in@gmail.com**
