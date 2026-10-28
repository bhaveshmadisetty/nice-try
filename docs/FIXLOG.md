# Fix log

One entry per bug or confusing behaviour. Newest first. Each entry says what
was observed, what actually caused it, what changed, and how it was verified.
The point is that the next time something looks like one of these, the answer
is here and not in a two-hour re-investigation.

Rule: every fix that reaches the working tree gets a row here in the same
change. A fix without an entry is not finished.

Format:

```
## YYYY-MM-DD  Short name
Seen:    what the user saw
Cause:   the real reason, with the file and function
Fix:     what changed
Check:   how it was verified (test, harness, screenshot)
Trap:    anything that made this hard to find, or a wrong fix that was tried
```

---

## 2026-10-27  Hard-wall door panel: linked tasks missing "replaces its link" label
Seen:    On the two-door wall, picking a task from the "attach this page" dropdown never showed "(replaces its link)" even when the task already had a URL. Silently overwriting a task's existing link with the blocked page's URL.
Cause:   The wall's `door.openTasks` builder in `src/background.js` (lines ~2796, 2799) omitted `hasLink`. The heads-up countdown panel's builder (lines ~2871, 2874) correctly included `hasLink: !!t.url`. `wall.js:renderDoors` reads `tasks[ti].hasLink` to decide whether to show the warning — `undefined` is always falsy.
Fix:     Added `hasLink: false` for legacy string tasks and `hasLink: !!t.url` for object tasks in the door builder, matching what the countdown panel already did.
Check:   With a task that has a URL, the dropdown option on the hard-wall door now shows "(replaces its link)".
Trap:    Two separate builders for the same data shape in the same file, one correct and one wrong, separated by 70 lines. Easy to miss when only one surface was being tested.

---

## 2026-10-27  Streak ring shows remaining days, clashing with streak headline
Seen:    Streak card showed "48 days" in headline and "12d" in the ring. Two different numbers with the same "d" unit looked contradictory — users couldn't tell if "12d" meant 12-day streak or 12 days remaining.
Cause:   In `renderStreak` (`ui/popup.js`, `inGoal` branch), `el("ringTx").textContent = left + "d"` displayed the remaining count to the next milestone. The subline ("Day 48 banked. 12 more to 60.") already carries that count, so the ring added a conflicting number rather than complementing the headline.
Fix:     Changed ring label to `goal` (the milestone target number, e.g. "60"). Now the headline reads "48 days", the ring reads "60" as the destination the arc is filling toward, and the subline bridges them ("12 more to 60"). One number per visual role; no clash.
Check:   With streak=48 and nextMilestone=60, ring now displays "60" with the arc ~60% filled. Previously displayed "12d".
Trap:    The original comment called out "2d not 2 — the disc reads as a percentage without a unit". That reasoning applied when showing remaining days; it no longer applies when the ring shows a milestone target, since a target number is not a ratio.

---

## 2026-10-27  Off-switch sheet buttons could fire before prices loaded

Seen:    On the very first open of the off-switch sheet ever, the three pause
         buttons (10 min / 30 min / 1 hour) were enabled with no label text.
         A fast tap sent a `buyPause` message to the worker before
         `refreshOffSheet` had a chance to load prices and disable them.
Cause:   The three `.sheet-opt` buttons in popup.html had no `disabled`
         attribute. `refreshOffSheet` disables them as its first synchronous
         act, but the sheet is made `hidden=false` and an rAF is queued
         before that function runs. In that gap the buttons were tappable
         with no price shown and no mode set (`data-mode` was absent, so
         `b.dataset.mode` was undefined, collapsing to the `buyPause` branch).
         The worker's own balance check stops an actual free bypass, but the
         UX was broken — sending a purchase request with no price displayed.
Fix:     Added `disabled` to all three `.sheet-opt` buttons in popup.html.
         `refreshOffSheet` already re-enables or keeps them disabled based
         on the live balance and prices; the HTML state is now the safe
         starting point rather than an open one.
Check:   Open the off-switch sheet for the first time in a session: all
         three buttons appear greyed out with the "Checking…" message before
         prices arrive. After prices load, balance-affordable buttons become
         active as before.
Trap:    This race only bites on the very first sheet open; after that
         `refreshOffSheet` always leaves buttons in a known disabled state
         when it closes, so the second open is safe without the HTML fix.

---

## 2026-10-27  Coin progress bar hidden when subline doesn't reference it
Seen:    A thin gold progress bar appeared under the "×1.50 while the streak holds" subline with no explanation — the bar measured progress toward the next coin but the subline said nothing about coins or timing.
Cause:   `renderWallet` in `ui/popup.js` always showed `.coin-prog` regardless of which subline branch was active. The bar is only meaningful when the subline says "next coin in X min" or "first coin in X min".
Fix:     Track `showBar` per branch; set `prog.style.display = "none"` when the multiplier or "keep earning" subline is showing.
Check:   Reload extension; coin card with streak multiplier active shows no bar. Bar reappears once partialPct > 0 and a "next coin" subline is rendered.
Trap:    The bar *does* have a purpose — hiding it unconditionally would break the "next coin" feedback. Only the mismatch with the streak subline is the bug.

---

## 2026-10-18  Tasks get an optional deadline (popup, board, phone)
Seen:    Asked for: a way to see when a task has to be finished by.
Cause:   Not a bug. The only date on a task was `date`, the day it is
         planned for. That date also files the task on a day's list and
         decides when its link stops being walled, so it could not double as
         a deadline without moving tasks around.
Fix:     New optional field `due`: "YYYY-MM-DD", or "YYYY-MM-DDTHH:MM"
         local. It never changes `date` and never changes the order (rank
         stays the only order). New `ui/due.js` (NiceTryDue: parse, join,
         info, outcome) is loaded by popup.html and tasks.html.
         scripts/prepare-mobile.cjs copies the same file to mobile/lib/due.js,
         and task-list.ts re-exports it, so all three surfaces use the same
         labels. Pill on open tasks: blue "Due 27 Oct" / "Due Fri"; amber
         "Due today 5 PM" / "Due in 2h 30m" / "Due tomorrow"; red
         "Overdue · 2 days". Finished tasks show "Met" or "Missed by N days"
         (board sheet, phone meta line) instead of a pill.
         Popup: ✎ edit row has deadline day and time fields (`saveEdit`).
         Board: detail sheet has a Deadline section with Clear (`shSave`,
         `openDetail`). Phone: alarm-clock button in the composer and a
         Deadline row in the edit dialog (`withDue` in page.tsx). A time with
         no day is refused on every surface rather than guessed onto today.
Check:   70/70 tests. New test/due.test.cjs checks the labels at fixed
         times, rejects bad values (Feb 30, 25:00), checks the met/missed
         outcome, checks the phone copy is byte-identical, and checks that
         `due` survives sync and clears without moving `date`. A board-sheet
         test covers save, time-only refusal and clear. Phone, puppeteer at
         360px, 16 checks: pills and levels, composer add, time-only error,
         edit prefill and clear, long-press reorder with a pill in the row,
         offline reload keeps deadlines, no horizontal scroll, buttons inside
         the composer, no page errors. Popup and board were rendered with a
         chrome.* stub: pills, edit prefill, clear-and-save, no errors.
Trap:    page.tsx already had a local `due` (the open tasks due today), so
         importing the helper as `due` broke the build; it is imported as
         `deadline`. The third composer button pushed + out of the card at
         360px, and the dialog's date field clipped "19-10-202…". Both only
         showed at small-phone width; the drive script now checks both.
         tests/task-completion runs tasks.js slices in a vm, so its context
         needs NiceTryDue, which the real page loads before tasks.js.

## 2026-10-18  Phone app: no link field, dead links in text, "keeps logging out", blank offline
Seen:    On the phone there was nowhere to put a link separately; a URL typed
         into the task text was plain text (tapping it opened the edit
         dialog). The app regularly looked logged out, and offline it showed
         no tasks.
Cause:   Links — `mobile/app/page.tsx` rendered the whole row as one `<button>`
         with `{task.text}` as text; the only real link was a separate
         "Open link" chip, and there was no input that set `url`.
         Logged out — `mobile/lib/task-service.ts` started every launch as
         owner `guest` with `ready:false` and only switched to the account
         inside `onAuthStateChanged`. On a slow or offline phone that callback
         is late (Firebase reloads the user over the network first), so the
         screen sat on "Sign in" and an empty guest list. If Firebase dropped
         the session (any non-network error on that reload clears the user),
         the account's tasks disappeared from view although they were still
         in localStorage under `nice-try.tasks.v1:<project>:<uid>`.
         Offline — `mobile/public/sw.js` was network-first with no timeout and
         only cached the bundle after a CACHE_SHELL message; on a flaky
         connection the page hung instead of falling back.
Fix:     page.tsx: link button in the composer opens a link field; the edit
         dialog has a Link field. `parseLink` in `mobile/lib/task-list.ts`
         follows the extension's rules (missing scheme gets https://, host
         must look like a host) and writes `url` + `host`, the fields the
         extension reads; clearing the field removes both. A link-only task
         takes the host as its text, like the extension. `textParts` splits
         task text so URLs render as real `<a>` (trailing punctuation
         excluded); the row is now a `div role=button` so the anchors are not
         nested inside a button, and link taps stopPropagation.
         task-service.ts: remembers `nice-try.last-account` {owner,email} on
         sign-in. A cold start opens that account's cached tasks immediately
         (ready, editable). If Firebase reports no user without an explicit
         Sign out, the cached account stays on screen with `signedOut:true`
         ("Signed out · showing tasks saved on this phone") and the account
         screen asks to sign in again; edits keep going to that account's
         bucket and sync after sign-in. Only Sign out forgets it and returns
         to guest. Also calls `navigator.storage.persist()`.
         sw.js (cache v2): install precaches `/`, every `/assets/` file the
         page references, and icons; hashed assets are cache-first; any
         navigation is network-first with a 3 s timeout, falling back to the
         cached page; unused old bundles are pruned when a new page arrives.
Check:   64/64 tests (5 new: link parsing, inline link split, url/host removal
         through the shared merge, cold-start cached account, Firebase-drops-
         session vs explicit Sign out). Production build passes. puppeteer-core
         at 390px against the built dist: inline link opens a new tab without
         opening the edit dialog; "arxiv.org/abs/…" in the link field saves
         `https://arxiv.org/abs/…` + host; "not a link" is refused; offline
         reload shows all cached tasks with "Offline · showing tasks saved on
         this phone".
Trap:    `type="url"` on the link input made the browser's own form
         validation silently block submit for "arxiv.org/…" (no scheme) — the
         exact way people paste on phones. Text input + `inputMode="url"`
         keeps the URL keyboard without the validation. Also: a shared
         `error` state leaked a composer error into the edit dialog; opening
         the dialog now clears it.
         Adding a link from the phone exempts that page from the wall on the
         desktop, same as adding it in the extension — that is by design.

## 2026-10-05  The Chrome folder had a git repo aimed at the live remote
Seen:    Asked to sync the Chrome folder, found nothing to sync — every runtime
         file already matched `github-publish` byte for byte once CRLF and
         whitespace were ignored. The hazard was the `.git` inside it.
Cause:   `D:\for chat\focus-extension\.git` pointed at the same GitHub remote as
         `github-publish`, sat 17 commits behind, and staged eight real files as
         deleted — `LICENSE`, `README.md`, the four files under `docs/`, and the
         two artwork masters under `assets/source/` — because those had been
         moved into the development folder on purpose. Git could not know that.
         One `git add -A && git commit && git push --force` in that folder would
         have deleted `docs/PRIVACY.md` from GitHub, the exact file the store
         listing links to, and discarded 17 commits with it. The folder was fine
         as a runtime; the repository inside it was the risk.
Fix:     Bundled the whole history to
         `NOT_FOR_CHROME/archive/chrome-folder-history.bundle` with
         `git bundle create --all`, wrote `archive/README.md` explaining what it
         holds and how to restore it, then removed `.git` from the Chrome
         folder. Chrome never reads `.git`, so the loaded extension, its
         identity and its local data are untouched. `github-publish` is now the
         only checkout that can push.
Check:   `git bundle verify` reports a complete history. A `--bare` clone of the
         bundle restores all three refs with tip SHAs matching the originals
         (`main` a1f711e, `backup-2026-09-12` c224d80, `backup-before-rewrite`
         9596eb9), and `git show 48b23b5:manifest.json` reads the original
         "Focus Shield" manifest out of the oldest commit — so the archive is
         restorable, not merely present. Snapshotted the file list before and
         after removal: identical, all 36 runtime files intact, all 8
         manifest-referenced paths present, suite 12/12 against the live folder.
Trap:    Two of the branches, `backup-2026-09-12` (43 commits) and
         `backup-before-rewrite` (3 commits, reaching the first commit), existed
         ONLY in that folder — never pushed, so deleting `.git` without bundling
         first would have destroyed them silently. `git bundle --all` also
         surfaced a second worktree registered under the system temp directory;
         it was clean and its commit was already on origin, but a worktree with
         uncommitted work would have been lost the same way.
         The two `assets/source/*.png` masters look like they are missing from
         the Chrome folder. They are excluded deliberately —
         `scripts/build-extension.cjs` line 23 skips `assets/source` — so
         "fixing" that would add 2 MB of artwork to a store package.

---

## 2026-10-05  Mobile sync test could only run in one folder
Seen:    `test/mobile-sync-events.test.cjs` threw MODULE_NOT_FOUND and failed
         the suite outright in the published checkout, while passing in the
         development tree.
Cause:   Line 2 required typescript by a hardcoded relative path,
         `../mobile/node_modules/typescript`. That resolves only in a tree whose
         phone dependencies are installed, so a fresh clone, the published
         checkout and CI all failed on a `require` rather than on an assertion —
         a missing dev dependency reported as a broken test.
Fix:     Resolve `typescript` normally first, fall back to the mobile path, and
         `test.skip` with a message naming the fix (`npm ci` in mobile) when
         neither resolves. The three other mobile tests already resolved it
         without the hardcoded path, so only this one needed changing.
Check:   Skips cleanly in `github-publish` (no phone deps) and still passes in
         the development tree where typescript is installed — verified in both,
         because a skip that can never un-skip is not a passing test.
Trap:    The suite looked green before this was noticed. A runner invoked as
         `node f || node --test f` reports success when the fallback finds zero
         tests, so a module-load failure read as PASS. Each mobile test had to
         be run on its own, with its exit code checked, to see the real result.

---

## 2026-10-05  One task link exempted a whole class of YouTube pages
Seen:    Attaching a study playlist to a to-do also let a music playlist
         through, with no wall and no explanation. Separately, a watch link
         that happened to carry an uppercase path exempted every video on the
         site.
Cause:   `linkIdentity` in `src/background.js`. Three separate holes, all the
         same shape — a URL that reduced to an identity broader than the page:
         (1) `/playlist` had no branch and no `ID_PARAM_HOSTS` entry, so every
         playlist collapsed to `youtube.com/playlist`; (2) the `/watch` test was
         `u.pathname === "/watch"`, and a path is case-sensitive while YouTube
         serves `/WATCH` as the same video — the mismatch fell through to the
         generic `host + path` return, collapsing every watch page to
         `youtube.com/WATCH`; (3) `/watch` with an unreadable id (no `?v=`, or
         `?V=`) also fell through to the bare path, which matches every video
         whose id could not be read. `classify()` returns "productive" for any
         identity in `taskLinkIdentities()`, so each collision was a permanent
         site-wide exemption bought with one link.
Fix:     Compare the path through a new `lowPath` (lowercased) so case cannot
         route around a branch; add a `/playlist` branch keyed on `?list=`; and
         return "" rather than a path when a YouTube page's own id is missing.
         An unexemptable page is walled, which is the safe direction to fail.
Check:   New `test/link-identity.test.js` — 7 cases, slicing the shipped
         `linkIdentity` out of `src/background.js` with `vm` rather than copying
         it. Confirmed the test FAILS 3/7 against the pre-fix file and passes
         7/7 after, so it reproduces the bug rather than describing the fix.
         Full suite 12/12, `node --check` clean.
Trap:    The guard this breaks already existed and was documented — the comment
         above `ID_PARAM_HOSTS` explains precisely this failure ("pasting one
         page would exempt all of them") and lists nine hosts. YouTube is not
         one of them, because its branch returns BEFORE that table is consulted,
         so the host most likely to be pasted into a to-do was the one host the
         protection could not reach. Reading the table is not enough; the early
         returns above it have to be read too.
         The case bug is invisible to any test that writes its URLs in
         lowercase, which is every URL a developer types by hand.

---

## 2026-10-05  Privacy policy described a different extension than the one shipping
Seen:    `docs/PRIVACY.md` contained zero occurrences of identity, Firebase,
         account, sync or Firestore, while the manifest shipped the `identity`
         permission and three Google host permissions and the code synced tasks
         to Firestore. Two claims were outright false: "the developer has no
         server" and "**URLs** are never transmitted anywhere". The store
         listing sold "no account, no server" as a feature, listed only two of
         the three AI providers, and its disclosure table answered "Collects
         personally identifiable information: No" while sign-in stores an email.
Cause:   Documentation drift, not a code defect. Google task sync landed after
         the policy was written (20 Aug) and nothing went back to amend it. The
         URL claim is falsified specifically by `record()` in
         `src/task-core.js`, which does `JSON.stringify(t)` on the WHOLE task
         object — so `t.url`, set when a task is created from a page, rides into
         the Firestore payload. Proven by running `record()` on a task carrying
         a url and reading the output, not by inference.
Fix:     Rewrote `docs/PRIVACY.md` around "two paths off your machine, both
         opt-in": the AI provider path and the task sync path. Added the
         Firebase project by name, the `openid email profile` scopes, the email
         and session tokens stored locally, the per-account Firestore rules, the
         disconnect/erase route — and an explicit statement that a task's
         attached URL is uploaded with the task. Dropped "no server". Narrowed
         the never-sent list to claims that are actually true (page contents,
         browsing history, stats, access log, ledger, API key) and scoped the
         URL claim to its real exception. Added Gemini as the third provider,
         plus `identity` and the three sync hosts to the permission section.
         In `docs/STORE_LISTING.md`: fixed the description, added an OPTIONAL
         SYNC paragraph, wrote the two missing justification fields, flipped PII
         to **Yes**, and corrected the checklist from "Eight" fields to ten.
Check:   Grepped both files for surviving absolutes — the three hits left are
         correctly scoped ("no account" only until sign-in; a never-transmitted
         list naming only things that genuinely never move). Verified that last
         one by grepping `task-sync.js`/`task-cloud.js` for stats, wallet,
         mission, access log and verdict cache: no hits, only tasks sync.
         Verified against code: scopes string, project id, absence of any
         Gmail/Drive/Calendar scope, `securetoken` as the refresh endpoint, and
         every retention number (ledger 200, verdicts 500, access log 300,
         stats 90 days).
Trap:    The first draft of the retention section said deleting a task "stores a
         deletion marker in place of its contents". That is wrong and would have
         been a NEW false claim in the document written to remove false claims:
         `edit()` in `src/task-core.js` builds a tombstone with
         `record(JSON.parse(current.data), current, true)`, which re-serialises
         the full task and only flips the flag — the text and the URL are
         deliberately KEPT so an offline device cannot resurrect the task. Fixed
         to say the record is retained and erasure is by email request. The
         lesson: when writing a policy, every sentence about retention has to be
         read off the code path, because the plausible-sounding version of how
         deletion works is the one that gets written otherwise.

---

## 2026-10-04 - Fix Add this tab account-change error

Seen: Adding a website from the popup reported "The account changed. Reopen this task list before editing."
Cause: src/background.js taskFromTab still read chrome.storage.local.todos, then passed absent base and owner fields to TaskSync.save. The account guard rejected every add, including guest mode.
Fix: Read through TaskSync.read so tasks, merge base and owner come from the same snapshot. Keep the real account-change guard intact.
Validation: Added handler-level regression coverage using the real task store for guest and signed-in spaces, preserving existing tasks and rejecting duplicate pages. Run with node --test test/*.test.js from this development folder; syntax checked src/background.js. Live Chrome behavior requires reloading the extension worker.
Trap: Reopening the popup cannot repair missing account metadata in the worker handler.
Result: All 31 tests passed with node --test --test-isolation=none test/*.test.js; isolation disabled because the sandbox prevented child-process spawning (EPERM). Background syntax check passed.

## 2026-10-04 - Long-press task reordering on mobile

Request: Reorder by holding and dragging a task rather than entering arrow-button mode.
Cause: mobile/app/page.tsx only exposed explicit move controls.
Change: mobile/lib/long-press.ts adds a 400ms pickup gesture, a lifted task preview, insertion marker, edge scrolling, and saving through the same shared ranks on release. Moving before pickup cancels the hold and allows native scrolling. Touch cancellation, Escape, blur and effect cleanup cancel safely; post-drag clicks are suppressed across rerenders. Link and completion controls retain their normal tap behavior. Optional move buttons remain for keyboard/accessibility use.
Validation: Added touch lifecycle tests covering pickup timing, drop, ordinary scrolling, cancellation and no-move release. Production build and test outcomes follow below.
Result: All 38 regressions passed; final gesture checks and production TypeScript/Vite build passed after animation reset fix. Published to Firebase Hosting and verified live HTML references index-SWv3Kw8q.js. Touch behavior tested with synthetic event fixtures; physical phone gesture verification remains manual.

## 2026-10-04 - Mobile ordering and direct task links

Seen: The phone task list could not change task order and required opening the editor to follow an attached URL.
Cause: mobile/app/page.tsx displayed ranks without move controls and rendered the entire task body as an edit button with a Has a link note.
Change: Add a Reorder mode with 44px up/down controls, preserving completion groups and upcoming date groups. mobile/lib/task-list.ts computes shared ranks against the full list, with respacing for tied or exhausted ranks. Changes use the existing service.save/account sync protocol. Add separate 44px web links with a hostname in each task row, including HTTP(S) URLs in task text. Search disables reordering.
Validation: Added regression checks for rank round trips through the shared protocol, filtered/tied ordering, preservation of remote edits/additions, and safe link parsing. Production build and regression results recorded below.
Result: Production TypeScript/Vite build passed. All 35 tests passed, including four new mobile task-list regressions. Authenticated phone-to-extension sync was verified through protocol tests, not a live account.
Published successfully to https://nice-try-3174b.web.app. Verified the live HTML references the new production JavaScript bundle.

## 2026-10-04 - Record the actual completion day across task surfaces

Seen: Checking an overdue task in an older popup day recorded the selected day instead of the actual day of completion. Board completion also stamped future planned dates, and editing a completed task's planned date rewrote its completion date.
Cause: ui/popup.js toggle assigned viewKey; ui/tasks.js list/detail toggles clamped to future date and shSave assigned pendingDate to doneDate. Popup legacy repair could replace explicit completion dates using browsing evidence.
Change: All extension completion actions stamp todayKey while retaining the planned date, matching mobile. Board planned-date edits preserve doneDate and keep completed tasks filed on the completion day. Legacy normalization preserves explicit completion dates. Board detail and mobile completed rows show planned/completed timing, including days late or early. No historical dates are guessed or bulk-rewritten by this change; existing planned dates remain distinct from creation timestamps, which were not recorded.
Validation: Seven new regressions exercise popup, board list/detail, reopening, future and overdue dates, completed-plan editing, legacy preservation, calendar filing and mobile delay labels. All seven pass, along with the 40 existing checks from the suite run. Production mobile TypeScript/Vite build and extension JavaScript syntax checks pass; scoped git diff --check passes.
Deployment: Published mobile update and verified live HTML references index-DWfXCl-b.js. Runtime extension files updated in Chrome-loaded folder; reopen popup/task board or reload extension to use the fix. Existing inaccurate historical completion dates cannot be recovered reliably from the stored fields.

## 2026-10-04 - Restore the compact stats page scale

Seen: stats.html looked much larger than the other extension pages.
Cause: ui/stats-polish.css overrode the original 42rem content width with 62rem, scaled the heading to 2.8rem and metric values to 2.5rem, and increased card/panel spacing and review chart height.
Change: Restore a 42rem (672px) report width and 2rem heading matching the other full-page headings. Use 1.75rem metric values, compact card and panel padding, smaller navigation gaps and a 7rem weekly chart. Keep the existing report sections, data and narrow-screen layout.
Validation: Rendered the actual stats HTML/CSS/JS with representative activity data in headless Edge at 1280x1000 and visually inspected it. Both existing UI/report tests pass. Scoped git diff --check passes. Preview files and profile are in the system temporary directory, outside the extension bundle. Refresh stats.html to load the runtime CSS change; no mobile deployment is involved.

## 2026-10-04 - Sync on changes and lifecycle events instead of idle polling

Request: Stop repeatedly syncing unchanged tasks.
Cause: mobile/lib/task-service.ts polled every 30 seconds and saved/synced no-op edits; src/task-sync.js created a recurring one-minute alarm at sign-in. Successful sync also rewrote unchanged local records.
Change: Remove the mobile interval. Clear existing taskSyncPeriodic alarms at worker load and sign-in and ignore their events. Keep change-triggered one-shot uploads, sign-in, manual sync, app/page opening, return-to-visible and network-reconnect checks. ui/task-client.js handles extension lifecycle checks; remove the duplicate popup opening request. Skip no-op mobile saves and unchanged sync persistence on both hosts. Schedule one-shot follow-up for extension edits made during an in-flight sync or cloud conflicts so removing polling cannot strand them. No-op recovery skips upload.
Tradeoff: Two continuously visible idle devices do not receive remote edits instantly; return to the app or use manual sync. Live remote notifications would require a separate subscription mechanism.
Validation: All 50 tests pass, including mobile lifecycle/no-op tests, clearing/ignoring legacy periodic alarms, unchanged persistence and in-flight edit follow-up. Existing authentication, account isolation and convergence coverage passes. Mobile production build and deployment checked below.
Result: Production TypeScript/Vite build passed. Published successfully and verified live HTML references index-ByrcBRl3.js. Reload the extension to retire its existing periodic alarm; reopen the phone app to load the new code.

## 2026-10-04 - iOS-style task pickup and removal of Move controls

Request: Make phone reordering feel like iOS and reconsider the redundant Move controls button.
Cause: The long-press interaction used a blue insertion line, left a faded original row and removed the floating row immediately on release. The alternate arrow toolbar remained prominent.
Change: Remove the toolbar and arrow controls from mobile/app/page.tsx. Keep a subtle long-press hint and Alt+Arrow keyboard reordering. mobile/lib/long-press.ts now measures row geometry at pickup, opens a moving gap by animating surrounding rows, lifts the floating row with a neutral shadow, and settles it into the gap before saving. Cancellation invalidates pending settlement callbacks. Reduced motion skips lift/drop animations. Direct links and native scrolling before pickup remain supported.
Validation: Gesture regressions now check neighboring row displacement, settlement position and timing, plus cancellation during settlement. Production build and final results recorded below.
Result: Production TypeScript/Vite build and all 40 tests passed. Published successfully and verified live HTML references index-CNVEHiNl.js. Animation and gesture checks use synthetic DOM fixtures; physical iPhone feel was not manually verified.

## 2026-10-01  Hard-wall approval opened every tab
Seen:    A coherent answer at a hard wall stood the whole extension down for
         three minutes. The judge explicitly passed doubtful answers, and an
         AI-approved title could be cached as productive beyond the grant.
Cause:   `aiJudgeAnswers` accepted general reasons. `grantAccess` in
         `src/background.js` wrote the global `pausedUntil` and cached an
         approved title; `src/wall.js` described the whole tool as off.
Fix:     The judge now requires a concrete purpose connected to the page.
         Both approved answers and completed typing tests get a three-minute
         grant keyed to the real tab and page identity in session storage.
         The worker requires a hard-wall lock mark, refuses a moved page or
         active session, and does not change the global pause or verdict
         cache. Navigation, expiry, tab closure, a new focus session, and
         access-log revocation end the relevant grant. The wall waits for the
         worker's acknowledgement, and its copy says other tabs remain watched.
Check:   `node test/hard-wall-grant.test.js` — three passing checks cover
         approved and typing grants, missing or non-hard marks, an active
         session, a changed URL, another tab or video, expiry, and the judge
         prompt. The two prior pause tests still pass. `node --check` passed
         for the changed scripts; `git diff --check` passed.
Trap:    The existing reprieve map is keyed only by page identity and releases
         entries when any tab navigates. Hard-wall grants therefore use a
         separate tab-keyed map. The approved-title cache also had to stop
         writing, or the new three-minute expiry would not be real.

## 2026-10-01  Off switch offered unlimited free time
Seen:    The switch could turn blocking off indefinitely with one action when
         there was no streak. With a streak, its sheet offered unlimited free
         15/30/60-minute pauses regardless of the daily allowance.
Cause:   `ui/popup.js` only intercepted off when `lastWallet.streak > 0`.
         Its sheet called `pauseFor` without the free-row source, while the
         worker's `pauseFor` handler only rationed requests from that row.
Fix:     The switch now opens a pause sheet every time. It fetches the current
         wallet and downtime, shows 10/30/60-minute choices as free or with
         live coin prices, and uses `pauseFor` or `buyPause` accordingly.
         The worker rations every free-pause request and serializes concurrent
         free requests. Manual off has a separate confirmation and remains
         available if no timed option can be afforded.
Check:   `node test/pause-ration.test.js` and `node test/off-switch.test.js`
         passed. They cover the worker's budget and busy refusals, free and
         paid sheet choices, the zero-streak switch, unaffordable prices, and
         manual-off confirmation. `node --check` passed for both changed
         scripts; `git diff --check` passed.
Trap:    `source` came from the popup, so it could never be the authority for
         whether a free pause was allowed. The sheet's earlier 15-minute
         choice had no store item; the new choices match 10/30/60-minute
         store items so paid prices and purchases agree.

## 2026-10-01  Free pause row could bypass its daily ration
Seen:    The free pause row allowed unlimited pauses in the testing build.
         Turning that testing mode off would still let reason chips and Enter
         bypass the one-per-day, within-budget rule.
Cause:   `FREE_PAUSE_UNLIMITED` was true in `src/coins.js` and `ui/popup.js`.
         In `ui/popup.js`, the chip and Enter handlers called `pauseFor`
         without `source:"row"`; `src/background.js` only applies the ration
         to messages with that source.
Fix:     Removed the two testing flags, made the worker enforce the free-row
         rule unconditionally, and added `source:"row"` to both missing
         handlers. The popup hides used free-row buttons and refreshes them
         even when the downtime bar has less than one minute to display.
Check:   `node test/pause-ration.test.js` — two passing checks drive the
         worker's real pause handler through eligible, repeat, and over-budget
         cases and exercise all four popup answer paths. `node --check` passed
         for all three changed scripts; `git diff --check` passed.
Trap:    The off-switch sheet intentionally sends no `source` and remains a
         separate free path. Proposal A1 covers it; this change only rations
         the popup's free row. `node --test` could not spawn its child process
         in this sandbox, so the test file was run directly with Node.

## 2026-09-22  "Add this tab" says it couldn't reach the worker
Seen:    Screenshot from Bhavesh: the popup over youtube.com, chip pressed,
         red line "Couldn't reach the worker — reload and retry." Nothing
         added.
Cause:   The chip's reply handler in ui/popup.js treated every no-answer the
         same, and two very different things produce one. (1) The worker
         Chrome is running has no `taskFromTab` handler: an unpacked
         extension reads popup.html/js FRESH FROM DISK every time the popup
         opens, but keeps the service worker it registered until the
         extension itself is reloaded at chrome://extensions. So the chip
         (new popup) was talking to a worker from before commit 0eb93b9; the
         listener fell through every `if`, returned nothing, Chrome closed
         the port, and the popup got `lastError` with no reply. "Reload and
         retry" then reads as reload the PAGE, which cannot fix it. (2) A
         throw anywhere in the `taskFromTab` async block after `return true`
         (src/background.js) left the port open with nothing on it — same
         message in the popup, or a hang. The handler code itself is right:
         the real worker in a vm answered every case (37 checks) both before
         and after this change, which is what pointed at the loaded copy
         rather than the file.
Fix:     src/background.js `taskFromTab`: the async body is wrapped in
         try/catch; a throw is logged and answered as
         `{ ok:false, reason:"error", err }` so the popup can show it.
         ui/popup.js: on no reply, `workerAlive()` sends `wallet` — the
         oldest thing any build answers. If that comes back the worker is
         alive but stale, and the line says so: "The tool's worker is out
         of date. Reload Nice Try at chrome://extensions, then try again."
         If nothing answers: "Couldn't reach the worker. Reload Nice Try at
         chrome://extensions and try again." A `reason:"error"` reply shows
         "Couldn't add it: <err>." Both lines now name WHAT to reload.
Check:   Scratchpad tab.test.js (real worker in a vm): 41 checks, the four
         new ones — a storage.set that throws answers with reason "error"
         and carries the message (against the HEAD worker the same check
         is an unhandled rejection and no reply, i.e. the bug); an unknown
         message type answers nothing (the stale shape); `wallet` still
         answers, so the probe works. drive3.mjs (puppeteer, stubbed
         chrome): 17 checks, the three new ones — stub in stale mode
         (`taskFromTab` unanswered, everything else answered) shows the
         out-of-date line; stub in dead mode shows the couldn't-reach line;
         a reason:"error" reply shows its message. Chip re-enabled and no
         row added in all three; zero page errors. Screenshot s1_stale.png.
         To clear the report itself: reload Nice Try at chrome://extensions
         once — every popup-side change lands on its own, worker-side ones
         do not.
Trap:    The vm harness and the puppeteer stub both load the CURRENT files,
         so neither can ever reproduce "Chrome is running an old worker" —
         all green while the user sees red. When a message the file plainly
         handles comes back unanswered in Chrome, ask whether the extension
         was reloaded since the worker last changed before reading code.
         And the Claude-in-Chrome tools timed out again (third time), so
         the live worker's console could not be read.

## 2026-09-21  No way to make the page you are on a task without copying its URL
Seen:    Bhavesh asked for "the ability to add to the task with the current
         tab I am in". The only route was copy the address, open the popup,
         paste it into the add row.
Cause:   Not a bug, a missing door — but one with an architectural trap.
         Linked tasks already had two writers with different prices: the
         popup's add row (a link you pasted: free, planned) and the wall /
         countdown's task door (a link written under a block: 2 or 3 coins,
         marked `late`, page reprieved). A one-click "this tab" in the popup
         is, by construction, the priced door with the friction removed —
         open the popup while the countdown strip is up, press the chip,
         and the block is called off for nothing. The paste route always
         allowed this in principle; making it one press is what would make
         it the habit.
Fix:     New worker message `taskFromTab` in src/background.js. The WORKER
         reads the active tab (url, title, id) — the popup only sends the
         day it was viewing and, optionally, a text — and prices the task by
         what the tool was doing to that page at that moment:
           walled (a `lockedTabs` mark on the tab) → refused, reason
             "walled". The wall has its own door and it is the only door.
           warned (`headsUpAt > 0` and `lastTitle` is this page's title) →
             the countdown's `chargeLateTask` price, `late: true`, the page
             reprieved and the strip stood down via `clearHeadsUp` — the
             same outcome as answering the strip. A future-dated task is
             still charged but not reprieved: its exemption starts on its
             day, and the popup says so.
           neither → free and planned, exactly as a pasted link.
         Duplicates are matched on `linkIdentity`, not the string, so the
         same video with `&t=` is one page; a DONE task with the page does
         not block a new one. `taskTextFor` suggests the text: the title
         with the unread badge and the site's own suffix removed
         ("… - YouTube"), falling back to the host. Host stored without
         `www.` like the add row. `resetStreak()` after every write, as
         `taskLinkAdded` does, so a tab already on the page stops being
         walled without waiting.
         ui/popup.js / popup.html: an accent pill under the add row, "Add
         this tab · host", tooltip is the page title. Hidden on non-web
         pages; reads "This tab is on your list" and disables when a live
         task already carries the exact URL. On success the popup re-reads
         `todos` from storage (the worker wrote it) and settles the new row
         in; the message says free / charged / walled / already listed.
Check:   Scratchpad tab.test.js (real worker in a vm, stubbed active tab):
         37 checks — title cleaning, free add with rank/url/host/date and
         the page then exempt by identity, duplicate by identity, done task
         not a duplicate, chrome:// refused, walled refused with nothing
         written, warned → late + 2 coins (10 → 8) + reprieve + strip
         cleared, a strip on ANOTHER page does not price this one, future
         date while warned is charged but not reprieved, and popup-supplied
         `free`/`charge`/`late` fields are ignored. drive3.mjs (14 checks):
         chip text/host/tooltip, row added with link and settle-in, count,
         charge message, walled message with chip re-enabled, pre-linked
         state, hidden on chrome://. Full regression after: 53 + 37 worker,
         25 + 18 + 14 browser, zero page errors.
Trap:    `hostOf` in the worker keeps `www.`; the popup's `hostOfUrl` strips
         it. The first version stored "www.youtube.com" and the title
         cleaner then looked for a site called "www", so " - YouTube"
         survived. The two hosts must be the same string or the chip's
         "already on your list" check silently never matches. And in the
         browser stub, a reply object built eagerly for every message type
         ran the taskFromTab side effect on every wallet poll — twelve
         tasks appeared from one click. Build side-effecting replies lazily.

## 2026-09-21  Adding 30 min to an hour's pause shortened it; the banner and the badge disagreed; downtime counted planned time
Seen:    Three reports in one sentence from Bhavesh. (1) Pause for an hour,
         then press "30 min" — the pause did not get longer. (2) The popup's
         paused countdown and the toolbar badge showed different times after
         that. (3) "If I switch off some pause the entire thing is being
         calculated" — a pause resumed early, or one Chrome was closed
         through, still counted for its full planned length somewhere.
Cause:   Four separate faults, one per surface.
         (1) `pauseFor` in src/background.js assigned
         `pausedUntil = Date.now() + mins` outright. `buyPause` extended from
         `max(now, pausedUntil)`; the free row replaced. So "30 min" forty
         minutes into an hour threw away the twenty still held and left
         thirty. It also never called `loadPause()`, so on a fresh worker
         the in-memory deadline was 0 regardless.
         (2) `renderPause` in ui/popup.js created its 1 s timer as
         `setInterval(() => renderPause(until))` with the `until` of the
         call that STARTED it, and never restarted it while a pause was on
         foot. Any later call with a new deadline painted once and was
         overwritten a second later by the stale closure. The badge reads
         the worker each tick, so the two drifted apart.
         (3) `closeDownRow` in src/background.js, when given a `cap` (the
         pause's own deadline), closed at `min(now, cap)` and ignored the
         staleness rule that every other close honours. A pause that expired
         while Chrome was shut counted in full; the same pause with Chrome
         reopened mid-way counted only its live stretch. Two numbers for
         one hour, depending on when you came back.
         (4) The "Why you paused" footer in ui/stats.js summed `minutes` off
         the pause log — the length ASKED for. An hour resumed after five
         minutes read as "60 min with the wall down at no cost".
         Also found on the way: turning the switch off mid-pause closes the
         pause's downtime episode and opens an "off" one; turning it back on
         closes that; the pause is still running but nothing reopened its
         episode, so the remainder was never recorded. `beatDown` found no
         open row and returned.
Fix:     (1) `pauseFor` loads the pause first and extends from
         `max(now, pausedUntil)`, same as `buyPause`. The panel's "back at"
         note uses total time left, not the minutes just added.
         (2) `pauseUntilAt` is a module-level deadline; every `renderPause`
         call writes it and the interval reads it.
         (3) `closeDownRow` applies the staleness rule first and then clips
         to the cap. One rule — "off while Chrome was open" — however an
         episode ends.
         (4) The footer reads `down.free` from the downtime record for the
         same seven days and shows it only past a minute.
         `beatDown(kind)` now opens an episode when none is open, with the
         kind the tick knows is standing the tool down ("off" on the
         disabled path, `pauseKind` on the paused path).
Check:   Scratchpad pause.test.js loads the real worker (background + wall +
         coins) into a Node vm with a stub `chrome`, in-memory storage and a
         fake clock that advances through ticks. 53 checks: 60 + 30 at
         minute 40 gives 50 left, not 30; Resume at minute 45 records 45,
         not 90; switch off at minute 10 of a pause closes the free row at
         10, the off row runs 10, switching on re-opens the pause's row and
         it counts 20 more; a pause that expires with no ticks (Chrome
         closed) closes at its last beat, not its deadline; bought minutes
         still stack; a session cancels the pause and closes its episode at
         now; pauseFor/buyPause refused mid-session; store price =
         ceil(list × mult) with mult from pauses started today; the
         downtime message agrees with downSummary; Resume on a FRESH worker
         still closes the episode; downSummary clips across midnight;
         schedule stands the tool down and a session overrides it.
         puppeteer-core drive.mjs + drive2.mjs (44 checks) against the popup with a
         stubbed worker: banner reads 59:59, `renderPause` is called with 90
         min, two seconds later it reads 89:59 and the header says "back in
         90 min" — before the fix it snapped back to 59:5x.
Trap:    A harness that jumps the clock forty minutes and then ticks is
         testing the CHROME-WAS-CLOSED case: the stale rule closes the
         episode and opens a new one, and every duration reads 0. Step the
         clock a minute at a time with a tick per step to mean "sat there
         with the tool paused". And the git HEAD worker predates the whole
         downtime record, so "run the harness on the old code" needs the
         working-tree file with the two lines reverted, not a checkout.

## 2026-09-21  Tasks and their links could not be edited in place
Seen:    A typo in a task, or a link pasted wrong, meant delete and retype.
         The board's sheet could change the text, but the link only by
         pasting a URL into the text field, and there was no way to remove
         one short of deleting the task.
Cause:   Nothing wrote to an existing task's `text`, `url` or `host` except
         the board's Save, and that only read one textarea.
Fix:     ui/popup.js: a pencil beside the × on every row. `editIndex` marks
         the row; `renderTodos` paints it as two fields (text, link) with
         Save/Cancel. `saveEdit` lifts a URL out of the text field when the
         link field is empty (same rule as the add row), prefixes `https://`
         when no scheme was typed, writes `url`+`host` or deletes both when
         the field is cleared, and sends `taskLinkAdded` when the link
         changed. Enter saves, Escape cancels, delegated on the list. An
         empty task or a bad link is refused and marked, not saved and not
         deleted — the × is the delete. ui/tasks.js / tasks.html: the sheet
         gets a `shUrl` field under the textarea with an "Open ↗" beside its
         label; the duplicate Link meta row is gone; the Wall row stays.
         Save follows the same rules as the popup; Enter in the link field
         saves. The exemption is derived from the list, so removing the link
         is the whole change on the worker side.
Check:   puppeteer-core drive.mjs + drive2.mjs, 44 checks over popup, board
         and scoreboard: prefilled
         fields, focus, scheme added, host kept, row re-rendered, link
         cleared removes `url`+`host` and the link line, bad link refused
         with the row/sheet left open, Escape cancels, URL in the text field
         lifted into the link. Screenshots p2/p3/p4 and t1/t2 read correctly.
Trap:    `hostOfUrl` is not a validity check. Chrome's URL parser accepts
         `https://not a link at all` and percent-encodes the spaces into the
         host (Node throws on the same string), so the first version saved
         a sentence as a link. `looksLikeHost` requires dotted labels of
         letters, digits and hyphens. Also: puppeteer's
         `click({clickCount: 3})` does not select-all in an input reliably;
         `el.focus(); el.select()` does.

## 2026-09-18  Wall tier ignored how sure the judge was; streak ring showed a coin percentage
Seen:    A page the AI judge was only half-sure about got the same
         "This looks off-mission" wall, and the same 1.5x once-price, as a
         page it was certain about — there was no cheaper door for a
         borderline call. Separately, the popup streak card showed a ring
         reading "15%" next to "9 min, or 1 days die tonight".
Cause:   Two unrelated things, both "a true number in the wrong place".
         (1) `aiRelevant` in src/background.js asked the model for one word,
         WORK or DISTRACTION, so confidence was never expressed. With no
         number to read, `wallTierFor` inferred it from circumstance alone —
         if `todosCount > 0` and the basis was "judge", every verdict became
         `medium` regardless of how marginal it was. Certainty was assumed,
         never measured.
         (2) `renderStreak` in ui/popup.js painted `partialPct`, which
         background.js computes as `partialSec / (COIN_MINUTES_PER_TICK*60)`
         — progress toward the next COIN. On a card whose every other line is
         about the STREAK that is a second currency an inch away, and it was
         the same fact the subline below already gave in minutes (`minsLeft`
         is derived from the same `pct`). A ratio where the card's own banked
         state already used a distance ("2d").
Fix:     (1) The prompt now asks for "WORK or DISTRACTION, a space, then a
         0-100 number", with the bands spelled out, and the token cap goes
         16 -> 24 so word plus number always fits. `parseScore` reads the
         number anchored to END of string (a title like "Top 10 Python
         Tricks" is full of digits that are not the score) and returns -1,
         not 0, when absent — a missing score and a confident 0 are opposite
         states. The score rides on `lastScore`, reset in `classify()` beside
         `verdictBasis` and restored on both cache-read paths from a new
         `verdictScores` map trimmed alongside `verdictCache`.
         `wallTierFor` now splits judge verdicts at `SCORE_SURE` = 70:
         >=70 medium, below it low. A score can never produce `hard` — a
         text gate on an opinion stays banned however confident the opinion.
         Course platform / overruled host / empty task list still cap at low,
         since each says the judge had less to read than it thinks; the one
         exception is an empty list with a score >=90. No score at all
         reproduces the old behaviour exactly.
         (2) The ring shows `minsLeft + "m"` in both states, never a percent,
         with `minsLeft` hoisted above the ring block so the ring and subline
         cannot quote two different numbers. Added `days(n)` and routed all
         four day-count strings through it.
Check:   Node vm harness (scratchpad t.js) over the extracted `wallTierFor`,
         `parseScore` and `parseVerdict`: 30 checks, all passing. Covers the
         70 boundary inclusive, 69 -> low, score 100 still only medium, the
         three situational caps beating a 95, empty-list 95 -> medium vs
         85 -> low, and absent/out-of-range/null scores -> -1 -> old
         behaviour. Confirmed `parseVerdict` still reads "DISTRACTION 85"
         correctly. `node --check` clean on all four touched files.
Trap:    `parseScore` must be anchored to the end, not a bare `\d{1,3}` —
         the first match in an echoed title wins otherwise, and the wall gets
         priced off a number from the video's name. And -1 must not collapse
         to 0 anywhere: 0 is the judge's most confident WORK, so defaulting a
         missing score to 0 would read as maximum certainty rather than none.
         The score deliberately does NOT go into `verdictCache`'s values —
         that map is persisted as plain strings and compared `=== "junk"` in
         several places; a parallel map keeps the verdict path untouched, and
         the two falling out of step degrades to "no score", never to a wrong
         one. Both caches must be trimmed together or the score map leaks.


## 2026-09-14  Audio playing behind the wall after a hard refresh
Seen:    Reload a walled YouTube tab: black "Nice try." cover, video audio
         playing underneath it for a few seconds.
Cause:   `showHold` in src/background.js (the document_start cover) only
         painted a black div. The page boots behind it and YouTube autoplays
         as soon as its player exists. The real wall, whose `freezeMedia`
         pauses every video/audio each 500 ms, only arrives after `tick()`
         → `nudge()` → `wallData()` → the AI round-trip, 1 to 4 s later.
Fix:     `showHold` now runs its own 250 ms freezer: exits fullscreen and
         PiP, pauses every video/audio, keeps going until the real wall
         (`#__focusshield__`) appears or the cover is gone for good. Same
         pause the wall uses, so the handover is seamless.
Check:   Scratchpad hold.html: audio playing, showHold injected, a second
         audio element created 400 ms later. After 1.5 s both are paused
         and the late one's play() was aborted. Worker harness: 69 passed.
Trap:    The cover is injected with executeScript({func}), so it is
         serialised and cannot reference anything else in the worker; the
         freezer has to be written out inside it, not shared with wall.js.

## 2026-09-14  Two-door wall read as confusing
Seen:    Screenshot from Bhavesh: intro card, amber eyebrow, "You decide what
         this is.", a grounds line, then a door with a dropdown AND a text
         field, a coin note nobody could parse, and a price on a button that
         was free half the time. Nine pieces of text before a choice.
Cause:   Each element was justified on its own and nobody read the screen as
         a whole. The grounds line was true and useless in the common case.
Fix:     `renderDoors` in src/wall.js: one headline (the existing heading
         plus a full stop), one line naming the three ways out, grounds only
         when they carry information (worker now sends "" for the plain
         "judged against your mission" case in `wallData`). Intro card gone
         from this screen. Task door: picker leads with a "Write a new one…"
         option; the text field, the price note and the coins on the button
         appear only on that route. Attaching shows "Free". Once-door note and
         broke message shortened. Leave button is "Close the tab".
Check:   Headless Chrome screenshots of six states (default, no tasks, new,
         attach, broke, medium) from scratchpad doors.html, no page errors.
         Worker harness: 69 passed.
Trap:    Read the whole screen before adding a line to it. The text field is
         hidden via style.display, not the hidden attribute, because the wall
         is injected into pages whose stylesheets it does not control.

## 2026-09-13  Course lesson walled on an empty task list
Seen:    A LinkedIn Learning lesson was walled by the AI judge. The only way
         through was the reason box, and "its a course" had to be argued.
Cause:   Every junk verdict got the same hard wall, whether it came from a
         certain rule (block-list, keyword) or an uncertain AI call on a page
         with no tasks to read against. A text gate on an uncertain call is
         where people learn to lie to the box.
Fix:     `classify()` in src/background.js records `verdictBasis` via
         `junkBy()`. `wallTierFor()` maps it to hard / medium / low. Only
         certain verdicts get the questionnaire. Uncertain ones get
         `renderDoors` in src/wall.js: two priced doors and no reason box.
         "Make it a task" costs `WALL_TASK_CHARGE` (3), attaching to an
         existing task is free. "Just this once · 15 min" costs `ONCE_LIST`
         (4), ×1.5 per prior claim today, ×1.5 on medium, capped ×6, and
         refuses when broke. `LEARNING_SITES` only lowers the tier and adds a
         hint to the AI prompt; it never allows a host.
Check:   Scratchpad harness (stub `chrome`, `importScripts` real files via
         `vm`). 69 checks, including the prompt carrying the platform hint.
Trap:    The tier must come from the worker via the `lockedTabs` mark. No
         mark means no wall stood, so the claim is refused (`nowall`).

## 2026-09-12  No honest way to say "nothing" from the countdown panel
Seen:    The panel offered write-a-task or attach-a-task. Both kept the tab
         open. Closing the tab by hand earned no walk-away credit.
Cause:   The existing "leaving" message is gated on `lockedTabs` holding a
         wall mark. From the panel no wall was injected, so leaving paid 0.
Fix:     "Close this tab" under a divider at the panel foot. New `quitEarly`
         handler in src/background.js credits a walk-away, clears the streak,
         and closes the tab from the worker, with `window.close()` fallback.
Check:   Test asserts the header ✕ can never close a tab and this button
         always does.
Trap:    Two controls that both read as "close" is a trap. They differ in
         shape, position and wording on purpose.

## 2026-09-11  The charge on the panel was invisible
Seen:    "costs 2 coins" was grey 11.5px text under the button that spent it.
Fix:     Gold coin discs on the button behind a divider, leaving one at a time
         (130 ms stagger) on press. Attaching hides them, since it is free.
         Also: the saved task sat on #0f0f11 over #1C1C1E, invisible.
Check:   puppeteer-core motion harness (see docs note in memory).

## 2026-09-11  Oldest task always floated to the top
Seen:    Dragging a task to a new position did nothing lasting. The "moved
         8×" task always came back first.
Cause:   Sort used overdue age as the primary key. Age ruled, so manual
         priority could not be expressed.
Fix:     Numeric `rank` (gap 1024). Sort: done sinks, rank ascending, age only
         as tiebreaker. All three writers stamp a rank: `nextRank()` in
         ui/popup.js and ui/tasks.js, `nextTaskRank()` in `captureTask`.
Check:   400 worst-case drops into one slot never collapse the gap;
         `needsRespace` renumbers at <0.001.
Trap:    `rankOf()` must return Infinity for a missing rank, never `rank || 0`.
         A real rank of 0 (dragged to the very top) reads as missing otherwise.

## 2026-09-09  Wall arrived seconds after the countdown hit zero
Seen:    Panel said "blocking now", then the page stayed visible for 1 to 4 s.
Cause:   `nudge()` awaited `wallData()`, which awaits `aiQuestion()`, a live
         Groq/OpenRouter call.
Fix:     The `document_start` cover goes up first (no network, no state), the
         real wall replaces it in place when ready.

## 2026-09-09  Leave sent tabs to about:blank instead of closing
Seen:    Pressing Leave on YouTube left a blank tab to close by hand.
Cause:   `hasUnsavedWork()` queried `[contenteditable=true]`, which matches
         YouTube's own comment boxes. The countdown panel's own input was also
         counted as the page's unsaved work, so answering the panel kept the
         tab alive.
Fix:     contenteditable dropped, invisible fields skipped, panel input
         excluded.

## 2026-09-08  YouTube homepage got walled
Seen:    The feed itself was blocked once notifications passed nine.
Cause:   Title becomes "(19+) YouTube". `normalizeTitle` only stripped a bare
         "(2)", so the "+" survived and the title missed `BARE_LANDINGS`.
         "Home - YouTube" and "YouTube - YouTube" also fell through.
Fix:     Every badge shape is stripped. A title made only of the site name
         plus a filler word (home, trending) is a landing page and is never
         walled. The video you open is still judged on its own title.

## 2026-09-08  Asked the same task question twice
Seen:    Countdown panel asked "what are you doing here", then the Leave
         screen asked again.
Fix:     The post-Leave capture screen was removed. Leave goes to goodbye.

## 2026-09-06  Countdown showed 7 s, not 18
Cause:   A slow AI verdict back-credits the whole dwell in one jump, so
         `junkStreak` could arrive at the check already past the warning
         window. Sometimes the wall dropped with no warning at all.
Fix:     A floor on the countdown. When the true remainder is under it, the
         wall is pushed out to match instead of the panel lying. The warning
         window has no upper bound, so every first wall gets a warning.

## 2026-09-06  Late tasks were free
Fix:     Writing a task from the wall or panel costs 2 coins (now 3 from the
         two-door wall). It prices when the task was written, not the
         writing. Never blocks the save: task first, charge after. Duplicates
         are not charged. Attaching to an existing task is free.

## 2026-08-31  Every task wore "TODAY'S FOCUS" forever
Cause:   Tasks had no date field.
Fix:     Tasks carry the day written and the day finished. Undated legacy
         tasks adopt today. Unfinished work carries forward with a "moved Nx"
         pill. The wall and classifier only read tasks dated today or earlier
         and still open, so a task parked on Saturday cannot exempt a site on
         Monday.
Trap:    ui/tasks.js copies the date helpers and never writes the migration
         back. Only the popup repairs legacy tasks. Ticking a task stamps
         `doneDate` from today, never from the day being viewed.

## 2026-08-31  Header said "paused" while the switch sat green
Cause:   The wallet poll calls `setStatus()` on a timer and flipped the header
         back mid-pause.
Fix:     Paused state owns the header. `setStatus()` no-ops while it is set.

## 2026-08-25  "AI failed: unclear answer" on a working key
Seen:    Groq key worked in curl, extension said the answer was unclear.
Cause:   Groq's model list includes reasoning models (qwen3, gpt-oss,
         deepseek-r1 distills, magistral) whose thinking tokens count against
         `max_tokens`. With a 5-token cap they returned empty content and
         `finish_reason: "length"`.
Fix:     `isReasoningModel()` matches by family. `chatBody()` sends
         `reasoning_effort: "none"` and raises the cap to 512 for them. A 400
         on that field retries once without it. Empty content falls back to
         `message.reasoning`.
Trap:    Looks exactly like a bad API key. Do not send the user to re-check
         credentials first.

## 2026-08  Toolbar icon stayed grey after switching back on
Seen:    Flip the switch on, icon stays grey. Read as a dead button.
Cause:   Three stacked causes. (1) The `storage.onChanged` handler assigned
         `offReason = OFF_NONE` instead of deriving it, so `tick()` found the
         real stand-down reason (missing host permission) and greyed it again
         milliseconds later. (2) `setIcon({path})` does not reliably undo
         `setIcon({imageData})` in an MV3 worker. (3) The restore was wrapped
         in an empty catch, so the failure was invisible.
Fix:     One deriver, `reassertOffPaint()` in src/background.js, is the only
         thing that decides the icon. It calls `noteOffState()`, the single
         writer of `offReason`. Both painters repaint through ImageData from
         `loadIconPixels()`, which returns fresh buffers. `lastIconPaint` /
         `lastIconError` plus an `iconDebug` message expose the state.
Trap:    Three fix attempts failed before (2) was found. Never assign the
         off-state, derive it. Never null a shared cache (`hostAccess = null`)
         from a message handler that a 3 s tick also reads. Every async
         handler that returns true must reach `sendResponse` on every path.

## 2026-08  Capture box could unblock its own page
Seen:    Design review, not a shipped bug.
Cause:   A task with `url` + `host` exempts that page from scanning. If the
         wall's own capture box wrote those keys, four characters typed on the
         way out would permanently unblock the page.
Fix:     Capture stores the page under `from`, rendered as muted text, never
         a link. Test asserts the countdown panel sends no message that could
         lift the block.
Trap:    The 2026-09-09 change deliberately reverses this for the countdown
         panel only, because answering the countdown already reprieved that
         exact page. The bound is that the task stays open.

## 2026-08-16  Chrome extension tools not connected
Seen:    Claude-in-Chrome "extension is not connected", again on 2026-09-06.
Fix:     Headless harness. Copy the ui file to the scratchpad with a
         `stub.js` faking `chrome.*`, serve with an inline node server, and
         screenshot with `chrome.exe --headless=new --screenshot=<ABSOLUTE
         PATH>`. Use puppeteer-core for anything time-based, since
         `--virtual-time-budget` freezes CSS transitions.
Trap:    A relative screenshot path fails with "Access is denied".

## 2026-09-12  Phantom "claude" contributor on the GitHub repo
Seen:    Sidebar showed two contributors. API showed one.
Cause:   GitHub caches the sidebar contributor fragment separately and does
         not invalidate it on force-push. No git operation reaches it.
Fix:     Support ticket. Do not rewrite history again for this.

## 2026-09-16  Ticking a task off read as the row vanishing
Seen:    On the tasks page, clicking the complete circle made the row
         disappear from under the cursor and reappear at the bottom of the
         list, already struck through. Nothing was lost, but the eye never
         saw it move, so it read as random.
Cause:   Two things, both in ui/tasks.js. (1) `onRowClick`'s toggle branch
         called `save()`, which awaits storage and then calls `render()` —
         `renderDay()` replaces `taskList.innerHTML` wholesale, so the row
         element that was clicked is destroyed and a different element is
         built at the sorted position. (2) The finished state was declared,
         not animated: `.task.done .txt { text-decoration:line-through }` in
         ui/tasks.html paints the full line on the first frame it exists.
         Between them there was no frame in which the row was both struck
         and still in its old position.
Fix:     `strikeThenSave(row, done)` in ui/tasks.js now owns the tick. It
         flips the data immediately, adds `.done` + `.is-striking` to the
         live row, waits --dur-mid, and only then saves. The line itself is
         a `.txt .tx::after` pseudo-element scaled scaleX(0→1), so it is
         drawn across the words; `rowHTML` wraps the label in `<span class=
         "tx">` because .txt is a full-width block button and a line on it
         overshot short tasks. After the render, `travel(before)` does a
         FLIP — `measureRows()` before, `getBoundingClientRect()` after,
         then a translateY from the old position on the --spring curve — so
         the row is seen going to its new place. The detail sheet's
         `shToggle` gets the travel but not the strike, since the sheet was
         covering the row. Durations and curves are read from the CSS tokens
         via `motion.tokens()`, matching the `show` helper in ui/popup.js.
Checked: puppeteer-core harness (see 2026-08-16), sampling per rAF. Ticked
         row holds y=400 for ~280ms while ::after scales 0→0.997, then moves
         pos 0→2 starting from y=400 and settling at y=546 by ~1000ms.
         Un-tick retracts the line and travels back. With
         prefers-reduced-motion:reduce it jumps to pos 2 at 60ms with a real
         `line-through` and no animation classes. No page errors.
Trap:    `--virtual-time-budget` freezes Web Animations, so the static
         screenshot route cannot see any of this — it shows only the settled
         state. Also: the strike must be removed from the row before the
         render, or the resting `.task.done .txt .tx::after { scaleX(1) }`
         rule and the running keyframe fight over the same property.


## 2026-10-02 ? Separate development files from the loaded extension

The mobile dependency install added about 658 MiB beneath the Chrome-loaded folder. Generated mobile dependencies/build caches were removed in the previous cleanup. At the user's request, all mobile source, docs, tests, scripts, Firebase deployment files, source artwork and UI sandboxes are now grouped in NOT_FOR_CHROME for manual relocation. Runtime remains at the existing Chrome path. Development scripts and tests resolve the extension via extension-root.cjs so the extras folder can move independently. The earlier startup change runs popup storage/task reads concurrently and avoids guest/unconfigured sync alarms. Checked the runtime references and existing test suite.


## 2026-10-02 - Skip unchanged task saves

Cause: src/task-sync.js save() rewrote taskSpaces and todos and scheduled account sync even when the editor made no effective change. This could cause redundant task-page refreshes and sync work. Save now compares the merged records and persists/schedules only actual changes, while still returning the latest tasks to stale editors and enforcing account checks. Regression coverage verifies no-op saves, stale editors, changed account saves and local-only edits.


## 2026-10-03 - Stats and phone account presentation

The phone section mixed unavailable sign-in, account explanations and manual transfer instructions with undersized buttons. Replaced it with a compact status card, conditional account actions, explicit opt-in for existing tasks and collapsible backup/account controls. Stats now prioritizes time metrics and page detail, with rewards and explanations collapsed, responsive spacing, page navigation and keyboard range controls. Initial stats render no longer waits for wallet data. Fixed Last 7 days selecting seven recorded dates rather than calendar days, and neutral-only review showing an empty state. Verified JS syntax and account/report rendering tests. Visual browser verification was unavailable because no Chrome browser is connected.


## 2026-10-03 - Remove phone promotion and prepare independent hosting

Removed the phone account card and its script/style includes from extension Settings as requested. Shared ghost buttons now have 42px minimum height, vertical padding and normal line height, fixing the collapsed Test the key control. Converted the companion app entry/build to standalone Vite/React with static Firebase Hosting configuration, replacing Sites/Cloudflare runtime dependencies. Previous build configuration is preserved in previous-hosting. Hosting requires the user's Firebase project and authenticated deployment.


## 2026-10-03 - Prevent zero-data popup flash

The HTML rendered default zero-day streak, zero coins and empty task/stat state before asynchronous reads finished. Added a CSS loading gate present in the initial HTML, with inert controls until real task/settings data is painted. Wallet fetching starts alongside storage reads; streak and coin cards retain neutral placeholders until their worker response arrives. Storage failures replace the template with an error instead of exposing fake empty data. Delayed-storage, delayed-wallet and read-failure regression checks verify the reveal order.


## 2026-10-03 - Google account pages and shared tasks

Added dedicated extension account page through popup profile icon and task-page link. Configured common Firebase project and Google provider, created Firestore and deployed owner-only rules. Phone account screen is deployed on Firebase Hosting. Changes sync automatically; extension polls every minute and visible phone app every 30 seconds. Verified the deployed build and rejected unauthenticated database access; regression tests simulate two-device changes and OAuth nonce validation. Actual Google sign-in still needs the user to complete their account flow.

## 2026-10-03 - Recover local tasks hidden by account switching

Sign-in switched taskSpaces.owner to a separate account list; without import consent, saved guest tasks disappeared from view even though preserved. Added account-page count and Restore local tasks action. It backs up taskSpaces (no credentials), copies only missing live guest records, preserves existing account edits/deletions, and schedules upload. Repeat recovery is idempotent. Popup now refreshes on stored task changes and requests sync on opening, deferring refresh while edits are active. Regression covers recovery preservation and backup, along with existing two-device and loading tests. Live extension inspection was blocked by browser URL security policy; actual recovery and authenticated sync require user verification.

## 2026-10-03 - Unify phone and extension account design

The companion used lime accents, an editorial layout and a plain account form that differed from the extension. Matched popup iOS-dark tokens (black, neutral grouped cards, system blue), compact typography, segmented task filters, grouped rows, and touch controls. Both account screens now show a profile hero, account identity, sync status and a return-to-tasks action; backup controls are collapsed. Task storage and authentication logic unchanged. Production TypeScript/Vite build and all 29 regression tests pass.
Published to Firebase Hosting. Visually checked the live task and sign-in screens at desktop and 390px phone width; corrected Windows pipeline encoding in UI labels before final deployment. Signed-in screen not visually verified with a live account; no account data changed.

## 2026-10-03 - Completed rows, shared logo and installed-app controls

Completed task labels used an absolutely positioned strike pseudo-element, which could not follow wrapped text; automatic hyphenation split normal words. Replaced it with a thin native multiline strike and readable completed text in board/popup; disabled automatic hyphenation. Phone header now uses the extension shield asset instead of the unrelated N mark. Install action observes standalone mode, iOS navigator.standalone and appinstalled, remembers accepted installs, and resets the hint if the browser offers installation again. Build passes. Existing task/auth data is untouched.

## 2026-10-03 - Restore local phone tasks after sign-in

The phone app kept guest tasks in localStorage when Google sign-in switched to the account space, but exposed no recovery control afterward. Added a live count of active guest tasks absent from the account and an explicit restore action. It snapshots both record spaces locally before copying only absent task IDs, keeps account records and deletion markers intact, and starts sync after restoration. Recovery is idempotent. Verified the production TypeScript/Vite build. No task content or account credentials are sent into the backup.


## 2026-10-04 - Give popup tasks more room

Seen: The task list showed only a couple of linked tasks and truncated their titles in the narrow popup.
Cause: ui/popup.html capped #todoList at 11rem inside a 22rem-wide body, with a large streak card and generous outer spacing.
Change: Widen the popup to 26rem, raise the task-list cap to 18rem (176px to 288px), and compact the streak icon, ring, typography, card padding and section gaps. Short and empty lists still size to content; the composer stays outside the scrolling list. Task behavior and stored data are unchanged.
Validation: Four existing popup-loading/UI-polish checks pass; git diff --check passes. Rendered a temporary ten-task fixture in headless Edge and inspected the layout at popup width. Real extension storage and interactions were not exercised by the static preview.
Trap: Headless Edge required execution outside the process sandbox. Preview files and browser profile live in the system temporary directory, outside the loaded extension.

## 2026-10-05 - Google sign-in would break on Web Store publish

Seen: Pre-upload verification only. Sign-in works in the unpacked build, and every sync regression passes, because both are pinned to the development extension ID.
Cause: signIn() in src/task-sync.js authenticates with chrome.identity.getRedirectURL(), which returns https://<EXTENSION_ID>.chromiumapp.org/. The ID is derived from the signing key, so a Web Store release gets a different ID than the unpacked folder, and manifest.json declares no `key` to pin it. The OAuth client and Firebase authorized domains hold only the development URI, so the published build would send an unregistered redirect_uri and Google would refuse it. Two things hid this: Google reports a rejected redirect in the callback rather than by throwing, where the old code read only `state`/`id_token` and fell through to the generic "Google sign-in did not complete"; and status() already returned redirectUrl but no page displayed it, so the URI needing registration was never visible.
Change: Config unchanged - this is a registration step, not a code defect, so nothing hardcodes an ID. src/task-sync.js adds redirectHelp() and reports the exact redirect URI to register on both failure paths: launchWebAuthFlow throwing, and an `error` returned in the callback hash or query (now read explicitly). A cancelled sign-in stays a plain cancellation with no setup advice. ui/account.html prints this install's redirect URI inside the collapsed "Backup & account" section, painted by ui/sync-settings.js guarded on the element because tasks.html loads the same script without that line; .sync-redirect code in ui/sync-settings.css wraps the long URI. docs/GOOGLE_SETUP.md documents the ID change with both remedies (register the published URI after a draft upload, or pin the ID with a `key` field) and drops the dead nice-try-tasks.kushal1223.chatgpt.site domain, which the shipped config stopped using when hosting moved to nice-try-3174b.web.app.
Check: Two new regressions, each confirmed to fail when its fix is reverted. task-sync: a redirect_uri_mismatch callback and a throwing flow both surface the URI, no credentials are stored, the account stays guest, cancellation carries no advice, and status() reports redirectUrl. ui-polish: the account page prints the URI and a page lacking the line still paints the sync card. Full suite 61/61 across 12 files. Service worker boots all 8 scripts with no top-level throw; manifest and all 16 JS files parse; build-extension.cjs emits 32 files byte-identical to the Chrome folder.
Trap: No local harness can catch this - getRedirectURL() is correct in every test and in the unpacked build, and only the ID underneath it changes at publish. Do not "fix" it by hardcoding a redirect URI; the ID legitimately differs per install. Guest mode, the wall, coins and tasks never touch this path, so the extension looks entirely healthy while sign-in is broken.

## 2026-10-09 - Milestone day looked like any other day

Seen: On day 30 the streak card read "30 days / Day 30 banked. 30 more to 60." with an empty blue ring labelled "30d". The milestone was reached and the card said nothing about it.
Cause: renderStreak() in ui/popup.js switched the ring to the next milestone as soon as the day was banked. nextMilestone() in src/coins.js is strictly greater than the streak, so on the day a milestone is hit, the target is already the next one (60). prevMilestone(60) is 30, which makes the fill 0%. The "30d" left beside "30 days" reads as the same number twice, and the subline files the milestone under "30 more".
Change: Added a `hit` state for banked days whose streak is in MILESTONES. On that day only, the ring closes fully in green with a star, the card gets a faint green tint, and the subline names the milestone, then the next one ("A month, no gaps. Next stop: 60."; 365 reads "A full year, unbroken."). The names live in MILESTONE_NAMES. The countdown starts again the next day. Risk, paused, cold and post-365 states are unchanged.
Check: Ran renderStreak() under a stubbed DOM with streak/goal pairs 30/60, 31/60, 3/7, 365/0, 400/0, 12/14, plus 30 at risk. Hit days give a star, the hit class and a named line; 31 gives "29d / 29 more to 60"; 400 keeps the maxed tick; the at-risk day keeps "6 min, or 30 days die tonight." Copied to github-publish as LF.
Trap: The bug only appears on 8 days out of 365, and the screen did not look broken. Every element on it was correct by its own rule, so the gap shows only when you ask what the day itself should feel like.

## 2026-10-09 - Milestones now show what the run produced

Seen: The milestone banner said "30 days / Don't be the reason it ends." on every milestone. The milestone-day card line named the milestone but gave no proof. A streak counts days, and ten minutes a night can farm it; nothing showed what the run had actually bought.
Cause: Product gap, not a defect. showCheer() in ui/popup.js had one fixed line for every milestone. The day log (`log[day].productive / sessions / blocks`, written by logTime/logSessionDone/logSaved in src/background.js) was never read for the celebration.
Change: ui/popup.js adds loadRecap(n), which sums productive seconds, finished sessions and walk-aways over the last n days of `log`, and receipt(), which formats them and drops any zero. The banner now reads "30 days. No gaps." / "42h focused · 60 sessions · 90 walk-aways" / a line written for that milestone (MILESTONE_LINES). On a milestone day, when the log covers the whole run, the card line becomes "42h focused in 30 days. Next stop: 60." Otherwise it keeps the milestone's name. The log is kept for 90 days, so a 100+ run's receipt says "Last 90 days:" instead of passing a part off as the whole. The receipt sits in a new #cheerReceipt span (.cheer-r in ui/popup.html).
Check: Stubbed DOM and storage with 30 days of log plus one out-of-range 2020 row. The card line updates from the name to "42h focused in 30 days. Next stop: 60." after the log read, and the 2020 row is excluded. The 30 banner shows all three lines. The 100 banner prefixes "Last 30 days:" and the 100 card line falls back to "Triple digits. Next stop: 200." The loss banner hides the receipt. node --check passes; popup-loading and ui-polish pass 4/4. Copied to github-publish as LF.
Trap: The banner is read-and-clear (claimCelebration in src/coins.js), so a milestone already claimed today will not show it again; the card line carries the receipt for the rest of the day. renderStreak re-renders itself after loadRecap resolves, and the cache keyed on n is what stops that from looping.

## 2026-10-09 - Gemma writes the milestone banner's closing line

Seen: Request. Each milestone had one fixed line, the same for every user, even though the extension already knows each user's stated mission and has an AI key.
Cause: Product gap. Also, Gemini.chat() in src/gemini.js accepted only `gemini-*` IDs, so Gemma models could not be called on a Gemini key.
Change: src/background.js adds milestoneLine() and a `milestoneLine` message. The prompt carries the milestone, the receipt, the mission and the next milestone. With a Gemini key it tries gemma-4-26b-a4b-it, then gemma-4-31b-it, then the judge's aiChat. These are separate models with their own quota, so the wall's judge never pays for a celebration. Other providers go straight through aiChat. cleanMilestoneLine() takes the first line, strips quotes and markdown, and rejects any answer with a digit, over 14 words or 90 characters, an exclamation mark, a hashtag, an emoji, "record"/"personal best", or "break"/"rest"/"deserve". Accepted lines are cached per milestone per day in `milestoneLineCache`. lastAiError is restored afterwards, so a failed celebration never shows as an AI fault in the popup. src/gemini.js now accepts `gemma-*` IDs and sends Gemma no thinkingConfig. ui/popup.js shows the written line first and swaps in the model's line only if one comes back while the same banner is still up.
Check: Ran cleanMilestoneLine() against six model-style answers. A quoted line and a markdown line are cleaned; "42 hours!", "deserve a break" and an emoji line are rejected; a two-line answer keeps the first line. node --check passes on all three files. The full github-publish suite passes, 12 files, gemini.test.js 6/6. Gemma model IDs come from Google's Gemma-on-Gemini-API page (2026-10-09). No live call was made, because the key is only in Chrome's storage.
Trap: The model must never supply a number. The receipt is the only place figures come from, and the digit filter enforces that, not the prompt. The worker change needs an extension reload in chrome://extensions before it takes effect. Reopening the popup is not enough.
