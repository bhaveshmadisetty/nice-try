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
