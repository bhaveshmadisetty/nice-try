// ============================================================
//  Nice Try  ·  background service worker
//  Polls the active tab, classifies it (rules → cache → LLM),
//  tracks attention time, and walls off distraction with a gauntlet.
// ============================================================

// The wall itself lives in wall.js — see the note there on why it is shared.
importScripts("wall.js");
// Coins: credit for keeping this thing armed, and for obeying it.
importScripts("coins.js");

// Set to true while developing to see the [GS] trace in the SW console.
// Keep false for release — some logs include your typed answers.
const DEBUG = false;
function log() { if (DEBUG) console.log.apply(console, arguments); }

const POLL_SECONDS   = 3;     // how often we check the active tab

// ---- AI providers -------------------------------------------------
// Detected from the key prefix. Groq's free tier is far more reliable than
// OpenRouter's, so it's preferred if the user has one.
//   gsk_...     -> Groq
//   sk-or-v1... -> OpenRouter
// NEITHER provider's model list is stable, so both are DISCOVERED at runtime.
// OpenRouter rotates its :free slugs; Groq decommissions models outright, and a
// retired Groq slug answers 400 (not 404), which reads as a broken extension.
// These names are only the fallback order if discovery itself fails.
const GROQ_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant"
];
let discoveredFreeModels = null;   // cached OpenRouter :free list
let lastDiscoveryTs = 0;
let discoveredGroqModels = null;   // cached Groq live list
let lastGroqDiscoveryTs = 0;
let lastAiError = "";              // surfaced in the popup so failures are visible

// The popup asks whether the AI works every single time it opens, and answering
// costs a real API call. On the free tiers this product is built around, that is
// a call not spent classifying a tab — open the popup a few times while adding
// tasks and the next real verdict comes back rate-limited, which surfaces as
// "unsure" and walls a page that was never junk. A key that worked a moment ago
// still works, so the answer is remembered.
//
// Bound to the exact key, so pasting a new one is tested immediately rather than
// inheriting the old verdict. Matching on a prefix instead would let two keys of
// the same length and opening characters share an answer — and the answer worth
// worrying about is "this key is broken", which would then greet a key that is
// perfectly fine. The key is already held in storage, so keeping it here costs
// no exposure that didn't exist a line earlier.
const AI_STATUS_TTL = 5 * 60 * 1000;
let aiStatus = { at: 0, forKey: "", resp: null };
function cachedAiStatus(key) {
  if (!aiStatus.resp) return null;
  if (aiStatus.forKey !== String(key || "")) return null;
  if ((Date.now() - aiStatus.at) >= AI_STATUS_TTL) return null;
  return aiStatus.resp;
}
function rememberAiStatus(key, resp) {
  aiStatus = { at: Date.now(), forKey: String(key || ""), resp };
}

function providerOf(key) {
  const k = (key || "").trim();
  if (k.startsWith("gsk_")) return "groq";
  if (k.startsWith("sk-or-")) return "openrouter";
  return k ? "openrouter" : "";    // default guess
}
const GRACE_SECONDS  = 30;    // 30s in junk before we lock
const RENUDGE_SECONDS = 30;   // re-assert lock every 30s if dismissed
// How long before the wall the warning panel appears. Carved OUT of the grace
// period, not added to it: the wall still lands at GRACE_SECONDS exactly as it
// did, so nothing about when you get blocked has moved — you just stop being
// ambushed by it.
//
// Eighteen, not ten. Ten was sized for the panel's first job, which was only
// "finish your sentence". The panel now asks a question and takes a typed
// answer, and ten seconds is not enough to read a prompt, decide what you were
// actually doing, and write it — the countdown hit zero mid-sentence. The panel
// does outlive the count when there is text in the box, but a timer that is
// visibly too short to comply with reads as a taunt rather than an offer.
//
// It is still well under the grace period, so this is not a browsing window:
// the first 12 seconds on a junk page remain silent, and the wall lands at 30
// regardless of what is typed.
const HEADSUP_SECONDS = 18;
// The floor. However late the panel ends up opening, it never offers less than
// this — and when it would, the wall is pushed out to match so the number on
// screen stays true. Fifteen is the minimum that is actually usable: read the
// question, decide what you were doing, type a sentence, press the button.
const HEADSUP_MIN_SECONDS = 15;
// Typing in the countdown panel holds the wall back. Fifteen seconds is enough
// to answer briskly and not enough to write a real sentence about what you are
// actually doing — so the clock used to expire mid-word and the wall landed on
// someone in the middle of complying with it. The people it interrupted worst
// were the ones writing the most useful notes, which is precisely backwards.
//
// Two numbers bound it. IDLE is how far each keystroke pushes the wall out: a
// rolling window, so a tab abandoned with a half-typed word starts counting
// again within seconds rather than holding the block off indefinitely. MAX is
// the total a single panel may ever hold, enforced on BOTH sides — the panel
// stops asking once it is spent, and this is the ceiling applied to whatever
// the message claims, because that message comes from an injected script on an
// arbitrary page and must not be trusted with the wall's own deadline.
// 6s, not 4: the panel re-sends at most every 1.5s and releases its own hold
// after 2.5s of quiet, so the worst case is a send 1.5s BEFORE the last
// keystroke and a panel that stays held 2.5s after it. At 4000 those two
// landed on the same millisecond — a dead heat in which the wall could arrive
// while the ring still read "paused". The extra 2s is pure margin for timer
// jitter and a busy worker; it only ever delays the wall, never skips it.
const HEADSUP_HOLD_IDLE_MS = 6000;
const HEADSUP_HOLD_MAX_MS = 45000;
// How long a strict (focus-session) wall stays up before it closes the tab
// itself. Long enough to read the session clock and register why the page went
// away; short enough that it is not a screen anyone sits in front of.
//
// Only the strict wall self-closes. An ordinary wall has a gauntlet to answer,
// and taking the tab away mid-question would destroy the one route past it.
const SESSION_WALL_AUTO_CLOSE_SECONDS = 15;
const AI_AFTER_SECONDS = 20;  // sit on a tab this long before we spend an AI call
const IDLE_AFTER_SECONDS = 60; // no keyboard/mouse this long = you've walked away

// ---- host access ---------------------------------------------------
// Host permission is OPTIONAL, not granted at install. "Read and change all
// your data on all websites" is the scariest string the Web Store shows, and
// on an unknown productivity tool it is where most people stop reading and
// close the tab. Asked for during setup instead, with a screen that says what
// it buys — the same permission, requested at the moment it makes sense.
//
// Everything that touches a page is gated on this. The answer is cached
// because it is read on every tick, and invalidated by the permission events
// so a revoke mid-session takes effect on the next poll rather than at restart.
let hostAccess = null;           // null = not yet checked
async function hasHostAccess() {
  if (hostAccess !== null) return hostAccess;
  try {
    hostAccess = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  } catch (e) {
    hostAccess = false;
  }
  return hostAccess;
}
try {
  chrome.permissions.onAdded.addListener(() => { hostAccess = null; tick(); });
  chrome.permissions.onRemoved.addListener(() => { hostAccess = null; });
} catch (e) {}

// verdict cache: title -> "productive"|"junk" (so we call the AI once per title)
const verdictCache = new Map();
let cacheLoaded = false;

async function loadCache() {
  if (cacheLoaded) return;
  const d = await chrome.storage.local.get("verdictCache");
  if (d.verdictCache) {
    for (const k in d.verdictCache) verdictCache.set(k, d.verdictCache[k]);
  }
  cacheLoaded = true;
}
const VERDICT_CACHE_CAP = 500;

// Remember a verdict, most-recent last.
//
// Map iterates in insertion order and set() on an existing key does NOT move
// it, so the cap below has to be paired with a delete-then-set or the order is
// meaningless. Going through here rather than calling verdictCache.set directly
// is what makes the eviction below actually evict the least recently written.
// Scores for cached verdicts, same keys as verdictCache and trimmed with it.
//
// Deliberately NOT folded into verdictCache's values: that map is persisted
// as plain strings and compared with === "junk" in several places, so giving
// it object values would need every one of those sites and the stored format
// changed at once. A parallel map costs one delete in the trim loop below and
// leaves the verdict path exactly as it was — and a missing score here is
// already a defined state (-1), so the two maps falling out of step degrades
// to "no score", never to a wrong one.
const verdictScores = new Map();

function rememberVerdict(key, verdict, score) {
  if (verdictCache.has(key)) verdictCache.delete(key);
  verdictCache.set(key, verdict);
  if (typeof score === "number" && score >= 0) verdictScores.set(key, score);
  // Trim the in-memory map too. It used to grow without limit — only the
  // persisted copy was capped — so a long-lived worker held every verdict it
  // had ever seen.
  while (verdictCache.size > VERDICT_CACHE_CAP) {
    const oldest = verdictCache.keys().next().value;
    verdictCache.delete(oldest);
    verdictScores.delete(oldest);
  }
}

function persistCache() {
  // Cap at 500 entries so storage doesn't grow forever.
  //
  // This used to keep the FIRST 500 of an insertion-ordered map — that is, the
  // OLDEST — and silently drop everything after. Past the cap every new verdict
  // was written to memory and then thrown away on persist, so each worker
  // restart re-judged every recent page and spent free-tier calls doing it.
  // Keep the newest instead.
  const obj = {};
  const all = Array.from(verdictCache);
  for (const [k, v] of all.slice(-VERDICT_CACHE_CAP)) obj[k] = v;
  chrome.storage.local.set({ verdictCache: obj });
}

// ---- hardcoded classification ------------------------------------
// Distinctive title keywords that are ALWAYS productive (no AI needed).
// Kept specific to avoid substring collisions (no bare "prime"/"docs"/"resolve").
const ALWAYS_PRODUCTIVE = [
  "leetcode", "geeksforgeeks", "hackerrank", "codeforces", "codechef",
  "stack overflow", "visual studio code",
  "jupyter", "google colab", "kaggle", "replit", "codesandbox",
  "premiere pro", "davinci resolve", "after effects",
  "documentation", "w3schools", "coursera", "udemy"
];

// Title keywords that are ALWAYS junk (no free pass). Checked BEFORE productive
// so "Prime Video" hits here, not the (removed) "prime" productive keyword.
const ALWAYS_JUNK = [
  "instagram", "twitter", "facebook",
  "netflix", "prime video", "hotstar", "9gag",
  "tiktok", "snapchat", "hulu", "disney+",
  // unambiguous music/entertainment phrases — never system-design content,
  // so block instantly (no 20s AI wait). Distinctive multi-word to avoid
  // false hits (e.g. "audio song", not bare "audio").
  "audio song", "full song", "lyrical video", "lyric video", "| lyrics",
  "official music video", "full video song", "video song", "jukebox",
  "full movie", "movie explained", "trailer |", "official trailer"
];

// Ambiguous — needs relevance judgment against to-dos (mainly YouTube)
const AMBIGUOUS = ["youtube", "- youtube"];

// Words that mean the title is ABOUT its subject rather than being it. A
// tutorial that builds a Netflix clone, a system-design breakdown of Instagram,
// an API walkthrough for Spotify — all of these name a product on the junk list
// while being exactly the work the tool is supposed to protect.
//
// These only ever downgrade a junk keyword hit to "ask the judge". They never
// pass a title on their own, because that would make "netflix tutorial" a
// universal password — which is precisely the kind of loophole a blocker gets
// uninstalled for having.
const STUDY_WORDS = [
  "tutorial", "system design", "clone", "how to build", "build a", "building a",
  "walkthrough", "case study", "architecture", "explained", "course",
  "documentation", "api", "sdk", "interview question", "lecture",
  "crash course", "from scratch", "step by step"
];
// Word-boundary matched, not a bare substring.
//
// includes() made several of these fire on unrelated words — "api" matched
// "rapid", "capital" and "therapist"; "course" matched "of course"; "clone"
// matched "cyclone". Each false hit downgraded a confirmed junk title to "ask
// the judge", which costs a real AI call and, with no key configured, drops the
// title through to neutral — an accidental pass on exactly the content the
// junk list had already caught.
const STUDY_RE = new RegExp(
  "(^|[^a-z0-9])(" +
  STUDY_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
  ")([^a-z0-9]|$)", "i");
function looksLikeStudyOf(t) {
  return STUDY_RE.test(t);
}

// ---- state -------------------------------------------------------
let lastTabId = null;
let lastTitle = "";
let junkStreak = 0;        // seconds continuously in junk
let lastNudgeAt = 0;       // junkStreak value at last nudge
let headsUpAt = 0;         // junkStreak value when the warning strip was shown
// Wall-clock deadline the wall must not fire before, set when the panel opened
// on less than HEADSUP_MIN_SECONDS and promised more. In memory only, and
// deliberately so: it is at most a few seconds long, and a stale deadline
// rehydrated by a restarted worker would hold a wall back for a page whose
// countdown ended long ago.
let wallDeferUntil = 0;
// When typing first held the wall back on this streak. The worker's own budget
// clock for holdWall — see that handler. In memory with wallDeferUntil and
// cleared with the streak, so one approach to one wall gets one budget.
let holdWindowStart = 0;
let lastTickTs = 0;        // wall-clock ms of the previous accounted tick
let ticking = false;       // in-flight guard so concurrent ticks don't race
let dwellSeconds = 0;      // seconds of REAL presence on the current title

// The streak has to outlive the worker, for the same reason the pause does.
// MV3 tears the worker down after ~30s idle, and a setTimeout does not hold it
// open — only the 1-minute keepAlive alarm brings it back. Sitting still on a
// video fires no tab event at all (onUpdated is filtered to title/complete, so
// an {audible:true} update does not wake us), so the worker dies with the
// streak at ~29s and it came back as 0. GRACE_SECONDS is 30, which means the
// wall could never fire on the one behaviour it exists to interrupt.
//
// storage.session, not local: this is per-browser-session state exactly like
// lockedTabs, and a streak surviving a browser restart would wall you for a
// video you closed yesterday.
let streakLoaded = false;
async function loadStreak() {
  if (streakLoaded) return;
  streakLoaded = true;
  try {
    const d = await chrome.storage.session.get("streak");
    const s = d.streak;
    if (s && typeof s === "object") {
      // Number(undefined) is NaN and NaN||0 is 0, so a missing or corrupt field
      // degrades to "no streak" rather than poisoning the arithmetic — a NaN
      // junkStreak would make every >= comparison false and silently disable
      // the wall for the life of the worker.
      junkStreak   = Number(s.junkStreak) || 0;
      lastNudgeAt  = Number(s.lastNudgeAt) || 0;
      headsUpAt    = Number(s.headsUpAt) || 0;
      dwellSeconds = Number(s.dwellSeconds) || 0;
      lastTitle    = typeof s.lastTitle === "string" ? s.lastTitle : "";
      // A negative or absurd stored value can only come from corruption; clamp
      // rather than trust it.
      if (junkStreak < 0) junkStreak = 0;
      if (lastNudgeAt < 0) lastNudgeAt = 0;
      if (headsUpAt < 0) headsUpAt = 0;
      if (dwellSeconds < 0) dwellSeconds = 0;
    }
  } catch (e) {}
}
// Written on every tick that changes it. Fire-and-forget: a failed write costs
// one tick of accuracy, never a thrown tick.
function persistStreak() {
  try {
    chrome.storage.session.set({
      streak: { junkStreak, lastNudgeAt, headsUpAt, dwellSeconds, lastTitle }
    });
  } catch (e) {}
}
// Every place that clears the streak must clear the persisted copy too, or the
// next worker rehydrates the streak the user just paid to escape.
//
// This writes the two counters it owns and MERGES them over whatever is stored,
// rather than persisting the whole record. Several callers (the pause and
// schedule stand-downs) run before loadStreak() has hydrated this worker, so
// writing the full record here would push an unhydrated dwellSeconds/lastTitle
// of 0/"" over a perfectly good stored value — clearing dwell as a side effect
// of pausing, which is not what any caller asked for.
function resetStreak() {
  // wallDeferUntil goes with them: it only ever holds back the wall this streak
  // was heading toward, so a streak that no longer exists must not keep a
  // deadline alive for the next one.
  // holdWindowStart goes too: the typing budget belongs to one approach at one
  // wall, so a streak that ended (you left the page, or answered) must hand the
  // next one a full budget rather than the remains of this one.
  junkStreak = 0; lastNudgeAt = 0; headsUpAt = 0; wallDeferUntil = 0;
  holdWindowStart = 0;
  try {
    chrome.storage.session.get("streak").then((d) => {
      const s = (d && d.streak && typeof d.streak === "object") ? d.streak : {};
      chrome.storage.session.set({
        streak: {
          junkStreak: 0,
          lastNudgeAt: 0,
          // Cleared with the streak it belongs to. Left set, the next approach
          // to a wall would be silent — the strip would think it had already
          // warned you about a block that hadn't happened yet.
          headsUpAt: 0,
          dwellSeconds: streakLoaded ? dwellSeconds : (Number(s.dwellSeconds) || 0),
          lastTitle: streakLoaded ? lastTitle : (typeof s.lastTitle === "string" ? s.lastTitle : "")
        }
      });
    }).catch(() => {});
  } catch (e) {}
}

// ---- reprieve: the page you were mid-way through ---------------------
// Answering the countdown panel calls off THIS wall, on THIS page, and holds
// until you navigate away from it.
//
// This is the one route past the wall that does not involve the wall, and it
// exists for a failure the gauntlet cannot fix: a block that lands on a page
// holding real progress destroys the progress. The wall keeps the tab open when
// it can see typed text in a field, but that only catches drafts — it cannot
// see a lecture you are 40 minutes into, a form mid-submit, or an editor whose
// state lives in memory. By the time the wall is up it is already too late to
// ask, so the asking moved to the countdown, before anything is covered.
//
// The obvious objection is that a text box which cancels the block is a
// password. Four things keep it from becoming one:
//
//   1. It is scoped to ONE page identity, not the host. Answering for one video
//      does nothing for the next one — the countdown returns immediately, which
//      is correct, because that next video is a new distraction.
//   2. It ends when you leave the page. It is not a timed pass you can bank and
//      spend elsewhere; it protects the thing you were doing and nothing else.
//   3. It costs a task. The answer is written to today's list, so claiming one
//      means committing in writing to what you were supposedly doing, and the
//      list is the thing the wall reads back to you next time.
//   4. It is per browser session, never persisted to disk. Reopening the browser
//      does not restore yesterday's reprieves.
//
// Session storage, like lockedTabs and the junk streak: a reprieve surviving a
// browser restart would exempt a page you have long since walked away from.
const reprieved = new Map();     // page identity -> { at, text }
let reprievesLoaded = false;
const REPRIEVE_CAP = 60;

async function loadReprieves() {
  if (reprievesLoaded) return;
  reprievesLoaded = true;
  try {
    const d = await chrome.storage.session.get("reprieved");
    const saved = (d && d.reprieved) || {};
    for (const k in saved) reprieved.set(k, saved[k]);
  } catch (e) {}
}
function persistReprieves() {
  const out = {};
  reprieved.forEach((v, k) => { out[k] = v; });
  try { chrome.storage.session.set({ reprieved: out }); } catch (e) {}
}
// opts.kind: "" (a task-backed reprieve, until you leave) or "once" (a bought
// pass, counted as wasted); opts.until: a deadline in ms for the "once" kind.
function grantReprieve(id, text, opts) {
  if (!id) return;
  if (reprieved.has(id)) reprieved.delete(id);   // keep insertion order honest
  const rec = { at: Date.now(), text: String(text || "").slice(0, 200) };
  if (opts && opts.kind) rec.kind = String(opts.kind);
  if (opts && opts.until) rec.until = Number(opts.until) || 0;
  reprieved.set(id, rec);
  // Bounded like every other cache here. The oldest goes first; a reprieve is
  // only ever relevant while you are still on the page it covers.
  while (reprieved.size > REPRIEVE_CAP) {
    reprieved.delete(reprieved.keys().next().value);
  }
  persistReprieves();
}

// Passing the gauntlet buys a global pause, not access to one site. For the
// duration the extension stands down entirely: nothing is classified, no time
// is attributed, no wall can fire. Scoping it to a host meant justifying one
// video then being blocked on the next thing you opened, which is the tool
// arguing with a decision it had already accepted.
const GRANT_MS = 3 * 60 * 1000;   // 3 minutes off per successful gauntlet
let pausedUntil = 0;
// How the current pause came about: "free" (the popup's own row, or the
// off-switch sheet), "bought" (coins), "grant" (talked past a wall). Three
// stand-downs that look identical from the outside and are not the same
// thing at all — a bought hour cost something, a free one is a hole in the
// economy. Carried with the deadline so every surface can say which it is.
let pauseKind = "";
function isPaused() { return Date.now() < pausedUntil; }
function pauseLeftMs() { return Math.max(0, pausedUntil - Date.now()); }

// The pause has to outlive the worker. MV3 suspends it after ~30s idle, and a
// deadline held only in memory vanished with it — you'd earn three minutes and
// be walled again in one, which reads as the tool cheating you.
let pauseLoaded = false;
async function loadPause() {
  if (pauseLoaded) return;
  pauseLoaded = true;
  try {
    const d = await chrome.storage.local.get(["pausedUntil", "pauseKind"]);
    if (typeof d.pausedUntil === "number") pausedUntil = d.pausedUntil;
    if (typeof d.pauseKind === "string") pauseKind = d.pauseKind;
  } catch (e) {}
}
function persistPause() { chrome.storage.local.set({ pausedUntil, pauseKind }); }

// ---- downtime -----------------------------------------------------
// Every stretch the tool was stood down, as episodes: { from, to, kind,
// closed }. kind is "off" (the switch), "free", "bought" or "grant". This is
// the record behind "how long was it off today" — which the tool could not
// answer before, because the tick returned early the moment it stopped and
// the only trace was a planned length that nothing checked against reality.
//
// Wall clock, not ticks, so the number is exact. An OPEN episode is kept
// alive by a heartbeat from the tick: if the heartbeat stops (Chrome closed
// overnight with the switch off) the episode counts only up to its last
// beat. "Off while Chrome was open" is the honest measure — the tool cannot
// be stood down from a browser that is not running.
const DOWN_CAP = 600;
const DOWN_KEEP_MS = 60 * 86400000;
const DOWN_STALE_MS = 5 * 60 * 1000;
const DOWN_BEAT_MS = 30 * 1000;
let downBeatAt = 0;

async function readDown() {
  const d = await chrome.storage.local.get("downtime");
  return Array.isArray(d.downtime) ? d.downtime : [];
}
async function writeDown(rows) {
  const cut = Date.now() - DOWN_KEEP_MS;
  await chrome.storage.local.set({
    downtime: rows.filter(r => r && (r.to || r.from) >= cut).slice(-DOWN_CAP)
  });
}
// Close an episode. It closes at now, or at the last heartbeat if that is
// stale: a stand-down that outlived Chrome counts only for as long as Chrome
// was there to be stood down in. With `cap` (a pause's own deadline) it is
// ALSO clipped to the deadline, so a pause that expired while the worker was
// asleep ends when it actually ended rather than when the worker noticed.
//
// The cap used to override the staleness rule ("a bought hour is an hour
// bought, whether or not the worker was awake to watch it"). That made the
// two paths disagree: a pause Chrome was closed through counted in full if it
// expired before Chrome came back, and counted only its live stretch if Chrome
// came back mid-pause. Same hour, two numbers. One rule now — "off while
// Chrome was open" — however the episode ends.
function closeDownRow(r, now, cap) {
  let to = (now - r.to > DOWN_STALE_MS) ? r.to : now;
  if (cap) to = Math.min(to, cap);
  r.to = Math.max(r.from, to);
  r.closed = true;
}
async function openDown(kind) {
  const rows = await readDown();
  const now = Date.now();
  const open = rows.find(r => r && !r.closed);
  if (open) {
    if (open.kind === kind) return;        // already running — a restart, not a new episode
    closeDownRow(open, now);
  }
  rows.push({ from: now, to: now, kind, closed: false });
  downBeatAt = now;
  await writeDown(rows);
}
async function closeDown(cap) {
  const rows = await readDown();
  const open = rows.find(r => r && !r.closed);
  if (!open) return;
  closeDownRow(open, Date.now(), cap);
  await writeDown(rows);
}
// Called from the tick while stood down. Throttled: one small write every 30s
// is the cost of a number that survives the worker being killed.
//
// `kind` is what the tick believes is standing the tool down right now. If no
// episode is open, one is started with it — the tick is the one place that
// knows the tool is currently stood down, so an episode missing here is a
// record that has fallen behind reality, not a sign that nothing is happening.
// This is how a pause survives the switch: turning the tool off mid-pause
// closes the pause's episode and opens an "off" one; turning it back on closes
// that; the pause itself is still running, and without this the rest of it
// was never written down at all.
async function beatDown(kind) {
  const now = Date.now();
  if (now - downBeatAt < DOWN_BEAT_MS) return;
  downBeatAt = now;
  const rows = await readDown();
  const open = rows.find(r => r && !r.closed);
  if (!open) {
    if (!kind) return;
    rows.push({ from: now, to: now, kind, closed: false });
    await writeDown(rows);
    return;
  }
  if (now - open.to > DOWN_STALE_MS) {
    // The worker (or Chrome) was gone for a while. Close the old stretch at
    // its last beat and start a fresh one, rather than claiming the gap.
    closeDownRow(open, now);
    rows.push({ from: now, to: now, kind: open.kind, closed: false });
  } else {
    open.to = now;
  }
  await writeDown(rows);
  await warnOverBudget(rows, now);
}

// One day's downtime, clipped to that day, split by kind. `pauses` counts
// the free and bought pauses STARTED that day — the number the price climbs
// on — and `frees` how many of those were free.
function downSummary(rows, dayKeyStr, now) {
  const [y, m, d] = String(dayKeyStr).split("-").map(Number);
  const start = new Date(y, (m || 1) - 1, d || 1).getTime();
  const end = start + 86400000;
  const out = { off: 0, free: 0, bought: 0, grant: 0, total: 0, pauses: 0, frees: 0 };
  for (const r of rows) {
    if (!r || !r.from) continue;
    const to = r.closed ? r.to : ((now - r.to > DOWN_STALE_MS) ? r.to : now);
    const a = Math.max(r.from, start), b = Math.min(to, end);
    if (b > a) {
      const s = (b - a) / 1000;
      out[r.kind] = (out[r.kind] || 0) + s;
      out.total += s;
    }
    if (r.from >= start && r.from < end) {
      if (r.kind === "free" || r.kind === "bought") out.pauses++;
      if (r.kind === "free") out.frees++;
    }
  }
  return out;
}
// The pricing context for right now: how many pauses today, and whether the
// budget is spent. Read fresh on every purchase — the popup shows a price,
// the worker decides it.
async function pauseCtx() {
  const rows = await readDown();
  const today = downSummary(rows, todayKey(), Date.now());
  const overBudget = today.total >= DOWN_BUDGET_MIN * 60;
  const ctx = { pausesToday: today.pauses, freesToday: today.frees, overBudget };
  ctx.mult = pauseMultiplier(ctx);
  return ctx;
}
// One notification, the moment the day's budget is spent. This is the only
// part of the mechanism that can reach someone while the tool is OFF — the
// popup and its bar are only seen by someone who opens them, and the person
// who has had it off for an hour is exactly the person who hasn't.
async function warnOverBudget(rows, now) {
  const day = todayKey();
  const today = downSummary(rows, day, now);
  if (today.total < DOWN_BUDGET_MIN * 60) return;
  const d = await chrome.storage.local.get("downWarnDay");
  if (d.downWarnDay === day) return;
  await chrome.storage.local.set({ downWarnDay: day });
  try {
    chrome.notifications.create("focus_down_" + day, {
      type: "basic",
      iconUrl: "assets/icon128.png",
      title: "An hour off today",
      message: "Nice Try has been off or paused for " + DOWN_BUDGET_MIN +
               " minutes today. From here every pause costs double.",
      priority: 1
    });
  } catch (e) {}
}

// ---- focus session ------------------------------------------------
// A pre-commitment. You name the task, start the clock, and for that window the
// wall has no negotiation in it: no questions, no typing test, no appeal — the
// only ways out are finishing the session or abandoning it, and abandoning is
// deliberately a single visible act rather than something you can talk your way
// into one page at a time.
//
// This exists because every other route through the wall is negotiable, which
// means the tool's teeth are opt-in at the exact moment willpower is lowest.
// The negotiation is the right default; a mode where you can switch it off in
// advance, when you are thinking clearly, is what makes it useful under load.
//
// Held in storage like the pause, for the same reason: an MV3 worker dies and a
// session held only in memory would quietly end with it.
let session = null;   // { until, task, startedAt } or null
let sessionLoaded = false;

async function loadSession() {
  if (sessionLoaded) return;
  sessionLoaded = true;
  try {
    const d = await chrome.storage.local.get("session");
    if (d.session && typeof d.session.until === "number") session = d.session;
  } catch (e) {}
}
function persistSession() {
  try {
    if (session) chrome.storage.local.set({ session });
    else chrome.storage.local.remove("session");
  } catch (e) {}
}
function sessionActive() { return !!(session && Date.now() < session.until); }
function sessionLeftMs() { return session ? Math.max(0, session.until - Date.now()) : 0; }

// Ends a finished session and banks it. Called from the tick rather than a
// timer, so it survives the worker being suspended across the end time.
async function reapSession() {
  if (!session || Date.now() < session.until) return;
  const done = session;
  session = null;
  persistSession();
  await logSessionDone(done);
  try {
    chrome.notifications.create("focus_done_" + Date.now(), {
      type: "basic", iconUrl: "assets/icon128.png",
      title: "Session complete",
      message: done.task
        ? "You finished " + Math.round((done.until - done.startedAt) / 60000) +
          " minutes on: " + done.task
        : "Focus session finished.",
      priority: 1
    });
  } catch (e) {}
}

// ---- access log ---------------------------------------------------
// Every time you talk your way past the wall, it's recorded here — which host,
// which title, and crucially HOW you got in: "answers" (the AI accepted your
// reason), "typing" (you forced it), or "appeal" (you said the verdict was
// wrong). The grant itself is ephemeral, but the record is not: this is the
// audit trail for deciding later that a site you argued your way into should
// never have been let through.
//
// Entries are keyed by host so the page can show one row per site with a count,
// and each carries the titles that got through and the cache keys they wrote,
// so revoking can actually undo the memory rather than just hiding the row.
const ACCESS_LOG_CAP = 300;

// ---- task links: exempt ONE page, never the site ------------------
// A link pasted into a to-do exempts that page and nothing else. Exempting the
// host would hand over the whole site — one DSA video would stop youtube.com
// being scanned at all, which is the opposite of the point.
//
// Matching can't be a string compare: sites append their own params (&t= on a
// YouTube seek, &list= from a playlist, utm_* from anywhere), so an exact match
// would break mid-video. Instead each URL reduces to a stable identity.
function linkIdentity(url) {
  let u;
  try { u = new URL(url); } catch (e) { return ""; }
  // web pages only — chrome:, about: and file: have no meaningful identity here
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  // YouTube is the case that matters: every video shares the /watch path, so
  // the video id is the only thing that identifies the page.
  if (host === "youtube.com" && u.pathname === "/watch") {
    const v = u.searchParams.get("v");
    if (v) return "youtube.com/watch?v=" + v;
  }
  if (host === "youtu.be") {
    const id = u.pathname.replace(/^\//, "");
    if (id) return "youtube.com/watch?v=" + id;
  }
  if (host === "youtube.com" && u.pathname.startsWith("/shorts/")) {
    return "youtube.com" + u.pathname.replace(/\/$/, "");
  }
  // Everything else: host + path, and a query param ONLY where that host is
  // known to route by one.
  //
  // The tempting fix — keep every param that isn't a known tracking tag — is
  // wrong, and wrong in the direction that breaks working exemptions. Sites
  // append their own navigation state constantly (LeetCode's ?envType=daily,
  // a docs site's ?theme=), so a keep-by-default rule means the identity
  // changes under you the moment you click anything, and the wall returns
  // mid-task. Stripping by default is the behaviour that already worked for
  // the common case; the per-host list below is the narrow exception for apps
  // whose page id genuinely lives in the query, where stripping collapsed
  // every page on the host into one identity.
  const path = u.pathname.replace(/\/+$/, "") || "/";
  const idParam = ID_PARAM_HOSTS[host];
  if (idParam) {
    for (const k of idParam) {
      const v = u.searchParams.get(k);
      if (v) return host + path + "?" + k + "=" + v;
    }
  }
  return host + path;
}

// Hosts that identify a page by query param rather than by path. Without an
// entry here every page on the host reduces to the same identity, so pasting
// one page would exempt all of them — the site-wide grant this whole function
// exists to prevent. Keyed by the same normalized host used above (no www/m).
// First matching param wins, so the more specific one is listed first.
const ID_PARAM_HOSTS = {
  "notion.so":            ["p", "id"],
  "docs.google.com":      ["id"],
  "drive.google.com":     ["id"],
  "mail.google.com":      ["compose"],
  "github.com":           ["q"],
  "stackoverflow.com":    ["q"],
  "chatgpt.com":          ["model"],
  "kaggle.com":           ["competitionId"],
  "coursera.org":         ["specialization"],
};

// One-time cleanup. An earlier build put the HOST of a task link straight onto
// the always-allowed list, which handed over the whole site — the bug this
// per-page matching replaces. Those entries are still sitting in storage
// granting site-wide access, so drop any that came from a to-do link and were
// not typed into the settings page.
async function pruneTaskHostAllows() {
  const d = await chrome.storage.local.get(["allowDomains", "todos", "taskHostsPruned"]);
  if (d.taskHostsPruned) return;
  const todos = Array.isArray(d.todos) ? d.todos : [];
  const fromLinks = new Set();
  for (const t of todos) {
    if (t && typeof t === "object" && t.host) fromLinks.add(t.host);
  }
  const allow = (d.allowDomains || []).filter(dm => !fromLinks.has(dm));
  await chrome.storage.local.set({ allowDomains: allow, taskHostsPruned: true });
  if (fromLinks.size) log("[GS] pruned task-link hosts from allow-list");
}

// Identities of every link currently attached to a to-do. Derived on each
// check rather than cached, so adding or removing a task takes effect at once.
//
// Only tasks that are live today can exempt a page. A task dated next week is
// not doing any work for you now, so its link stays behind the wall until the
// day it belongs to — otherwise "plan a YouTube video for Saturday" would open
// YouTube on Monday.
//
// The popup states this rule back to the user on each task's link line ("opens
// on saturday", "done, so it's walled again"). That label is derived from the
// SAME two conditions as the filter below — if this line changes, renderTodos
// in ui/popup.js has to change with it, or the popup will promise access the
// worker won't grant.
// Where a newly written task sits in the manual priority order: past whatever
// is already on that day, so it lands at the bottom. Kept in step with the
// nextRank() in popup.js and tasks.js -- same rule, same gap, three writers of
// one list.
function nextTaskRank(list, key) {
  const GAP = 1024;
  let max = 0;
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const on = t.done ? (t.doneDate || t.date) : t.date;
    if (on === key && typeof t.rank === "number" && isFinite(t.rank) && t.rank > max) {
      max = t.rank;
    }
  }
  return max + GAP;
}

async function taskLinkIdentities() {
  const d = await chrome.storage.local.get("todos");
  const list = Array.isArray(d.todos) ? d.todos : [];
  const today = todayKey();
  const out = [];
  for (const t of list) {
    if (t && typeof t === "object" && t.url && !t.done && (!t.date || t.date <= today)) {
      const id = linkIdentity(t.url);
      if (id) out.push(id);
    }
  }
  return out;
}

// `via` is "answers" (AI approved), "typing" (forced through the test), or
// "appeal" (the verdict was wrong and the user said so). They are kept apart
// because they mean opposite things: the first two are you getting past a
// correct block, the third is the block itself having been a mistake.
async function recordAccess(host, title, via, cacheKey, reason) {
  if (!host) return;
  const d = await chrome.storage.local.get("accessLog");
  const logArr = Array.isArray(d.accessLog) ? d.accessLog : [];
  const row = {
    host,
    title: normalizeTitle(title || ""),
    via,
    at: Date.now(),
    // typing-test entries write no cached verdict, so they carry no key
    cacheKey: cacheKey || ""
  };
  if (reason) row.reason = String(reason).slice(0, 300);
  logArr.unshift(row);
  await chrome.storage.local.set({ accessLog: logArr.slice(0, ACCESS_LOG_CAP) });
}

// What the user has already said about this host, from the same audit trail.
//   claimsToday    once-passes bought today, anywhere — prices the next one
//   hostOverrides  times in the last week a verdict on THIS host was overruled
//                  (a task written at its wall, a once-pass, an appeal)
// Read at wall time, not cached: it is one storage hit on a path that runs
// once per wall, and a stale count would price the wrong door.
async function overridesFor(host) {
  const d = await chrome.storage.local.get("accessLog");
  const rows = Array.isArray(d.accessLog) ? d.accessLog : [];
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const weekAgo = Date.now() - 7 * 86400000;
  let claimsToday = 0, hostOverrides = 0;
  for (const r of rows) {
    if (!r) continue;
    if (r.via === "once" && r.at >= dayStart.getTime()) claimsToday++;
    if (host && r.host === host && r.at >= weekAgo &&
        (r.via === "task" || r.via === "once" || r.via === "appeal")) hostOverrides++;
  }
  return { claimsToday, hostOverrides };
}

// A task was written (or attached) at the two-door wall. Three things follow,
// all worker-side and all from the SENDER's real tab, never the message:
//
//   1. The title is remembered as work, under the same key the classifier
//      reads — so the next visit to this lesson is not walled again. The key
//      carries today's task list, so the memory lasts exactly as long as the
//      list it was made under: tick the task off and the page is judged
//      afresh. That is the override teaching the classifier, bounded by the
//      thing the user can see.
//   2. It is written to the audit trail as "task", with the task text as the
//      reason, so "What got past the wall" lists it and can revoke it.
//   3. The tab's lock mark goes, so a reload is not re-covered at
//      document_start for a wall that has been answered.
async function wallOverride(sender, text) {
  const tid = sender && sender.tab && sender.tab.id;
  const host = hostOf(sender && sender.url ? sender.url : "");
  if (!host) return;
  let realTitle = "";
  if (tid != null) {
    try { realTitle = (await chrome.tabs.get(tid)).title || ""; } catch (e) {}
  }
  let key = "";
  const t = normalizeTitle(realTitle).toLowerCase();
  if (t) {
    await loadCache();
    key = await cacheKeyFor(t);
    rememberVerdict(key, "productive");
    persistCache();
  }
  await recordAccess(host, realTitle, "task", key, text);
  await locksReady;
  if (tid != null && lockedTabs.delete(tid)) persistLocks();
  log("[GS] 🚪 task door: \"" + t + "\" on " + host);
}

// How sure the tool is that this page is a distraction — and therefore which
// wall it gets. Not a number: a number would have to be invented, and every
// signal here is a fact the classifier already had and threw away.
//
//   "hard"    the questionnaire, as before. Reserved for verdicts nothing
//             argued with: the user's own block-list, a hard junk domain, an
//             unambiguous junk title. These earned their certainty.
//   "medium"  the two-door wall. The judge decided, and it had a task list
//             to decide against — so it had something to go on, and
//             overriding it costs more than overriding a guess.
//   "low"     the two-door wall at its cheapest. The judge decided with
//             nothing to go on but the mission (an empty list makes RULE 1
//             impossible), or the page is on a course platform, or the user
//             has already overruled this host in the last week, or the AI was
//             unreachable and the verdict is "unsure". None of these is a
//             reason to interrogate anyone.
//
// A judge verdict can never be "hard". A text gate on an uncertain call is
// where people learn to lie to the box, and the questionnaire's whole value
// depends on the verdict behind it being one they cannot honestly dispute.
// The score only ever moves a JUDGE verdict, and only between low and medium
// — the two-door tiers. It can never reach "hard", because a text gate on an
// opinion is where people learn to lie to the box, and that rule does not
// bend for a confident opinion: 95 is still the judge guessing, just firmly.
//
// 70 is the line. The prompt's own bands put 56-79 at "off-mission though a
// case could be made" and 80+ at "no case to make", so the cut sits inside
// the arguable band rather than on its edge — a page has to be clearly into
// the top band's territory before the wall charges more for overriding it.
const SCORE_SURE = 70;
function wallTierFor(category, basis, opts) {
  const o = opts || {};
  if (category === "unsure") return "low";
  if (basis === "list" || basis === "host" || basis === "keyword") return "hard";
  const score = Number(o.score);
  const scored = Number.isFinite(score) && score >= 0;

  // These three are facts about the SITUATION, not about the page, and they
  // outrank the judge's confidence because they each say the judge had less
  // to go on than it thinks: a course platform it cannot see is a course, a
  // host you already overruled this week, or no task list to read against.
  if (o.platform) return "low";
  if ((o.hostOverrides || 0) > 0) return "low";
  if (!(o.todosCount > 0)) {
    // With no tasks the judge is reading the mission alone — thin evidence,
    // so it stays low. But a page it scored at the top of the scale is one
    // it was sure about with nothing to lean on, and pretending otherwise
    // would price the obvious cases the same as the genuine coin-flips.
    return (scored && score >= 90) ? "medium" : "low";
  }

  // A task list to read against — the old unconditional "medium". Now the
  // score decides: a judge that admits the call was arguable should not
  // charge the premium for being overruled.
  if (!scored) return "medium";            // no number offered — unchanged
  return score >= SCORE_SURE ? "medium" : "low";
}

// word bank for the random 25-word gate sentence (all lowercase, common words)
const WORD_BANK = ("time focus work study code build learn grow push climb steady patient honest quiet " +
  "morning river stone bridge mountain forest signal anchor future ladder engine circuit pattern logic " +
  "reason effort matter choice moment ocean silver copper garden pencil marble candle " +
  "reader author driver runner planet season winter summer autumn number letter simple present " +
  "distance journey purpose promise problem answer method system memory network machine random gentle " +
  "strong clever careful curious").split(/\s+/);
function makeSentence(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(WORD_BANK[Math.floor(Math.random() * WORD_BANK.length)]);
  return out.join(" ");
}

// Are you actually here right now? Chrome must be the focused app and the
// machine must not be locked. Without this, time accrues for tabs you opened
// and walked away from — which is what inflated the old scoreboard numbers.
//
// "idle" is deliberately NOT treated as absent, and that is the whole fix for
// a wall that worked on some pages and not others. chrome.idle calls you idle
// after IDLE_AFTER_SECONDS with no keyboard or mouse input — and watching a
// video is precisely that: you stop touching anything and watch. So the tool
// stood down at the 60-second mark on exactly the tabs it exists to block,
// while a page you kept scrolling (a feed, an article) held you "active" and
// got walled normally. The wall was never flaky; it was reliably absent from
// anything that held attention without the hands, and present everywhere else.
//
// Only "locked" is a real absence: the screen is locked, so you cannot be
// reading. A still mouse in front of an unlocked screen playing a video is the
// most present a distraction ever gets.
//
// The window-focus check above already covers what the idle test was reaching
// for — a tab left open behind another app costs nothing, because Chrome is
// not the focused window. That is the honest test for "opened it and walked
// away", and it does not need the idle state to back it up.
async function userIsPresent() {
  try {
    const win = await chrome.windows.getLastFocused();
    if (!win || !win.focused) return false;          // Chrome is behind another app
  } catch (e) { /* no window info — assume present */ }
  try {
    const state = await chrome.idle.queryState(IDLE_AFTER_SECONDS);
    if (state === "locked") return false;            // screen locked — genuinely gone
  } catch (e) { /* idle API unavailable — assume present */ }
  return true;
}

// ---- scheduled focus windows -------------------------------------
// "Strict 9-1 on weekdays, off after 8pm." Without this the tool is either
// always on or always off, and the always-on version is the one people switch
// off in the evening and never switch back.
//
// A schedule is a list of { days:[0-6], from:"HH:MM", to:"HH:MM" } where 0 is
// Sunday. Empty list = no schedule = always on, which is the old behaviour and
// stays the default: a tool that silently stops working because the user never
// found the schedule editor is worse than one with no schedule at all.
//
// Windows may cross midnight (from > to), which is the 22:00-02:00 case. That
// is handled by testing the two halves separately rather than by normalising,
// because a window crossing midnight belongs to BOTH days at its two ends and
// collapsing it to one loses the Friday-night/Saturday-morning distinction.
function hhmmToMins(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// Is `now` inside any configured window? With no windows at all the answer is
// yes — see above.
function scheduleActiveAt(schedule, now) {
  if (!Array.isArray(schedule) || !schedule.length) return true;
  const day = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  const prevDay = (day + 6) % 7;

  for (const w of schedule) {
    if (!w || !Array.isArray(w.days) || !w.days.length) continue;
    const from = hhmmToMins(w.from), to = hhmmToMins(w.to);
    if (from === null || to === null) continue;

    if (from < to) {
      // Ordinary same-day window.
      if (w.days.includes(day) && mins >= from && mins < to) return true;
    } else if (from > to) {
      // Crosses midnight. The evening half belongs to the window's own day;
      // the morning half belongs to the day AFTER it, so a Friday 22:00-02:00
      // window must still be active at 01:00 on Saturday.
      if (w.days.includes(day) && mins >= from) return true;
      if (w.days.includes(prevDay) && mins < to) return true;
    }
    // from === to is a zero-length window — ignored rather than treated as
    // "all day", which is what a mistyped duplicate would otherwise become.
  }
  return false;
}

// ---- storage helpers ---------------------------------------------
async function getState() {
  const d = await chrome.storage.local.get([
    "todos", "apiKey", "log", "enabled", "lastReset", "allowDomains", "mission",
    "schedule", "blockDomains"
  ]);
  // Tasks now carry the day they were written for, and the popup can plan
  // ahead. Only what is live RIGHT NOW may vouch for a site: open, and dated
  // today or earlier. A task parked on next Tuesday must not quietly exempt
  // its link today — that would turn the calendar into a way around the wall.
  const live = t => {
    if (typeof t === "string") return true;          // pre-dates the date field
    if (!t || t.done) return false;
    return !t.date || t.date <= todayKey();
  };
  return {
    // todos are stored as [{text, done}] but older versions stored plain
    // strings — normalize both to text[] for everything downstream.
    // Completed tasks are dropped: a finished task should stop vouching for
    // its topic. Leaving them in meant ticking "revise DP" off still told the
    // classifier that DP videos were today's work.
    todos: (d.todos || [])
      .filter(live)
      .map(t => (typeof t === "string" ? t : t && t.text) || "").filter(Boolean),
    // The same open tasks, but keeping the link a task may carry. The flat
    // todos[] above stays as-is because every AI prompt joins it into text;
    // the wall needs the URL so a task with a link is openable from the block
    // screen — that link IS the way back to work.
    todoItems: (d.todos || [])
      .filter(live)
      .map(t => (typeof t === "string"
        ? { text: t, url: "", host: "" }
        : { text: (t && t.text) || "", url: (t && t.url) || "", host: (t && t.host) || "" }))
      .filter(t => t.text),
    apiKey: d.apiKey || "",
    log: d.log || {},
    enabled: d.enabled !== false,
    lastReset: d.lastReset || todayKey(),
    allowDomains: d.allowDomains || [],
    // Domains the user has declared junk outright. Checked alongside the
    // built-in list, so this extends the rules rather than replacing them.
    blockDomains: d.blockDomains || [],
    // Empty = always on. See scheduleActiveAt().
    schedule: Array.isArray(d.schedule) ? d.schedule : [],
    // what the user is actually working toward — drives every AI prompt.
    // blank means "no stated mission", handled by missionBlock().
    mission: (d.mission || "").trim()
  };
}

function todayKey() {
  const dt = new Date();
  return dt.getFullYear() + "-" + String(dt.getMonth()+1).padStart(2,"0") + "-" + String(dt.getDate()).padStart(2,"0");
}

// How long the day-by-day statistics are kept. Unlike the access log and the
// verdict cache, this one had no ceiling — every day added a permanent row
// carrying a title and a URL for every page visited, and logTime rewrites the
// WHOLE object on every tick, so an unbounded log is a growing write cost as
// well as a growing record of where you've been. Ninety days outlives any range
// the scoreboard offers and is short enough to state plainly in the privacy
// policy, which is what makes the claim there true rather than aspirational.
const LOG_RETENTION_DAYS = 90;

// Drop days that have aged out. Only real date keys are considered, so the
// per-day totals that live alongside them (saved, blocks) are never touched by
// the sort. Mutates in place — the caller is already about to write this object.
function pruneLog(log) {
  const days = Object.keys(log).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  if (days.length <= LOG_RETENTION_DAYS) return log;
  for (const k of days.slice(0, days.length - LOG_RETENTION_DAYS)) delete log[k];
  return log;
}

// add seconds to today's log under a category (productive|junk|neutral)
async function logTime(category, seconds, title, url, paused) {
  const { log } = await getState();
  pruneLog(log);
  const day = todayKey();
  if (!log[day]) log[day] = { productive: 0, junk: 0, neutral: 0, sites: {} };
  // "claimed" is time bought with a once-pass. It goes in the wasted column —
  // that was the deal on the wall — and is ALSO tallied on its own, so the
  // scoreboard can say how much of the wasted number you paid to keep. Like
  // `paused` below: a note on the three buckets, not a fourth one.
  if (category === "claimed") {
    log[day].claimed = (log[day].claimed || 0) + seconds;
    category = "junk";
  }
  log[day][category] += seconds;
  // Time that passed while the tool was paused is filed in its category like
  // any other — a paused hour on YouTube is still an hour on YouTube — and
  // ALSO tallied here, so the scoreboard can say how much of the day the
  // tool was stood down for, without a fourth colour the split does not need.
  if (paused) log[day].paused = (log[day].paused || 0) + seconds;
  // track per-title time too — normalize first so "(3) WhatsApp" and "WhatsApp"
  // merge into one row instead of fragmenting the breakdown.
  const label = shortLabel(normalizeTitle(title));
  const prev = log[day].sites[label];
  // Entries used to be a bare number of seconds. They're now {s, u} so the
  // scoreboard can link back to the page — old numeric entries are read as
  // seconds with no URL rather than being discarded.
  const secs = (typeof prev === "number" ? prev : (prev && prev.s) || 0) + seconds;
  const keptUrl = (prev && typeof prev === "object" && prev.u) || "";
  // Only remember http(s) pages; a chrome:// or file:// URL isn't a link worth
  // offering, and the last URL seen for a title wins so it stays current.
  const u = (url && /^https?:/i.test(url)) ? url : keptUrl;
  // Seconds are also split by category. A single page can move between
  // categories within a day — a YouTube tab judged junk, then exempted by a
  // task link — so keeping a per-category tally is honest where one label
  // would have to pick a winner and discard the rest.
  const prevCat = (prev && typeof prev === "object" && prev.c) || {};
  const c = {
    productive: prevCat.productive || 0,
    junk: prevCat.junk || 0,
    neutral: prevCat.neutral || 0
  };
  if (c[category] !== undefined) c[category] += seconds;
  const entry = { s: secs, c };
  if (u) entry.u = u;
  log[day].sites[label] = entry;
  await chrome.storage.local.set({ log });
}

// Minutes credited when a wall actually turns you away. Flat, and only on the
// way out: a block you talked your way past saved nothing, and counting it
// would make the number grow fastest exactly when the tool is working least.
// Seven is a deliberately conservative read of the refocus-cost research
// (Mark et al. put the full cost of an interruption far higher) — the figure
// should be one that survives being questioned, since a number you don't
// believe is worth nothing to look at.
const SAVED_MINUTES_PER_BLOCK = 7;

// Tabs that have already banked their credit, so a double-send can't double
// count. Short-lived by design — see the leaving handler.
const leftTabs = new Set();

// Kept per day, alongside the time tallies, so every range the scoreboard
// already knows how to sum — today, this week, all time — works with no extra
// bookkeeping.
// The day log is destructured as `days` rather than `log`, which is the name
// of the debug logger in this file — binding it here would shadow the function
// and any log() call in this scope would throw.
async function logSaved(host) {
  const { log: days } = await getState();
  // Pruned here too: this is the other writer of the day log, and a stretch of
  // pure walk-aways banks credit without ever calling logTime.
  pruneLog(days);
  const day = todayKey();
  if (!days[day]) days[day] = { productive: 0, junk: 0, neutral: 0, sites: {} };
  days[day].saved = (days[day].saved || 0) + SAVED_MINUTES_PER_BLOCK;
  days[day].blocks = (days[day].blocks || 0) + 1;
  await chrome.storage.local.set({ log: days });
  // Paid on the way out only, same as the saved minutes above — this is the
  // one moment the tool demonstrably worked.
  await earnEvent("block", "walked away from " + (host || "a site"));
  log("[GS] 💾 left " + (host || "site") + " — +" + SAVED_MINUTES_PER_BLOCK +
      "m saved (today: " + days[day].saved + "m over " + days[day].blocks + ")");
}

// Why you stood the tool down. Kept as a flat list rather than a per-day tally
// because the interesting shape is the RANKING — "stuck" eleven times and
// "meeting" twice says something a daily count never would. Capped like the
// access log; this is a record for the user to read, not a dataset.
const PAUSE_LOG_CAP = 200;
async function logPause(minutes, reason, kind) {
  const d = await chrome.storage.local.get("pauseLog");
  const rows = Array.isArray(d.pauseLog) ? d.pauseLog : [];
  rows.unshift({
    at: Date.now(),
    minutes,
    // "free" or "bought". The ranking above answers WHY; this answers whether
    // it cost anything, which is the number that decides if the free row in
    // the popup gets to stay.
    kind: kind || "",
    // Normalised so "Stuck" and "stuck " rank as one thing. Empty means the
    // user skipped, which is itself worth counting — a lot of skips means the
    // question is being asked at the wrong moment.
    reason: String(reason || "").trim().toLowerCase().slice(0, 60)
  });
  await chrome.storage.local.set({ pauseLog: rows.slice(0, PAUSE_LOG_CAP) });
}

// Completed focus sessions, banked per day beside the time tallies. Only whole
// finished sessions count — an abandoned one is not a smaller success, it is a
// different outcome, and a scoreboard that credits partial sessions teaches you
// to start them and bail.
async function logSessionDone(s) {
  const { log: days } = await getState();
  pruneLog(days);
  const day = todayKey();
  if (!days[day]) days[day] = { productive: 0, junk: 0, neutral: 0, sites: {} };
  days[day].sessions = (days[day].sessions || 0) + 1;
  const mins = Math.round((s.until - s.startedAt) / 60000);
  days[day].sessionMins = (days[day].sessionMins || 0) + mins;
  await chrome.storage.local.set({ log: days });
  await earnEvent("session", mins + "m session finished");
  log("[GS] 🎯 session complete (today: " + days[day].sessions + ")");
}

// Walk-away credit over the last seven days, for the wall to show at the moment
// of choosing. Returns whole minutes and a count of walk-aways; zeroes mean the
// wall stays quiet about it rather than opening on "0m saved", which reads as a
// target already being failed.
async function savedThisWeek() {
  const { log: days } = await getState();
  let minutes = 0, walks = 0;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 6);          // today plus the six before it
  const from = cutoff.getFullYear() + "-" +
    String(cutoff.getMonth() + 1).padStart(2, "0") + "-" +
    String(cutoff.getDate()).padStart(2, "0");
  for (const k in days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || k < from) continue;
    minutes += days[k].saved || 0;
    walks   += days[k].blocks || 0;
  }
  return { minutes, walks };
}

function shortLabel(title) {
  if (!title) return "unknown";
  return title.length > 60 ? title.slice(0, 57) + "…" : title;
}

// The task text a page suggests for itself: its title with the unread badge
// and the site's own suffix taken off — "Dynamic Programming - LeetCode" is
// the task "Dynamic Programming", the site is already on the link line. Only
// a suffix that names the host is removed; " - Part 2" stays. Falls back to
// the host when the title was nothing but the site name.
function taskTextFor(title, host) {
  let t = normalizeTitle(String(title || "")).trim();
  // The site's name is its first real label — "youtube" from youtube.com or
  // www.youtube.com alike.
  const site = String(host || "").toLowerCase().replace(/^(www|m|mobile)\./, "").split(".")[0];
  const m = t.match(/^(.*\S)\s+[-–—|·:]\s+([^-–—|·:]+)$/);
  if (m && site && m[2].toLowerCase().replace(/[\s.]/g, "").includes(site)) t = m[1].trim();
  if (!t || t.toLowerCase().replace(/[\s.]/g, "") === site) t = host || t;
  return t.slice(0, 120);
}

// strip leading "(3) " unread-count prefixes (YouTube/WhatsApp/Gmail add these);
// keeps one video from busting the cache / re-calling the AL for every count change
function normalizeTitle(title) {
  // The badge is not always a bare number. YouTube writes "(19+)" once the
  // count passes nine, and Gmail uses the same form — so the plain \(\d+\)
  // pattern left "(19+) youtube" intact, which then failed the BARE_LANDINGS
  // equality test and sent the plain homepage to the judge to be walled. A
  // notification count is never part of what a page IS, so every shape of it
  // comes off: digits, an optional "+", and optional surrounding space.
  return (title || "").replace(/^\(\s*\d+\+?\s*\)\s*/, "").trim();
}

// ---- classification ----------------------------------------------
// returns "productive" | "junk" | "neutral"
// Titles that are clearly the browser's own pages / blank — never nag.
const IGNORE_TITLES = ["new tab", "extensions", "settings", "chrome://", "about:blank", "go study"];

// Utility / communication tools that are NEEDED — never lock these.
//
// Matched as substrings of the title, so every entry here must be distinctive
// enough that it cannot appear inside an ordinary sentence. The short generic
// words that used to live in this list — "mail", "drive", "keep", "maps",
// "meet", "calendar", "teams" — were a large hole, because this check runs
// BEFORE every junk rule and returns neutral, meaning the page is never walled
// and never even judged. "Baby Driver (2017) — Full Movie" contains "drive",
// "Keeping Up With The Kardashians" contains "keep", "Blackmail" contains
// "mail", and every one of them beat the ALWAYS_JUNK list below.
//
// They moved to NEUTRAL_UTILITY_HOSTS, which is where they belonged: these are
// all single-host apps, so the hostname identifies them exactly and the title
// match was buying nothing.
const NEUTRAL_UTILITY = [
  "whatsapp", "gmail", "google calendar", "google maps", "google drive",
  "google keep", "google meet", "microsoft teams",
  "notion", "translate", "zoom", "outlook"
];

// The same tools, identified by host instead of title. Checked with the same
// suffix matching as every other domain list, so mail.google.com and its
// subdomains are covered without any substring guesswork.
const NEUTRAL_UTILITY_HOSTS = [
  "mail.google.com", "calendar.google.com", "drive.google.com",
  "docs.google.com", "keep.google.com", "maps.google.com",
  "meet.google.com", "contacts.google.com",
  "web.whatsapp.com", "teams.microsoft.com", "outlook.office.com",
  "outlook.live.com", "outlook.com", "zoom.us", "notion.so",
  "translate.google.com"
];

// Bare landing pages (no real content opened yet) — a plain "YouTube" homepage,
// a bare domain with nothing consumed. Judge only when actual content is open.
const BARE_LANDINGS = ["youtube", "google", "bing", "duckduckgo"];

// Words a homepage pads its own name with. A title built only from these plus
// the site name is still a landing page — nothing has been opened yet.
const LANDING_FILLER = ["home", "homepage", "feed", "trending", "explore", "start"];

// Is this title nothing but a site name and filler? Split on the separators
// sites actually use, then check every part is one or the other. "Home -
// YouTube" and "YouTube - YouTube" pass; "How to CLEAN money - YouTube" does
// not, because "how to clean money" is neither.
function isBareLanding(t) {
  const parts = String(t || "").split(/\s*[-–—|·]\s*/).filter(Boolean);
  if (!parts.length || parts.length > 3) return false;
  return parts.every(p =>
    BARE_LANDINGS.includes(p) || LANDING_FILLER.includes(p));
}

// Always-allowed domains (matched against the tab's real hostname). These are
// treated as productive no matter what the title says. Built-in list below;
// users can add more via the popup (stored under "allowDomains").
const ALLOWED_DOMAINS = [
  "leetcode.com", "geeksforgeeks.org", "github.com", "stackoverflow.com",
  "hackerrank.com", "codeforces.com", "codechef.com", "kaggle.com",
  "replit.com", "codesandbox.io", "w3schools.com", "developer.mozilla.org",
  // cloud skilling / certification platforms
  "cloudskillsboost.google", "googlecloudcommunity.com", "qwiklabs.com",
  "aws.amazon.com", "learn.microsoft.com"
];

// Social/entertainment domains that are hard to catch by title (e.g. x.com,
// whose title is often just a tweet). Matched by hostname → always junk.
const JUNK_DOMAINS = [
  "x.com", "twitter.com", "instagram.com", "facebook.com",
  "tiktok.com", "netflix.com", "primevideo.com", "hotstar.com",
  "9gag.com", "snapchat.com"
];

// Genuinely mixed-use: real technical communities live here alongside pure time
// sinks (r/cscareerquestions vs r/memes; an open-source Discord vs a gaming one).
// Blocking them outright is the most common false positive in focus tools, so
// they're judged by title against the user's mission like any ambiguous tab.
const MIXED_USE_DOMAINS = ["reddit.com", "discord.com", "news.ycombinator.com"];

// Course platforms. Not allowed outright — a page on one of these can still be
// off-mission, and an entire site handed over is how a blocker gets its first
// hole — but two things change for them:
//
//   1. The judge is TOLD it is looking at a course platform. A title like
//      "Why to use Python for analytics" carries no signal about where it is,
//      and RULE 2 in the prompt explicitly covers "learning, skill-building,
//      certification and training platforms"; the judge can only apply that
//      rule if it knows the page is on one.
//   2. A junk verdict here is never a confident one. The wall that follows is
//      the two-door kind at its cheapest, not the questionnaire — see
//      wallTierFor(). A false positive on a course is the most expensive kind
//      this tool can produce: it teaches the user the tool is dumb, and a tool
//      you think is dumb gets switched off.
//
// `path` narrows an entry to one section of a mixed host. linkedin.com is a
// feed with a course library attached; only the library is a course platform.
const LEARNING_SITES = [
  { host: "linkedin.com", path: "/learning", name: "LinkedIn Learning" },
  { host: "coursera.org", name: "Coursera" },
  { host: "udemy.com", name: "Udemy" },
  { host: "edx.org", name: "edX" },
  { host: "khanacademy.org", name: "Khan Academy" },
  { host: "pluralsight.com", name: "Pluralsight" },
  { host: "brilliant.org", name: "Brilliant" },
  { host: "datacamp.com", name: "DataCamp" },
  { host: "codecademy.com", name: "Codecademy" },
  { host: "freecodecamp.org", name: "freeCodeCamp" },
  { host: "udacity.com", name: "Udacity" },
  { host: "skillshare.com", name: "Skillshare" },
  { host: "nptel.ac.in", name: "NPTEL" },
  { host: "swayam.gov.in", name: "SWAYAM" },
  { host: "deeplearning.ai", name: "DeepLearning.AI" },
  { host: "fast.ai", name: "fast.ai" }
];
// The platform's name when the URL is on one, "" otherwise.
function learningPlatform(url) {
  let u;
  try { u = new URL(url); } catch (e) { return ""; }
  const host = u.hostname.toLowerCase();
  for (const s of LEARNING_SITES) {
    if (host !== s.host && !host.endsWith("." + s.host)) continue;
    if (s.path && !u.pathname.toLowerCase().startsWith(s.path)) continue;
    return s.name;
  }
  return "";
}

// Search engines + AI assistants: these are HOW you find and do work. Never
// block them — blocking a search mid-task is the most infuriating false positive.
const SEARCH_HOSTS = [
  "google.com", "google.co.in", "bing.com", "duckduckgo.com", "search.brave.com",
  "ecosia.org", "startpage.com", "perplexity.ai", "chatgpt.com", "chat.openai.com",
  "claude.ai", "gemini.google.com", "grok.com"
];

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ""; }
}
function hostInList(host, list) {
  if (!host) return false;
  return list.some(d => host === d || host.endsWith("." + d));
}
function domainAllowed(host, extra) {
  return hostInList(host, ALLOWED_DOMAINS.concat(extra || []));
}

// Does the user's mission actually name this site? Only used to decide whether a
// hard-junk domain earns a hearing from the judge instead of being blocked on
// sight — it never allows anything by itself.
//
// Matched on the bare site name ("instagram" from "instagram.com"), because
// nobody writes a TLD in a sentence about their work. The name must appear as a
// WHOLE WORD: a substring test would let "xing" or a stray "x" satisfy "x.com",
// and single-letter hosts are the ones most likely to appear by accident.
function missionCovers(host, mission) {
  const m = (mission || "").toLowerCase();
  if (!m) return false;
  const name = String(host || "").toLowerCase()
    .replace(/^www\./, "")
    .split(".")[0];
  if (!name || name.length < 2) return false;   // too short to match safely
  return new RegExp("(^|[^a-z0-9])" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
                    "([^a-z0-9]|$)").test(m);
}

// WHY the last verdict was junk — which rule settled it. The verdict alone
// throws this away, and it is the single most useful fact about a wall: a
// block on x.com by hostname and a block on a course video by a model's guess
// against an empty task list are both "junk", and they deserve very different
// walls. Set by classify() on every call; read by the tick right after.
//
//   "list"     the user's own block-list          certain — they typed it
//   "host"     a built-in junk domain               certain
//   "keyword"  an ALWAYS_JUNK / entertainment title certain
//   "judge"    the AI, or a cached AI verdict       an opinion
//   ""         not junk, or nothing decided
let verdictBasis = "";
function junkBy(basis) { verdictBasis = basis; return "junk"; }

// rulesOnly: settle by lists, rules and the cache, but never call the judge.
// Used while paused — the verdict only files the time, and nothing is walled.
async function classify(title, url, dwell, rulesOnly) {
  await loadCache();
  verdictBasis = "";
  // Cleared with the basis, for the same reason and on the same tick: a
  // verdict settled by a list or a keyword never sets a score, and must not
  // inherit the last judged page's.
  lastScore = -1;

  // local files, extension pages, and browser-internal URLs are never distractions
  const u = (url || "").toLowerCase();
  if (u.startsWith("file:") || u.startsWith("chrome:") || u.startsWith("chrome-extension:") ||
      u.startsWith("edge:") || u.startsWith("about:") || u.startsWith("devtools:")) {
    return "neutral";
  }

  const host = hostOf(url);
  const { allowDomains, blockDomains, mission } = await getState();
  // The user's own allow-list is checked before everything, including the
  // search-host exemption below — this is the one list they are trusted on
  // completely, and a rule that quietly outranks it would make it a lie.
  if (hostInList(host, allowDomains)) return "productive";
  // The user's own block-list. Above the search hosts and the built-in rules
  // for the same reason: if someone has typed a domain in here, no built-in
  // opinion about that domain should be able to overrule them.
  if (hostInList(host, blockDomains)) return junkBy("list");
  // search engines & AI assistants — never blocked (this is how work gets done).
  // YouTube search is deliberately NOT here; that's browsing, not researching.
  if (hostInList(host, SEARCH_HOSTS)) return "neutral";
  // Utility apps, by host. Same verdict the title match used to give them, but
  // identified by the thing that actually identifies them — see the note on
  // NEUTRAL_UTILITY_HOSTS. Placed here so it keeps its old precedence relative
  // to the user's own lists (which still win, above) while no longer being able
  // to exempt an arbitrary page whose title merely contains "drive" or "mail".
  if (hostInList(host, NEUTRAL_UTILITY_HOSTS)) return "neutral";
  // allowlisted domains (built-in list + the user's own) — always productive
  if (domainAllowed(host, allowDomains)) return "productive";
  // THIS page is attached to a to-do. Checked before the junk-domain list so a
  // lecture on an otherwise-blocked site gets through — but only that page.
  // Any other page on the same host falls straight through to the rules below.
  const id = linkIdentity(url);
  if (id) {
    const taskLinks = await taskLinkIdentities();
    if (taskLinks.includes(id)) { log("[GS] task link exempt: " + id); return "productive"; }
    // You said what you were doing here, on the way to a wall, and it went on
    // your list. This page is not walled again until you leave it.
    //
    // "neutral", not "productive": the page was never judged to be work, and
    // saying so would put it in the productive column of your own scoreboard —
    // a number that has to stay true to be worth reading. Neutral is the honest
    // label for time that is neither approved nor being blocked.
    await loadReprieves();
    const r = reprieved.get(id);
    if (r) {
      // A once-pass has a clock on it. Past the deadline it is dropped here,
      // on the next look at the page, and the page falls through to be judged
      // again — from a fresh streak, so the countdown panel gets its say
      // before any wall does.
      if (r.until && Date.now() > r.until) {
        reprieved.delete(id); persistReprieves();
        log("[GS] once-pass expired: " + id);
      } else if (r.kind === "once") {
        // Filed as "claimed": counted as wasted on the scoreboard — that was
        // the deal — but not walled, because that was also the deal.
        log("[GS] once-pass: " + id);
        return "claimed";
      } else {
        log("[GS] reprieved: " + id);
        return "neutral";
      }
    }
  }
  // Hard junk domains (x.com, instagram.com…) — junk on sight, title be damned.
  //
  // Unless the user's mission names the site. For a marketer, a community
  // manager or someone growing a page, Instagram IS the work, and blocking it
  // outright with no judgment made the tool unusable for them — the only escape
  // was an always-allowed list they'd have to know existed. Naming the site in
  // your mission doesn't hand it over; it just buys the same hearing every other
  // ambiguous tab gets, where the title is judged against what you said you do.
  if (hostInList(host, JUNK_DOMAINS) && !missionCovers(host, mission)) return junkBy("host");

  const t = normalizeTitle(title).toLowerCase();
  if (!t) return "neutral";
  for (const ig of IGNORE_TITLES) if (t.includes(ig)) return "neutral";

  // utility tools — never lock (WhatsApp, Gmail, Calendar, Maps, etc.)
  for (const u of NEUTRAL_UTILITY) if (t.includes(u)) return "neutral";

  // bare landing page: the WHOLE title is just the site name (e.g. "YouTube",
  // "Google") with nothing opened → neutral. A real video's title is longer.
  //
  // The equality test alone was too literal. A homepage does not always report
  // its bare name — "Home - YouTube" and "YouTube - YouTube" both occur — and
  // those fell through to the judge, which walled the feed itself. That is the
  // wrong target: the feed is where you decide what to open, and blocking it
  // interrupts before there is anything to interrupt. The thing worth walling
  // is the video you actually pick.
  //
  // Still deliberately narrow. It only matches a title made up ENTIRELY of the
  // site name plus a generic word like "home", so a real video keeps its own
  // title and is judged on it.
  if (BARE_LANDINGS.includes(t)) return "neutral";
  if (isBareLanding(t)) return "neutral";

  // Mixed-use hosts skip the blunt keyword rules and go straight to the judge —
  // a subreddit name or Discord server can trip either list for the wrong reason.
  //
  // A host the mission names is treated the same way, which is what makes that
  // exemption actually work. It cleared the JUNK_DOMAINS check above, and then
  // ALWAYS_JUNK below blocked it anyway on the site's own name — instagram.com
  // has the title "Instagram", which is in that list — so the escape hatch was
  // defeated two steps after it was granted and the user it was written for
  // stayed blocked with no explanation. Routing them here gives them the
  // hearing the comment above promised: judged on the title against the stated
  // mission, rather than passed outright.
  const mixed = hostInList(host, MIXED_USE_DOMAINS) || missionCovers(host, mission);
  if (!mixed) {
    // 1) junk keywords FIRST (so "Prime Video" isn't caught by a productive term)
    //
    // …unless the title is plainly ABOUT the thing rather than the thing
    // itself. "How to build a Netflix clone in React" and "System design:
    // designing Instagram" are the canonical failures here: a bare substring
    // test walls a tutorial because it names a product. The escape hatch is
    // narrow on purpose — it needs a learning word AND is still only a
    // reprieve, handing the title to the judge rather than passing it.
    const junkHit = ALWAYS_JUNK.find(j => t.includes(j));
    if (junkHit && !looksLikeStudyOf(t)) return junkBy("keyword");

    // 2) obvious productive coding/work titles — skip the AI, instant pass
    if (!junkHit) {
      for (const p of ALWAYS_PRODUCTIVE) if (t.includes(p)) return "productive";
    }
  }

  // 3) EVERYTHING ELSE goes to the judge — but an AI call is expensive, so:
  //    - a cached verdict is free, return it immediately;
  //    - otherwise wait until you've actually sat here AI_AFTER_SECONDS.
  //      Tabs you glance at (or opened and left) never cost a call.
  const cached = await cachedVerdict(t);
  // Every cached verdict came from the judge (or from a correction that
  // overwrote one), so a cached junk is a judge's opinion, remembered.
  if (cached) { log("[GS] cache hit → " + cached); return cached === "junk" ? junkBy("judge") : cached; }
  if (rulesOnly) return "neutral";
  if ((dwell || 0) < AI_AFTER_SECONDS) { log("[GS] dwell " + Math.round(dwell) + "s < " + AI_AFTER_SECONDS + "s — waiting to judge"); return "neutral"; }
  log("[GS] ⚖ calling judge for: " + t);
  const v = await judgeRelevance(t, learningPlatform(url));
  log("[GS] judge returned → " + v);
  return v;
}

// For YouTube etc: is this title relevant to today's to-dos?
// Try OpenRouter AI first; fall back to keyword matching.
// The verdict depends on today's to-dos (Rule 1 override), so the cache key
// carries a to-dos signature — change your tasks and stale verdicts are re-judged.
// The mission is part of the key, not just the prompt.
//
// Every verdict is judged against the mission — missionBlock() is load-bearing
// in the prompt and RULE 2 decides on it alone — so a verdict is only valid for
// the mission that produced it. Without this, rewriting your mission left every
// previously cached verdict in force: pages approved under "grow my Instagram
// page" kept returning productive under "land a backend role", because the
// cache is consulted before the AI is ever reached. Including it here also
// means editing the mission invalidates the affected entries for free, with no
// separate clearing step to remember.
async function cacheKeyFor(title) {
  const { todos, mission } = await getState();
  return title + "␟" + (mission || "").toLowerCase().trim() +
         "␟" + todos.map(s => s.toLowerCase().trim()).sort().join("|");
}
async function cachedVerdict(title) {
  const k = await cacheKeyFor(title);
  if (!verdictCache.has(k)) return null;
  // Same reason as the restore in judgeRelevance(): the score must travel
  // with the verdict it belongs to, or the tier is decided by the last page
  // that happened to be judged.
  lastScore = verdictScores.has(k) ? verdictScores.get(k) : -1;
  return verdictCache.get(k);
}

// `platform` is the course platform the page is on, when it is on one — passed
// to the judge as a fact about the page, because the title alone rarely says.
async function judgeRelevance(title, platform) {
  const { todos, apiKey, mission } = await getState();

  // 0) cache — judge each unique title once
  const cacheKey = await cacheKeyFor(title);
  if (verdictCache.has(cacheKey)) {
    const c = verdictCache.get(cacheKey);
    // Restore the score the cached verdict was made with. Without this the
    // slot still holds the PREVIOUS page's number, and a cache hit would be
    // tiered on a score belonging to a different tab — the stale-global bug
    // that verdictBasis is reset in classify() to avoid.
    lastScore = verdictScores.has(cacheKey) ? verdictScores.get(cacheKey) : -1;
    return c === "junk" ? junkBy("judge") : c;
  }

  // 1) AI path — runs even with no to-dos, because genuine learning
  //    (a CS lecture, an ML talk) is productive regardless of today's list.
  let aiFailed = false;
  if (apiKey) {
    try {
      const verdict = await aiRelevant(title, todos, apiKey, mission, platform);
      log("[GS] AI verdict for \"" + title + "\" = " + verdict);
      if (verdict === "productive" || verdict === "junk") {
        rememberVerdict(cacheKey, verdict, lastScore);
        persistCache();
        return verdict === "junk" ? junkBy("judge") : verdict;
      }
    } catch (e) {
      aiFailed = true;
      log("[GS] AI call failed:", String(e));
    }
  }

  // 2) keyword fallback — cheap, offline. Trust it when it's confident.
  if (todos.length && keywordRelevant(title, todos)) return "productive";
  if (looksLikeEntertainment(title)) return junkBy("keyword");

  // 3) genuinely undecided. If the AI FAILED (key present but rate-limited/err),
  //    don't silently allow — hand the call to the user with a self-check nudge.
  //    If there was simply no key and nothing matched, stay neutral.
  if (apiKey && aiFailed) return "unsure";
  return "neutral";
}

// crude entertainment sniff for when there's no AI key
// Deliberately conservative: this runs only when there's no API key, so a false
// positive here blocks real work with no AI to overrule it. Terms that collide
// with technical titles are excluded — "vs " (React vs Vue), bare "audio"
// (audio processing), "mix " (mixed precision), "season"/"episode" (podcasts).
const ENTERTAINMENT_WORDS = [
  "song", "songs", "megamix", "remix", "lyrics",
  "official video", "music video", "full movie", "movie explained",
  "official trailer", "vlog", "reaction video", "gameplay", "funny",
  "meme", "prank", "live match", "ipl ", "cricket highlights",
  "web series", "full album", "bass boosted", "lofi"
];
function looksLikeEntertainment(title) {
  const t = (title || "").toLowerCase();
  return ENTERTAINMENT_WORDS.some(w => t.includes(w));
}

// The user's stated mission, rendered for a prompt. Blank mission falls back to
// a neutral "focused work" framing so the extension still works out of the box.
function missionBlock(mission) {
  return mission
    ? "The user's stated mission is:\n\"" + mission + "\"\n\n" +
      "Their work is whatever genuinely serves that mission.\n\n"
    : "The user has not written a mission statement. Treat as WORK anything that is " +
      "plausibly focused work, learning, or professional activity.\n\n";
}

async function aiRelevant(title, todos, apiKey, mission, platform) {
  const todoBlock = todos.length
    ? "Today's specific tasks:\n" + todos.map((x, i) => (i + 1) + ". " + x).join("\n") + "\n\n"
    : "(No specific tasks set for today.)\n\n";

  // Where the page is, when that is a course platform. RULE 2 below already
  // names "learning, skill-building, certification and training platforms" as
  // work — but the judge only ever sees a title, and "Why to use Python for
  // analytics" does not say it is a lesson. This is the one fact about the
  // page that the title cannot carry. Stated as a fact, not a verdict: an
  // off-mission course is still RULE 3's to decide.
  const whereBlock = platform
    ? "Where the tab is: a lesson page on " + platform + ", a course platform.\n\n"
    : "";

  const prompt =
    "You are a strict focus filter. Decide whether the current browser tab serves the " +
    "user's mission or is a distraction from it.\n\n" +
    missionBlock(mission) +
    todoBlock +
    "Current tab title:\n\"" + title + "\"\n\n" +
    whereBlock +
    "Apply these rules STRICTLY IN ORDER and STOP at the first that matches:\n\n" +
    "RULE 1 (highest priority — the user's explicit override): If the tab's topic " +
    "matches ANY of today's tasks listed above, answer WORK — even if that topic is " +
    "normally off-mission. The task list always wins.\n\n" +
    "RULE 2: If no task matched, but the tab plainly serves the stated mission — " +
    "including genuine learning, skill-building, certification and training platforms, " +
    "documentation, and professional tools in that field — answer WORK.\n\n" +
    "RULE 3: Otherwise answer DISTRACTION. This includes content that is educational " +
    "but off-mission and not in today's tasks, plus entertainment, music, sports, memes, " +
    "vlogs, reactions, 'motivation/get rich' content, and social media.\n\n" +
    "Then rate how far off-mission the tab is, 0 to 100:\n" +
    "  0-30   clearly serves the mission or a task (WORK)\n" +
    "  31-55  arguably useful, but you are not confident either way\n" +
    "  56-79  off-mission, though a case could be made for it\n" +
    "  80-100 plainly a distraction, no case to make\n\n" +
    "Answer with exactly: WORK or DISTRACTION, a space, then the number. " +
    "Example: DISTRACTION 85\n" +
    "Do not explain. Nothing else.";

  // 5 tokens was too tight to be safe: any model that prefixes its answer, or
  // thinks before it speaks, ran out mid-sentence and returned nothing usable.
  // 16 still cannot fit an explanation, so a chatty model is truncated rather
  // than obeyed — but a one-word answer now always fits.
  // 24, not 16: the answer is now a word AND a number, and a model that pads
  // with a newline or a stray token must still land both inside the cap.
  const raw = await aiChat(prompt, apiKey, 24);
  const v = parseVerdict(raw);
  // The score rides on a module-level slot rather than the return value,
  // because parseVerdict() has four other callers and every one of them
  // wants the plain verdict. Set next to the verdict it belongs to, and
  // read by the same tick that judged — see lastScore's own note.
  lastScore = parseScore(raw);
  if (v) { lastAiError = ""; return v; }
  // Include what actually came back. "unclear answer" with no sample was
  // unfixable from the outside — there was no way to tell a broken key from a
  // model that simply phrased it differently.
  const sample = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 60);
  throw new Error(sample ? "unclear answer: \"" + sample + "\"" : "unclear answer (empty)");
}

// How far off-mission the judge said the page was, 0-100, or -1 when it did
// not say. Written beside the verdict in aiRelevant() and read in the same
// tick by wallTierFor(), exactly like verdictBasis above — the two are read
// together and neither outlives the tick that set it.
//
// -1 is the honest "no number", and it MUST be distinguishable from 0: a
// model that omits the score is uncertain, while a genuine 0 is the judge's
// most confident WORK. Defaulting a missing score to any number would invent
// a confidence the judge never expressed, which is the one thing this whole
// tiering rule exists to avoid.
let lastScore = -1;

// Pull the 0-100 score out of a reply. Returns -1 when there isn't one.
//
// Anchored to the END of the string, because the answer format puts the
// number last and a title echoed back ("Top 10 Python Tricks") is full of
// numbers that are not the score. Anything outside 0-100 is treated as
// absent rather than clamped — a model answering "DISTRACTION 850" has not
// understood the scale, and guessing 100 for it would read as certainty.
function parseScore(raw) {
  const m = String(raw || "").match(/(\d{1,3})\s*[.!]?\s*$/);
  if (!m) return -1;
  const n = Number(m[1]);
  return (n >= 0 && n <= 100) ? n : -1;
}

// Pull WORK / DISTRACTION out of a reply. Returns "" when genuinely ambiguous.
//
// Substring matching was wrong in a way that mattered: a reasoning model that
// concludes "this is not a distraction, it's work" contains BOTH words, and
// the old order returned "junk" for it — blocking a page the model had just
// approved. So negations are stripped first, and if both verdicts still
// survive, the LAST one wins, because that is where a conclusion lives.
function parseVerdict(raw) {
  let t = String(raw || "").toLowerCase();
  if (!t.trim()) return "";
  // Drop the negated forms so they can't count as a vote for their own word.
  t = t.replace(/\b(not|isn't|is not|no)\s+(a\s+|an\s+)?(distraction|junk)\b/g, " __nd__ ")
       .replace(/\b(not|isn't|is not|no)\s+(real\s+)?(work|productive)\b/g, " __nw__ ");
  const junk = t.lastIndexOf("distraction") >= 0
    ? t.lastIndexOf("distraction") : t.lastIndexOf("junk");
  const workIdx = Math.max(t.lastIndexOf("work"), t.lastIndexOf("productive"));
  if (junk < 0 && workIdx < 0) return "";
  // A negated "not a distraction" leaves __nd__ behind and no bare hit, so the
  // surviving verdict is the honest one.
  if (junk >= 0 && workIdx >= 0) return junk > workIdx ? "junk" : "productive";
  return junk >= 0 ? "junk" : "productive";
}

// Models that "think" before answering. Their reasoning is billed against the
// same max_tokens as the answer, so a one-word question with a tight cap gets
// spent entirely on thinking and returns an EMPTY answer — which surfaced as
// "AI failed: unclear answer" on a key that was working perfectly.
//
// The name is not a reliable signal: qwen3, gpt-oss and the r1 distills all
// reason by default and none of them say "thinking" in the slug. So this
// matches the actual families rather than the word.
function isReasoningModel(id) {
  return /reasoning|thinking|deepseek-?r1|\br1\b|qwen3|gpt-?oss|magistral|phi-?4-reasoning/i.test(id || "");
}

// Build the request. Two defences against the empty-answer failure:
//   1. Ask the provider to switch reasoning OFF where it supports it. Groq
//      accepts reasoning_effort:"none" on its reasoning models, which makes
//      them answer like an ordinary instruct model.
//   2. Give reasoning models a much larger budget anyway, so that if the
//      provider ignores (1) the thinking has room to finish and still leave
//      the answer. Costs nothing on the models that don't think — they stop
//      at their one word regardless of the ceiling.
function chatBody(model, prompt, maxTokens) {
  const body = {
    model, messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens, temperature: 0.3
  };
  if (isReasoningModel(model)) {
    body.reasoning_effort = "none";
    body.max_tokens = Math.max(maxTokens, 512);
  }
  return body;
}

// Low-level chat call: tries each model, handles 401/402/429, returns raw text.
async function aiChat(prompt, apiKey, maxTokens) {
  const provider = providerOf(apiKey);
  const endpoint = provider === "groq"
    ? "https://api.groq.com/openai/v1/chat/completions"
    : "https://openrouter.ai/api/v1/chat/completions";
  const models = provider === "groq" ? await getGroqModels(apiKey) : await getFreeModels(apiKey);
  if (!models.length) { lastAiError = "no models available"; throw new Error(lastAiError); }

  let lastErr = "no models";
  let staleList = false;
  for (const model of models) {
    try {
      const send = body => fetchT(endpoint, {
        method: "POST",
        headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }, 15000);

      const body = chatBody(model, prompt, maxTokens);
      let res = await send(body);
      // reasoning_effort is not universally supported, and a provider that
      // doesn't know the field rejects the whole request. Retry once without
      // it before concluding anything: without this the 400 below would mark
      // the model list stale and throw away a cache that was perfectly good,
      // turning an unsupported PARAMETER into "your models are all retired".
      if (res.status === 400 && body.reasoning_effort) {
        delete body.reasoning_effort;
        res = await send(body);
      }
      if (res.status === 401) { lastErr = "invalid API key"; break; }
      if (res.status === 402) { lastErr = "no credits for " + model; continue; }
      if (res.status === 429) { lastErr = "rate limited"; continue; }
      if (!res.ok) {
        // "HTTP 400" alone is unfixable from the user's side. The body says
        // whether the model is retired, the key lacks access, or the request is
        // malformed — so read it, and drop a stale cache when a model is gone.
        //
        // The status is captured BEFORE the body is touched. Reading a body can
        // itself throw (aborted connection, worker shutdown), and letting that
        // escape would replace a precise "HTTP 400: model decommissioned" with
        // a useless "Failed to fetch" — the diagnostic reporting its own
        // failure instead of the fault it was called to explain.
        const status = res.status;
        if (status === 400 || status === 404) staleList = true;
        lastErr = "HTTP " + status;
        const detail = await errDetail(res);
        if (detail) lastErr = "HTTP " + status + ": " + detail;
        continue;
      }
      const data = await res.json();
      const choice = data.choices?.[0] || {};
      const msg = choice.message || {};
      // Reasoning models split their output: the thinking lands in a separate
      // field and `content` can come back empty even on a perfectly good call.
      // Falling back to the reasoning text lets the caller's parser find the
      // verdict that IS there, instead of reporting a failure that didn't
      // happen. Providers differ on the field name, so try the known ones.
      let text = msg.content || "";
      if (!text) text = msg.reasoning || msg.reasoning_content || "";
      if (text) { lastAiError = ""; return text; }
      // Nothing usable. Say WHY — "empty answer" alone gave no clue that the
      // cap was the problem, which is what made this bug hard to place.
      lastErr = choice.finish_reason === "length"
        ? "model hit the token cap before answering (" + model + ")"
        : "empty answer from " + model;
    } catch (e) {
      lastErr = String(e && e.message ? e.message : e);
    }
  }
  // Every model was rejected as unknown, so the cached list is out of date.
  // Forget it: the next call rediscovers rather than repeating a dead lineup
  // for the whole cache window.
  if (staleList) {
    if (provider === "groq") lastGroqDiscoveryTs = 0;
    else lastDiscoveryTs = 0;
  }
  lastAiError = lastErr;
  throw new Error(lastErr);
}

// fetch with a deadline. A bare fetch in a service worker can hang until the
// worker is suspended, and the rejection that follows says only "Failed to
// fetch" — indistinguishable from having no internet. An explicit timeout turns
// that into a message that names what actually happened.
async function fetchT(url, opts, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || 12000);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("timed out after " + Math.round((ms || 12000) / 1000) + "s");
    // Offline, DNS failure, or a blocked request all arrive as a bare
    // TypeError. Say so in words the user can act on.
    throw new Error("cannot reach " + (new URL(url).hostname) + " (offline or blocked)");
  } finally {
    clearTimeout(timer);
  }
}

// Pull the human-readable reason out of an error response. Best effort — an
// unreadable body must never mask the status code we already have.
async function errDetail(res) {
  try {
    const body = await res.text();
    if (!body) return "";
    try {
      const j = JSON.parse(body);
      const m = j.error?.message || j.message || "";
      if (m) return String(m).slice(0, 160);
    } catch (e) { /* not JSON — fall through to the raw text */ }
    return body.replace(/\s+/g, " ").trim().slice(0, 160);
  } catch (e) { return ""; }
}

// Groq's CURRENT chat models. It retires slugs without notice and a retired one
// answers 400, so asking the API which models exist beats trusting a constant.
// Cached for 6h; cleared early by aiChat when a model turns out to be gone.
async function getGroqModels(apiKey) {
  const SIX_H = 6 * 60 * 60 * 1000;
  if (discoveredGroqModels && (Date.now() - lastGroqDiscoveryTs) < SIX_H) {
    return discoveredGroqModels;
  }
  try {
    const res = await fetchT("https://api.groq.com/openai/v1/models", {
      headers: { "Authorization": "Bearer " + apiKey }
    }, 10000);
    if (!res.ok) throw new Error("models list " + res.status);
    const data = await res.json();
    const ids = (data.data || [])
      .filter(m => m && m.id && m.active !== false)
      .map(m => m.id)
      // Whisper/TTS/guard models live in the same list and cannot answer a chat
      // prompt. Asking one is a guaranteed 400.
      .filter(id => !/whisper|tts|guard|prompt-?guard|embed/i.test(id));
    if (!ids.length) throw new Error("no chat models listed");
    ids.sort((a, b) => scoreModel(a) - scoreModel(b));
    discoveredGroqModels = ids.slice(0, 6);
    lastGroqDiscoveryTs = Date.now();
    log("[GS] discovered groq models:", discoveredGroqModels);
    return discoveredGroqModels;
  } catch (e) {
    log("[GS] groq discovery failed:", e);
    return discoveredGroqModels || GROQ_MODELS;
  }
}

// Judge the user's typed answers: is this a legitimate reason to be here, or a
// rationalization? Balanced — rejects vague excuses, accepts a clear honest reason.
// Returns { pass: bool, reason: string }. Fails OPEN to the typing test on error.
async function aiJudgeAnswers(title, questions, answers, todos, apiKey, mission) {
  if (!apiKey) { log("[GS] judge: NO API KEY → forcing typing test"); return { pass: false, reason: "" }; }
  const qa = questions.map((q, i) => "Q: " + q + "\nA: " + (answers[i] || "(blank)")).join("\n");
  const todoBlock = todos.length ? "Their tasks today: " + todos.join("; ") + ".\n" : "They set no tasks today.\n";
  const missionLine = mission ? "Their stated mission: \"" + mission + "\".\n" : "";
  const prompt =
    "Someone hit a distraction block on the page \"" + title + "\" and answered questions to explain why they want in. " +
    missionLine + todoBlock +
    "Their answers:\n" + qa + "\n\n" +
    "Decide if they should be let in. Be BALANCED and fair — a reasonable person deciding.\n" +
    "PASS (true) if their answers give any genuine, coherent reason — it helps their work, it's a real task, " +
    "a legitimate need, a planned break, or they clearly explain the purpose. Give people the benefit of the doubt " +
    "when the reason is plausible and honest.\n" +
    "FAIL (false) ONLY when the answers are empty, nonsense, self-contradictory, or an obvious mindless excuse " +
    "with no real reason at all.\n" +
    "When in doubt, PASS.\n" +
    "Reply with ONLY a JSON object: {\"pass\": true, \"reason\": \"one short sentence\"}";
  try {
    // 120, not 60: the JSON carries a sentence of reason, and a reply cut off
    // mid-string parses as nothing — which fails the user CLOSED (into the
    // typing test) on an answer the judge may well have accepted.
    const raw = await aiChat(prompt, apiKey, 120);
    log("[GS] judge raw AI reply:", raw);
    // Non-greedy, and anchored on a brace that actually starts an object, so a
    // model that thinks out loud before emitting JSON doesn't hand us its
    // whole monologue as "the object".
    const m = raw.match(/\{[^{}]*"pass"[\s\S]*?\}/);
    if (m) {
      try {
        const o = JSON.parse(m[0]);
        log("[GS] judge verdict → pass=" + !!o.pass + " reason=\"" + (o.reason || "") + "\"");
        return { pass: !!o.pass, reason: String(o.reason || "") };
      } catch (e) { /* malformed — fall through to the text read below */ }
    }
    // No usable JSON. Read the boolean out of the prose instead. The old test
    // rejected on /no\b/, which matches the "no" in any ordinary sentence
    // ("no doubt this helps") and turned accepted answers into refusals.
    const pass = /"pass"\s*:\s*true|\bpass\b|\btrue\b|\byes\b|\ballow\b|\blet (?:them|him|her) in\b/i.test(raw) &&
                 !/"pass"\s*:\s*false|\bfail\b|\breject\b|\bfalse\b|\bdeny\b|\bblock\b/i.test(raw);
    log("[GS] judge (no JSON) → pass=" + pass);
    return { pass, reason: "" };
  } catch (e) {
    log("[GS] judge FAILED (AI error: " + String(e.message || e) + ") → forcing typing test");
    return { pass: false, reason: "" };   // AI down → make him type
  }
}

// Generate ONE pointed, personal justification question about this specific tab.
// Falls back to a generic question if the AI is unavailable.
async function aiQuestion(title, todos, apiKey, mission) {
  const fallback = "How exactly does this page move you closer to what you said you're working toward?";
  if (!apiKey) return fallback;
  const todoBlock = todos.length ? "Their tasks today: " + todos.join("; ") + ". " : "They set no tasks today. ";
  const missionLine = mission ? "Their stated mission: \"" + mission + "\". " : "";
  const prompt =
    "Someone is about to open a page that looks like a distraction from their work. " +
    missionLine + todoBlock +
    "The page title is: \"" + title + "\". Write ONE short, sharp, personal question " +
    "(max 20 words) that forces them to honestly justify opening this instead of doing their work. " +
    "Address them as 'you'. Return only the question, nothing else.";
  try {
    const q = (await aiChat(prompt, apiKey, 40)).trim().replace(/^["']|["']$/g, "");
    return q.length > 8 ? q : fallback;
  } catch (e) {
    return fallback;
  }
}

// Discover OpenRouter's CURRENT :free models (they rotate). Cached for 6h.
async function getFreeModels(apiKey) {
  const SIX_H = 6 * 60 * 60 * 1000;
  if (discoveredFreeModels && (Date.now() - lastDiscoveryTs) < SIX_H) {
    return discoveredFreeModels;
  }
  try {
    const res = await fetchT("https://openrouter.ai/api/v1/models", {}, 10000);
    if (!res.ok) throw new Error("models list " + res.status);
    const data = await res.json();
    const free = (data.data || [])
      .map(m => m.id)
      .filter(id => id.endsWith(":free"));
    // prefer small/fast instruct models — they answer one word just as well
    free.sort((a, b) => scoreModel(a) - scoreModel(b));
    discoveredFreeModels = free.slice(0, 6);
    lastDiscoveryTs = Date.now();
    log("[GS] discovered free models:", discoveredFreeModels);
    return discoveredFreeModels;
  } catch (e) {
    log("[GS] model discovery failed:", e);
    return discoveredFreeModels || [];
  }
}
// lower score = tried first
function scoreModel(id) {
  let s = 50;
  if (/gemma|llama|mistral|qwen|phi|nano|flash|mini|instant/i.test(id)) s -= 20;
  if (/safety|guard|vision|vl|omni|embed|code/i.test(id)) s += 40;  // wrong tool for this
  // Reasoning models are not just slower: their thinking is billed against the
  // same token cap as the answer, so on a one-word question they are the models
  // most likely to return nothing at all. Matched by FAMILY, because none of
  // qwen3 / gpt-oss / r1 carry "reasoning" in the slug — which is exactly why
  // this penalty used to miss them and one ended up in the working set.
  if (isReasoningModel(id)) s += 35;
  // Prefer the smaller model when the size is in the name, as it is on Groq
  // ("llama-3.1-8b-instant" vs "llama-3.3-70b-versatile"). Every call here asks
  // for one word, so a 70B answers no better, just slower and against a much
  // tighter free-tier limit. Without this both score alike and the bigger one
  // wins on list order alone.
  const b = id.match(/[-_](\d+)x?(\d+)?b\b/i);
  if (b) s += Math.min(20, Math.round(Math.log2(Math.max(1, +b[1])) * 3));
  return s;
}

function keywordRelevant(title, todos) {
  const t = (title || "").toLowerCase();
  // build keyword set from to-dos (words > 3 chars)
  const words = new Set();
  todos.forEach(td => {
    td.toLowerCase().split(/[^a-z0-9+#]+/).forEach(w => {
      if (w.length > 3) words.add(w);
    });
  });
  for (const w of words) if (t.includes(w)) return true;
  return false;
}

// ---- FOMO arsenal: shown at random on the lock screen ------------
// These are UNIVERSAL. An earlier version assumed a specific life — campus
// placements, a family loan, parents waiting on a result — and those lines only
// land for the one person they were written about. For anyone else they range
// from confusing to genuinely cruel: someone who has lost a parent should not
// read "somewhere your parents are hoping" on a screen they cannot dismiss
// without passing a typing test. The wall is hard to escape by design, which is
// exactly why its copy must not gamble on circumstances it cannot know.
//
// The personal register isn't lost — it moved to missionLines(), which quotes
// the user's OWN words back instead of guessing at them.
const FOMO_LINES = [
  // — the gap between want and do —
  "Look at what you SAID you wanted. Now look at this screen. See the problem?",
  "Wanting it isn't the same as earning it. This screen is you not earning it.",
  "You'll tell yourself 'just 5 more minutes' — and lose the whole evening. Again.",
  "You don't rise to your goals. You fall to your habits. This is the habit.",
  "Dreaming about the future while wasting the present. Pick one.",
  "Every scroll is a small vote for the life you're trying to escape.",
  "You already know you shouldn't be here. That's why this hurts to read.",
  "You set the goal. This is the part where you find out if you meant it.",
  // — future self / regret —
  "In 5 years you'll either thank tonight or resent it. Choose now.",
  "Future-you is watching this exact moment. Don't make them ashamed.",
  "The gap between you and where you want to be is made of moments like THIS.",
  "You will not remember this video next week. You'll remember staying behind.",
  "Regret is heavier than discipline. Pick the lighter weight.",
  "One day you'll wish you started today. Today is that day.",
  "Time is the one thing you can't earn back. You're spending it here.",
  "Every hour wasted now is an hour you'll beg for later.",
  "You're not behind because you're not smart. You're behind because of moments like this.",
  "The people you envy closed this tab and got to work. That's the whole secret.",
  // — the work waiting —
  "The work isn't going to do itself while you watch this.",
  "Close this. Open the work. One task. That's the whole ask.",
  "The work is boring and this is fun — that's exactly why the work matters more.",
  "Discipline is choosing what you want MOST over what you want NOW. Choose.",
  "Nobody is coming to do it for you. It's you or it's nothing.",
  "The compound interest of showing up starts the second you close this.",
  "You're one closed tab away from being back on track. Do it.",
  "Progress is built in the hours nobody claps for. This is one of them.",
  "Hard now, easy later. Easy now, hard forever. You're picking 'hard forever'.",
  "This tab is the enemy of everything you said you're building.",
  // — direct confrontation —
  "What are you actually doing right now? Be honest with yourself.",
  "Is this moving you toward the goal, or away from it? You know the answer.",
  "You planned to be someone today. Is this what that someone does?",
  "Stop. Breathe. Ask: would I be proud of this hour tomorrow?",
  "The loop is winning right now. Are you going to let it?",
  "This is a test of who you are when it's boring. Don't fail it.",
  "You called this a distraction yourself. So why are you still here?",
  "The dopamine you're chasing costs you the future you actually want.",
  "You're smarter than this tab. Act like it.",
  "Close it. Not because you have to — because you're better than this."
];

// Lines built from what the user actually wrote. This is the sharpest copy the
// wall has, because it isn't a guess about their life — it's their own sentence,
// typed by them, quoted back at the moment they're contradicting it.
//
// Skipped entirely when there's no mission, and when the mission is too short to
// read as a statement ("work", "study") — quoting a single word back is limp
// where quoting a real sentence stings.
function missionLines(mission) {
  const m = (mission || "").trim().replace(/\s+/g, " ");
  if (m.length < 12) return [];
  // Long missions are trimmed on a word boundary so the quote doesn't end
  // mid-word, which reads as a bug rather than a quotation.
  let q = m;
  if (q.length > 90) {
    q = q.slice(0, 90);
    const sp = q.lastIndexOf(" ");
    if (sp > 40) q = q.slice(0, sp);
    q += "…";
  }
  return [
    'You wrote: "' + q + '" — and then you opened this.',
    'Does this serve "' + q + '"? You already know.',
    'The version of you who gets there does not have this tab open. You wrote it: "' + q + '"',
    'Your own words: "' + q + '". This page is not that.'
  ];
}

// ---- self-check lines: shown when the AI couldn't verify ---------
const UNSURE_LINES = [
  "The AI couldn't check this — so YOU have to. Is this genuinely your work, or the loop?",
  "Can't verify this page. Be honest: does this get you closer to the goal, or not?",
  "No verdict on this one. If it's not clearly moving you forward, close it.",
  "Unverified. Ask yourself what you're really doing here — then decide.",
  "I can't judge this. But you can. Is it worth the time you're paying for it?",
  "This one's on you. Would future-you approve of this tab right now?",
  "Couldn't confirm this is work. If you have to justify it, it's probably not.",
  "Grey area. When you're unsure if it's a distraction — it usually is.",
  "No AI verdict. Your gut already knows. Listen to it.",
  "Unclear page. Don't let 'maybe it's useful' become an hour gone.",
  "Can't verify. Is this the work you promised yourself, or an excuse dressed up?",
  "This might be fine. It might be the loop. Only you know — choose fast.",
  "No call from the AI. So make the honest one yourself: necessary or not?",
  "Undecided. If it were clearly your work, you wouldn't be reading this.",
  "The filter blinked. Don't use that as a free pass. Is this real work?",
  "Can't score this. But you can feel whether it's helping. Be real.",
  "Unknown page. The disciplined move when unsure is to step away.",
  "No verdict. Every 'just checking' is how the evening quietly disappears.",
  "This slipped past the AI. Don't let it slip past your standards too.",
  "Verify it yourself: does this serve the future you're fighting for?"
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Toolbar badge: minutes left on the current host's grant, so borrowed time is
// visible rather than expiring out of nowhere. Blank when nothing is running.
let lastBadge = "";
function updatePauseBadge() {
  // The "off" badge outranks everything here. Both functions write the same
  // one pixel-space, and a countdown or a watching dot painted over "off" would
  // put the tool back to looking alive while it isn't.
  if (offReason === OFF_DISABLED || offReason === OFF_NOACCESS) return;
  let text = "", colour = "#0A84FF";
  // A running session owns the badge. It is the state the user most needs to
  // see at a glance, and it outranks a pause anyway.
  if (sessionActive()) {
    const left = sessionLeftMs();
    text = left <= 60000
      ? String(Math.ceil(left / 1000))
      : String(Math.ceil(left / 60000));
    colour = "#46C45B";                       // green: this is the good state
  } else {
    const left = pauseLeftMs();
    if (left > 0) {
      // Under a minute, count seconds — a badge stuck on "1" for sixty seconds
      // gives no sense that time is running out.
      if (left <= 60000) { text = String(Math.ceil(left / 1000)); colour = "#FF2D2A"; }
      else { text = String(Math.ceil(left / 60000)); colour = "#FF9F0A"; }
    } else if (watching) {
      // Section 5: the 20s dwell before a verdict was completely invisible, so
      // a wall arrived from nowhere on a tab that had looked fine. A dot while
      // the current tab is being weighed makes the tool present rather than
      // ambushing — it is deliberately not a countdown, which would read as a
      // threat on a page that may well be judged productive.
      text = "•"; colour = "#48484A";
    }
  }
  if (text === lastBadge) return;                // don't hammer the API
  lastBadge = text;
  try {
    chrome.action.setBadgeText({ text });
    if (text) chrome.action.setBadgeBackgroundColor({ color: colour });
  } catch (e) {}
}
// True while the active tab is past the dwell threshold and genuinely awaiting
// a verdict — set by the tick, read by the badge.
let watching = false;

// ---- off-detection -------------------------------------------------
// A focus tool that can be switched off and then never mentions it again is a
// smoke alarm with the battery out. Nothing here is a nag — the tool just stops
// being able to look like it is working when it isn't.
//
// "Off" has four different causes and they are not interchangeable: switched
// off by hand, never granted host access, outside your scheduled hours, or
// paused. Only the first two are states the user has forgotten about; the other
// two are working as intended and must not be reported as faults.
const OFF_NONE     = "";
const OFF_DISABLED = "disabled";   // the switch
const OFF_NOACCESS = "noaccess";   // host permission missing
const OFF_SCHEDULE = "schedule";   // outside your hours

let offReason = OFF_NONE;

// The icon itself changes when the tool cannot act. A blank badge is what
// "everything is fine" looks like, so blank cannot also be what "I am not
// running" looks like — that ambiguity is the entire bug.
//
// A grey "off" badge was the first attempt and it was not enough: it sits in
// the corner of a full-colour icon that still looks perfectly alive, and at
// toolbar size the eye reads the logo, not the label. So the LOGO goes grey.
// Desaturating the artwork changes the thing you actually look at, and it
// cannot be confused with any of the coloured badge states.
//
// Rendered at runtime from the shipped PNGs rather than committed as a second
// set of assets, so the grey version can never drift from the real icon.
// Cached because this is called on every off/on transition and the heartbeat.
let greyIconData = null;
let colourIconData = null;
const ICON_SIZES = [16, 32, 48];

// Diagnostics. The icon failing is silent by nature — there is no error
// anywhere the user can see, the artwork simply doesn't change — so the last
// paint and the last failure are recorded and readable via the "iconDebug"
// message. Without this the only way to investigate is guessing.
let lastIconPaint = "";
let lastIconError = "";

// Decode the shipped PNGs once into ImageData. Shared by both painters so the
// colour restore goes through the same channel as the grey paint — see the
// note in paintIcon about why the path form cannot be relied on to undo it.
async function loadIconPixels() {
  const out = {};
  for (const size of ICON_SIZES) {
    const url = chrome.runtime.getURL("assets/icon" + size + ".png");
    const res = await fetch(url);
    if (!res.ok) throw new Error("icon" + size + ".png -> HTTP " + res.status);
    const bmp = await createImageBitmap(await res.blob());
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, size, size);
    out[size] = ctx.getImageData(0, 0, size, size);
  }
  return out;
}

async function buildColourIcon() {
  if (colourIconData) return colourIconData;
  colourIconData = await loadIconPixels();
  return colourIconData;
}

async function buildGreyIcon() {
  if (greyIconData) return greyIconData;
  const out = await loadIconPixels();
  for (const size of ICON_SIZES) {
    const px = out[size].data;
    for (let i = 0; i < px.length; i += 4) {
      // Luminance-weighted grey, then pulled toward mid-grey and dimmed.
      // Straight desaturation alone still reads as "a logo"; knocking the
      // contrast down is what makes it read as "switched off".
      const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      const g = Math.round(l * 0.55 + 90 * 0.45);
      px[i] = px[i + 1] = px[i + 2] = g;
      px[i + 3] = Math.round(px[i + 3] * 0.75);   // fade, keeping the silhouette
    }
  }
  greyIconData = out;
  return out;
}

// Repaint the icon and badge to match offReason. Safe to call repeatedly.
async function paintIcon() {
  // A muted grey icon for the two states the user has forgotten about. The
  // scheduled-off case is deliberately NOT marked: being off at 11pm on a 9-5
  // schedule is the tool obeying you, not failing.
  const flag = (offReason === OFF_DISABLED || offReason === OFF_NOACCESS);
  try {
    if (flag) {
      try {
        const imageData = await buildGreyIcon();
        await chrome.action.setIcon({ imageData });
        lastIconPaint = "grey";
      } catch (e) {
        // Canvas unavailable (very old Chrome) — the badge below still lands,
        // so the state is reported even if the artwork doesn't change.
        lastIconError = "grey failed: " + String(e && e.message ? e.message : e);
      }
      chrome.action.setBadgeText({ text: "off" });
      chrome.action.setBadgeBackgroundColor({ color: "#5A5A5E" });
      chrome.action.setTitle({
        title: offReason === OFF_NOACCESS
          ? "Nice Try — no site access, nothing is being blocked. Click to fix."
          : "Nice Try — switched OFF. Nothing is being blocked. Click to turn it on."
      });
      lastBadge = "off";
    } else {
      // Back to the shipped artwork.
      //
      // This is restored as ImageData, not as a path, for a reason that cost
      // real debugging: once an action icon has been set from ImageData, a
      // later setIcon({path}) from a service worker does not reliably replace
      // it, and the icon stays stuck on the grey bitmap. Repainting through
      // the SAME channel it was set by is the thing that actually works.
      //
      // The failure was invisible because the call was wrapped in a bare
      // catch that swallowed it. Errors are recorded now instead.
      try {
        const imageData = await buildColourIcon();
        await chrome.action.setIcon({ imageData });
        lastIconPaint = "colour";
      } catch (e) {
        lastIconError = "restore failed: " + String(e && e.message ? e.message : e);
        // Last resort: the path form. Better than leaving it grey.
        try {
          await chrome.action.setIcon({ path: {
            16: "assets/icon16.png", 32: "assets/icon32.png",
            48: "assets/icon48.png", 128: "assets/icon128.png"
          }});
          lastIconPaint = "colour(path)";
        } catch (e2) {
          lastIconError += " | path fallback failed: " + String(e2 && e2.message ? e2.message : e2);
        }
      }
      if (lastBadge === "off") { try { chrome.action.setBadgeText({ text: "" }); } catch (e) {} lastBadge = ""; }
      chrome.action.setTitle({ title: "Nice Try" });
    }
  } catch (e) {
    lastIconError = "paintIcon threw: " + String(e && e.message ? e.message : e);
  }
}

// The off state has to survive the service worker being torn down. paintIcon()
// only runs on a transition, and doTick() returns early while disabled — so
// once Chrome restarted the worker, the grey icon was never re-applied and a
// switched-off extension went back to looking fully armed. This re-asserts it.
//
// Cheap: a storage read and, at most, a setIcon call that is already a no-op
// when the artwork matches.
async function reassertOffPaint() {
  try {
    const d = await chrome.storage.local.get(["enabled", "offSince"]);
    if (d.enabled === false) {
      // noteOffState is the single writer of offReason; going through it keeps
      // offSince correct instead of resetting the clock on every heartbeat.
      await noteOffState(OFF_DISABLED);
      return;
    }
    if (!(await hasHostAccess())) { await noteOffState(OFF_NOACCESS); return; }
    // Neither fault applies. Clearing here (rather than falling off the end)
    // is what actually takes the grey off: this function is now the single
    // place that decides how the icon should look, so it has to be able to
    // say "fine" as well as "broken". noteOffState is a no-op when the
    // reason is already OFF_NONE, so this costs nothing on the common path.
    //
    // A scheduled-off window is deliberately NOT restored to grey here — the
    // tick owns that, and it is not a fault.
    if (offReason === OFF_DISABLED || offReason === OFF_NOACCESS) {
      await noteOffState(OFF_NONE);
    }
  } catch (e) {}
}

// Records the moment the tool stopped running, so the popup can say how long
// it has been that way. Written once per transition, not per tick.
async function noteOffState(reason) {
  if (reason === offReason) return;
  const was = offReason;
  offReason = reason;
  try {
    if (reason === OFF_DISABLED || reason === OFF_NOACCESS) {
      const d = await chrome.storage.local.get("offSince");
      // Don't reset the clock when the cause changes between the two — the
      // user has been un-covered continuously either way.
      if (!d.offSince) await chrome.storage.local.set({ offSince: Date.now() });
    } else if (was === OFF_DISABLED || was === OFF_NOACCESS) {
      await chrome.storage.local.remove("offSince");
    }
    // The switch is the one stand-down the downtime record could not see
    // any other way. Only the switch: missing host access is a fault, not a
    // choice, and the budget is for choices.
    if (reason === OFF_DISABLED && was !== OFF_DISABLED) await openDown("off");
    else if (was === OFF_DISABLED && reason !== OFF_DISABLED) await closeDown();
  } catch (e) {}
  await paintIcon();
}

// Is the wall actually on screen in this tab right now? A reload wipes the
// injected DOM without the worker knowing, so this is checked rather than
// assumed. Injection failing (restricted page, tab gone) reports "not present",
// which is the safe answer: the caller will try to lock, and that attempt has
// its own fallback to a notification.
async function wallPresent(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!document.getElementById("__focusshield__")
    });
    return !!(res && res[0] && res[0].result);
  } catch (e) {
    return false;
  }
}

// ---- Nice Try: opaque wall + gauntlet ------------------------
// Everything the wall needs to draw itself, as a plain object.
//
// Separated from the injection because there are two ways this gets on screen.
// Normally the worker injects showShield into the offending tab. But the setup
// page's "show me the wall" demo cannot work that way: chrome.scripting refuses
// to inject into chrome-extension:// pages, including the extension's own, so
// that request silently failed and fell through to a notification. The setup
// page now asks for this data and calls the wall on itself.
async function wallData(tabId, title, mode, tier) {
  const { todos, todoItems, apiKey, mission } = await getState();
  // The two-door wall: a verdict the tool is not certain of gets no
  // questionnaire. Never for a demo (it has nothing to price) and never inside
  // a session (the strict wall wins below).
  const doors = (tier === "medium" || tier === "low") && mode !== "demo";
  // The mission-derived lines join the universal pool rather than replacing it,
  // so the wall doesn't quote the same sentence at you every single time.
  const fomo = pick(mode === "unsure"
    ? UNSURE_LINES
    : FOMO_LINES.concat(missionLines(mission)));

  // Inside a focus session the wall has no way through it. Asking the questions
  // anyway and then refusing every answer would be worse than not asking: the
  // gauntlet's whole contract is that a genuine reason gets you in, and a
  // session is the user having decided in advance that today that contract is
  // suspended. So the strict wall states the terms and offers the two honest
  // actions — go back to work, or end the session you started.
  await loadSession();
  const strict = sessionActive();

  // The eyebrow above the question. "Off-task — blocked" reported a system
  // state, in the tool's language, about itself — the least interesting fact on
  // the screen. These name the thing being spent, which is the user's, not the
  // extension's. Kept to three or four words: it sits in 13px red above a
  // headline and is read in a glance, not parsed.
  const heading = strict
    ? "Focus session — no way past"
    : (mode === "unsure" || tier === "low") ? "Not sure this is work"
    : (tier === "medium") ? "This looks off-mission"
    : "This is costing you";

  // A strict wall asks nothing, so the AI question (a network round-trip) is
  // skipped entirely rather than generated and thrown away.
  // Every question here has to be one you cannot answer with "yes" and move on.
  //
  // "Is this on your to-do list right now?" was the old opener and it was the
  // weakest line on the screen: a yes/no with an obvious escape hatch, which
  // trains you to type the escape hatch. These ask for something you'd have to
  // invent — a name, a trade, a sentence you'd have to defend — because the
  // three seconds spent inventing it is where the decision actually happens.
  // The two-door wall asks nothing either, so its AI question — a network
  // round-trip — is skipped the same way.
  const questions = (strict || doors) ? [] : [
    // Opens on the cost, not on permission. "What" forces a noun; there is no
    // yes to hide behind.
    "What are you putting down to pick this up?",
    // Their own list, quoted at them. If nothing on it fits, they have to say
    // so in writing — which is the honest answer they came here to avoid.
    "Name the task on your list this moves forward.",
    // The lie has a deadline attached. Vague excuses die on the number.
    "How long will this take? Say the number out loud first.",
    await aiQuestion(title, todos, apiKey, mission),
    // Last, because it lands hardest after the three above have failed to
    // produce a good reason. Past tense on purpose: it's already spent.
    "It's an hour later. Was this worth it?"
  ];
  let host = "";
  let pageUrl = "";
  try {
    const t = await chrome.tabs.get(tabId);
    host = hostOf(t.url);
    // Carried so a captured note can link back to the page it came from. Only
    // http(s): a chrome:// or file:// URL is not a link worth putting on a task,
    // and it is the same test logTime already applies before keeping one.
    if (t.url && /^https?:/i.test(t.url)) pageUrl = t.url;
  } catch (e) {}

  // The very first wall a user ever sees arrives with no warning: the page they
  // were reading goes black and demands they justify themselves. Without a line
  // saying what this is, the honest reading is "something has hijacked my
  // browser" — and the reaction to that is uninstalling, not reflecting. Said
  // once, then never again; after the first time it's just noise in the way.
  // The setup demo must not consume this. It calls wallData() like any other
  // caller, so the counter was incremented before demoWall got a chance to mark
  // the result as a demo — meaning pressing "show me the wall" during setup
  // spent the one-time explainer, and the first REAL block then arrived without
  // the line that exists to stop it reading as a hijacked browser.
  const seen = await chrome.storage.local.get("wallsSeen");
  const wallsSeen = Number(seen.wallsSeen) || 0;
  if (mode !== "demo") chrome.storage.local.set({ wallsSeen: wallsSeen + 1 });

  // What walking away has already bought, over the last seven days. The goodbye
  // screen says what THIS one earned, but that lands after the decision is made;
  // the number that changes a mind has to be on screen while the choice is still
  // open. It's their own record, not a claim — and it only exists at all because
  // they've walked away before.
  const week = await savedThisWeek();

  // Everything the two doors need to state their prices before they are
  // pressed. A cost discovered after the fact is a penalty, not a price.
  let door = null;
  if (doors) {
    const ov = await overridesFor(host);
    const platform = learningPlatform(pageUrl);
    const w = await getWallet();
    // Why the tool thinks so, in one line. The wall is about to ask the user
    // to overrule a verdict; it owes them the verdict's grounds.
    const why = mode === "unsure"
      ? "The AI couldn't be reached, so this is a guess."
      : platform
        ? "It's a lesson on " + platform + ", but it read as off-mission."
        : ov.hostOverrides > 0
          ? "You've overruled the tool on this site before."
          // The plain case says nothing. "Judged against your mission and
          // today's 1 task" was true and gave the reader nothing to act on;
          // the wall reads better with one line fewer.
          : "";
    // Today's open tasks, {i, text} — the index is what comes back, exactly as
    // the countdown panel does it, so a task renamed while the wall is up
    // cannot be matched by a stale string.
    let openTasks = [];
    try {
      const d = await chrome.storage.local.get("todos");
      const list = Array.isArray(d.todos) ? d.todos : [];
      const today = todayKey();
      list.forEach((t, i) => {
        if (typeof t === "string") { openTasks.push({ i, text: t }); return; }
        if (!t || t.done) return;
        if (t.date && t.date > today) return;
        openTasks.push({ i, text: t.text || "" });
      });
      openTasks = openTasks.filter(t => t.text).slice(0, 8);
    } catch (e) {}
    door = {
      why,
      openTasks,
      taskCharge: WALL_TASK_CHARGE,
      oncePrice: oncePrice({ claimsToday: ov.claimsToday, tier }),
      onceMinutes: ONCE_MINUTES,
      claimsToday: ov.claimsToday,
      balance: w.balance
    };
  }

  return {
    heading, fomo, todos: todos || [], todoItems: todoItems || [], questions, host, title, pageUrl,
    // The two-door wall, and how sure the tool was. `tier` also rides on the
    // tab's lock mark so the once-door can be priced without trusting the page.
    doors, tier: tier || "hard", door,
    grantMinutes: Math.round(GRANT_MS / 60000),
    savedMinutes: SAVED_MINUTES_PER_BLOCK,
    firstEver: wallsSeen === 0,
    savedWeek: week,
    // Strict mode: no questions, no typing test, no appeal. The wall renders a
    // different screen entirely — see renderStrict() in wall.js.
    strict,
    sessionTask: strict ? (session && session.task) || "" : "",
    sessionLeftMs: strict ? sessionLeftMs() : 0,
    // How long the session was set for. The wall subtracts the live clock from
    // this to say how much has already been served — the one number that
    // actually argues against quitting, and it cannot be derived from
    // sessionLeftMs alone.
    sessionTotalMs: strict && session ? (session.until - session.startedAt) : 0,
    // Sent rather than read from a constant in wall.js: executeScript
    // serializes showShield alone, so anything at that file's scope does not
    // exist in the page it lands in.
    autoCloseSecs: SESSION_WALL_AUTO_CLOSE_SECONDS,
    // absolute extension URL — the wall is injected into arbitrary pages, so a
    // relative path would resolve against their origin
    mark: chrome.runtime.getURL("assets/logo-mark.png")
  };
}

// Warn that the wall is coming. Fire-and-forget: this is a courtesy, so a page
// that can't be injected into (a restricted URL, a tab that just closed) simply
// doesn't get one. It must never throw into the tick, and it deliberately does
// NOT fall back to a notification the way nudge() does — a system notification
// counting down to a block would be more alarming than the block itself.
async function headsUp(tabId, seconds, wallAt) {
  // The page's own URL and host travel with it, so a note written into the
  // panel records where it came from — the same provenance the wall's capture
  // screen carries. Read here rather than passed in, because the tick only
  // holds the title.
  let host = "", pageUrl = "", pageTitle = "";
  try {
    const t = await chrome.tabs.get(tabId);
    host = hostOf(t.url);
    if (t.url && /^https?:/i.test(t.url)) pageUrl = t.url;
    pageTitle = normalizeTitle(t.title || "");
  } catch (e) {}

  // Today's open tasks, so the panel can offer to attach this page to one you
  // already wrote instead of only ever making a new one. Sent as {i, text} —
  // the index is what comes back, so the worker never has to match on text and
  // a task renamed between opening the panel and answering cannot go astray.
  let openTasks = [];
  try {
    const d = await chrome.storage.local.get("todos");
    const list = Array.isArray(d.todos) ? d.todos : [];
    const today = todayKey();
    list.forEach((t, i) => {
      if (typeof t === "string") { openTasks.push({ i, text: t, hasLink: false }); return; }
      if (!t || t.done) return;
      if (t.date && t.date > today) return;          // not live yet
      openTasks.push({ i, text: t.text || "", hasLink: !!t.url });
    });
    openTasks = openTasks.filter(t => t.text).slice(0, 8);
  } catch (e) {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: showHeadsUp,
      // The price travels with the panel so it can state the cost while the
      // decision is still open, and cannot disagree with what is charged.
      args: [{ seconds, host, pageUrl, pageTitle, openTasks,
               // When the wall actually arrives, in the page's own clock terms.
               // `seconds` is kept alongside it as the fallback for a panel that
               // somehow receives no deadline, and as the denominator the ring
               // drains against.
               wallAt: Number(wallAt) || 0,
               lateCharge: LATE_TASK_CHARGE,
               // What closing the tab from here is worth, so the panel can say
               // it in the same terms the wall's goodbye screen uses rather
               // than hardcoding a number that could drift from the real one.
               savedMinutes: SAVED_MINUTES_PER_BLOCK }]
    });
  } catch (e) {}
}

// A pause has started — tell any live countdown panel to stand down.
//
// The panel counts down inside the page on its own timer and only ever learned
// about the wall ARRIVING (it checks for #__focusshield__ each tick). A pause
// means the wall is never sent, so without this the panel keeps ticking to zero
// on screen, threatening a block that has already been called off, and then
// vanishes on its 90s ceiling. The tool saying something is about to happen,
// the user doing the one thing that stops it, and the tool carrying on saying
// it, is the kind of small dishonesty that costs more trust than the feature
// was ever worth.
//
// Fire-and-forget, exactly like headsUp(): a restricted URL, a closed tab or a
// page with no panel must never turn into a failed pause. The pause is the
// user's decision and has already been recorded by the time this runs.
async function clearHeadsUp(minutesLeft, headline, subline) {
  let tabId = null;
  try {
    let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs[0]) tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) tabId = tabs[0].id;
  } catch (e) { return; }
  if (tabId == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: standDownHeadsUp,
      args: [Number(minutesLeft) || 0, headline || "", subline || ""]
    });
  } catch (e) {}
}

// Put the wall up on a real page. The tab is remembered first so a reload can be
// re-covered at document_start, then the overlay is injected.
// `tier` is from wallTierFor(): "hard" gets the questionnaire, anything else
// the two-door wall. Absent (an older caller) reads as hard.
async function nudge(tabId, title, streakSec, mode, tier) {
  // Cover the page BEFORE building the wall, not after.
  //
  // wallData() awaits aiQuestion(), which is a live API call to Groq or
  // OpenRouter. On a free tier that is one to four seconds, and it was being
  // spent with the page still fully visible — so the countdown reached zero,
  // said the block was happening, and then nothing happened for several
  // seconds. That gap is the worst possible moment to leave open: it is the
  // instant after a warning, on a page already judged a distraction, and it
  // teaches you that the number on the panel is approximate.
  //
  // showHold is the same document_start cover used for reloads: no
  // classification, no network, no state to await. It goes up immediately and
  // the real wall replaces it in place — showShield removes it by id on
  // arrival. If this injection fails (a restricted page) the wall attempt below
  // has its own notification fallback, so nothing is lost by trying.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: showHold });
  } catch (e) {}

  const data = await wallData(tabId, title, mode, tier);

  // Remember what this wall is standing on, so a reload can be re-covered at
  // document_start instead of flashing the page while the next tick thinks.
  // The tier travels with the mark: the once-door is priced worker-side from
  // it, and the page must not be the one to say how sure the tool was.
  if (data.host) { lockedTabs.set(tabId, { host: data.host, title, tier: data.tier || "hard" }); persistLocks(); }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: showShield,
      args: [data]
    });
  } catch (e) {
    // One notification per tab, replaced rather than stacked.
    //
    // The id used to carry Date.now(), which makes every re-assert a NEW
    // notification — and with requireInteraction they never dismiss themselves.
    // On a page that cannot be injected into (view-source:, a restricted URL)
    // the wall fails every time, so these accumulated in the tray indefinitely.
    // A stable per-tab id means Chrome replaces the existing one instead.
    chrome.notifications.create("focus_nudge_tab_" + tabId, {
      type: "basic", iconUrl: "assets/icon128.png", title: "Nice Try",
      message: data.fomo, priority: 2, requireInteraction: true
    });
  }
}


// ---- daily "what's today for?" nudge ------------------------------
// An empty task list is the single biggest thing holding the classifier back:
// the list overrides every other verdict, so a day with tasks blocks far more
// accurately than a day without. The popup asks too, but only of someone who
// opens it — and the day you never open it is exactly the day nobody asked.
//
// Once per day, at most. Clicking through opens the popup's own prompt.
async function nudgeForTasks() {
  const day = todayKey();
  const d = await chrome.storage.local.get(["taskNudgeDay", "dayPromptDismissed"]);
  if (d.taskNudgeDay === day) return;              // already asked today
  if (d.dayPromptDismissed === day) return;        // dismissed in the popup

  const { todos, mission, apiKey } = await getState();
  if (todos.length) return;                        // nothing to ask about

  // Setup still unfinished: the popup is already showing a checklist about it,
  // and a notification asking for tasks on top of that is one demand too many
  // on a first run.
  if (!mission && !apiKey) return;

  // Mark BEFORE firing. A notification that fails to create should still not
  // re-fire every three seconds for the rest of the day.
  await chrome.storage.local.set({ taskNudgeDay: day });

  try {
    chrome.notifications.create("focus_tasks_" + day, {
      type: "basic",
      iconUrl: "assets/icon128.png",
      title: "What's today for?",
      message: "No tasks set. With an empty list the wall can't tell your work " +
               "from a distraction — add one from the toolbar.",
      priority: 1
    });
  } catch (e) {}
}

// ---- main poll loop ----------------------------------------------
async function tick() {
  if (ticking) return;          // serialize: never let two ticks race on storage
  ticking = true;
  try {
    await doTick();
  } catch (e) {
    log("[GS] tick error", e);
  } finally {
    ticking = false;
  }
}

async function doTick() {
  const { enabled } = await getState();
  if (!enabled) {
    log("[GS] disabled");
    await noteOffState(OFF_DISABLED);
    await beatDown("off");
    // Belt and braces: if anything else repainted the action since the
    // transition (or the worker restarted into this state), put the grey
    // icon back. noteOffState only paints when the reason CHANGES.
    if (lastBadge !== "off") await paintIcon();
    return;
  }

  // No host access = no reading titles, no injecting walls. The extension is
  // genuinely inert until the user grants it, rather than half-running and
  // failing at the point it matters. The popup surfaces this as a setup step,
  // so this is a silent return and not an error.
  if (!(await hasHostAccess())) {
    log("[GS] no host permission — standing down");
    await noteOffState(OFF_NOACCESS);
    return;
  }

  // A finished session is banked here rather than on a timer, so it lands even
  // if the worker was suspended across the end time.
  await loadSession();
  await reapSession();

  // Paused: the wall is down and the coins stop, but the clock keeps running.
  // Time is still attributed (by rules and cache only — no AI calls) so the
  // scoreboard can show the hour you bought rather than a hole where it was.
  //
  // A running session outranks it. The pause exists so a frustrated moment
  // doesn't end with the tool switched off forever; a session is the opposite —
  // a decision made in advance that the next 25 minutes are not negotiable. If
  // a pause could suspend a session then the session's whole promise would be
  // "strict, unless you press the 30-min button", which is no promise at all.
  await loadPause();
  const paused = isPaused() && !sessionActive();
  if (paused) {
    // Not an early return any more. A pause stands the WALL down and stops
    // the coins — it does not stop the clock. The tick used to bail out here,
    // so an hour bought at the pause store simply vanished from the
    // scoreboard: the stretch of the day most worth seeing was the one it
    // could not show. Presence and time attribution carry on below; every
    // step that judges, pays or blocks is gated on this flag instead.
    resetStreak();
    updatePauseBadge();
    await beatDown(pauseKind || "free");
  }
  // pause just ended — clear the badge. lastTickTs is left alone: the paused
  // stretch was counted, so there is no gap to avoid back-filling. The
  // downtime episode closes at the pause's own deadline, not at this tick.
  if (pausedUntil && !isPaused()) {
    const cap = pausedUntil;
    pausedUntil = 0; pauseKind = ""; persistPause(); updatePauseBadge();
    await closeDown(cap);
  }

  // Outside a scheduled window the tool stands down completely, exactly like a
  // pause. A session overrides this too: starting one at 9pm on a 9-5 schedule
  // is an explicit choice to work now, and refusing it would be the schedule
  // arguing with the user in front of it.
  if (!sessionActive()) {
    const { schedule } = await getState();
    if (!scheduleActiveAt(schedule, new Date())) {
      lastTickTs = 0;
      resetStreak();
      await noteOffState(OFF_SCHEDULE);
      updatePauseBadge();
      log("[GS] outside scheduled hours — standing down");
      return;
    }
  }

  // Past every stand-down check: the tool is genuinely running.
  await noteOffState(OFF_NONE);

  let tab;
  try {
    let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs[0]) tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
  } catch (e) { log("[GS] tabs.query failed", e); return; }
  if (!tab || !tab.title) { log("[GS] no active tab/title"); return; }

  // Are you actually sitting here? If Chrome is behind another app, minimised,
  // or the screen is locked, this tab costs nothing: no time logged, no
  // streak, no AI call. A tab you opened and left is invisible to us. A tab
  // you are silently WATCHING is not — see userIsPresent().
  if (!(await userIsPresent())) {
    lastTickTs = 0;          // don't back-count the away period on return
    log("[GS] away — not counting");
    return;
  }

  // real elapsed time since the last accounted tick (not a fixed POLL_SECONDS).
  // This fixes inflated tracking: many ticks in one second add ~0s, not 3s each.
  const now = Date.now();
  let elapsed = lastTickTs ? (now - lastTickTs) / 1000 : POLL_SECONDS;
  if (elapsed > 15) elapsed = POLL_SECONDS;   // worker was asleep — don't count the gap
  if (elapsed < 0) elapsed = 0;
  lastTickTs = now;

  // Everything above this line is a stand-down check, so reaching here means
  // the tool is armed AND you are actually at the machine — which is exactly
  // what the coins are paying for. Credited before classification so it pays
  // for the tool being ON, not for the verdict being flattering: coins you
  // only earn on approved pages would just be the focus score again.
  //
  // Except while paused. The clock runs through a pause (see above) but the
  // coins do not: they pay for the tool being ON, and a pause is the tool
  // being off by the minute. Paying here would also make the pause store
  // profitable, which is the one invariant the economy cannot survive.
  if (!paused) await earnFromArmedTime(elapsed);

  // Rehydrate the streak before any of the counters below are read. A fresh
  // worker starts at zero, and without this the 30s grace restarted every time
  // Chrome suspended us — see loadStreak().
  await loadStreak();

  const title = tab.title;
  // dwell = uninterrupted PRESENT time on this same title; resets when it changes
  const titleKey = normalizeTitle(title);
  if (titleKey !== lastTitle) { dwellSeconds = 0; lastTitle = titleKey; }
  dwellSeconds += elapsed;

  // Rules and cache only during a pause. The verdict decides where the time
  // is filed, nothing more — no wall is coming — and an AI call spent on a
  // tool the user has switched off for the hour is a call they did not ask for.
  const category = await classify(title, tab.url, dwellSeconds, paused);

  // Is this tab in the window where a verdict is coming but hasn't landed? Only
  // true for genuinely undecided pages: anything the rules or the cache settled
  // instantly is never "being watched", so the dot doesn't appear on every tab.
  watching = !paused && (category === "neutral") &&
             dwellSeconds >= (AI_AFTER_SECONDS / 2) &&
             !(await cachedVerdict(normalizeTitle(title).toLowerCase()));
  log("[GS] \"" + title + "\" → " + category +
              " | dwell=" + Math.round(dwellSeconds) + "s" +
              " | streak=" + Math.round(junkStreak) + "s");

  // log time: "unsure" counts toward junk for the scoreboard (it's un-verified time)
  const logBucket = (category === "unsure") ? "junk" : category;
  await logTime(logBucket, elapsed, title, tab.url, paused);

  // both "junk" and "unsure" get nudged; "unsure" shows the self-check variant
  // — never during a pause, which is the whole point of one.
  if (!paused && (category === "junk" || category === "unsure")) {
    // First time this tab is judged junk, credit the time already spent here.
    // Without this the AI's 30s wait would push the lock out to 30+45=75s;
    // with it, the lock still lands at ~GRACE_SECONDS of real presence.
    if (junkStreak === 0 && dwellSeconds > elapsed) junkStreak = dwellSeconds - elapsed;
    junkStreak += elapsed;

    // Reloading the page destroys the injected overlay, but the worker's state
    // survives — so the re-assert timer used to hand out a free RENUDGE_SECONDS
    // window on every reload, repeatable forever. Ask the page whether the wall
    // is actually still there instead of inferring it from a timer.
    let wallUp = false;
    if (lastNudgeAt > 0) {
      wallUp = await wallPresent(tab.id);
      if (!wallUp) {
        // it's gone and this tab is still junk — the grace period was already
        // served, so re-lock now rather than waiting out another window
        log("[GS] wall missing (reload?) — re-locking immediately");
        lastNudgeAt = 0;
      }
    }

    // The warning, in the last stretch before the wall. Only ahead of the FIRST
    // wall on this tab: a re-assert is the wall coming back to a page you
    // already dismissed it on, which is not an ambush and needs no warning.
    //
    // headsUpAt is checkpointed alongside the streak, so a worker that dies
    // mid-approach doesn't warn you a second time on the way to the same wall.
    // No upper bound on the streak here, deliberately. The back-credit above
    // can land junkStreak PAST GRACE_SECONDS in a single tick — a verdict that
    // takes 30s or more to arrive does exactly that — and a "< GRACE_SECONDS"
    // condition then skipped the warning entirely and dropped the wall with no
    // notice at all. That is the precise ambush this feature exists to remove,
    // surviving in the one case where the tool was slowest to make up its mind.
    // Every first wall gets a warning; the floor below decides how long.
    // Never during a session. The panel exists to make the wall feel like a
    // rule rather than an ambush — a fair trade when the wall is negotiable,
    // and the panel's own offer proves it: "Add to my tasks" spends coins and
    // CALLS OFF the block. A session is the state where nothing buys you past,
    // so the panel would be offering a way out that the wall behind it refuses
    // to honour. The session wall is not an ambush either way: you set it
    // yourself, minutes ago, and it announces its own countdown on arrival.
    if (!sessionActive() && !wallUp && lastNudgeAt === 0 &&
        junkStreak >= GRACE_SECONDS - HEADSUP_SECONDS && !headsUpAt) {
      headsUpAt = junkStreak;
      // How long is actually left, floored at something you can type into.
      //
      // The streak does not always climb smoothly to this point. A title the
      // rules can't settle waits AI_AFTER_SECONDS for a verdict, and when that
      // verdict lands the line above back-credits the whole dwell in one tick —
      // so junkStreak can arrive here already at ~23s, and the honest
      // "GRACE_SECONDS - junkStreak" was then 7. Seven seconds is not an offer,
      // it is a taunt: too short to read the prompt and write a sentence, so
      // the panel appeared, demanded an answer, and left before one was
      // possible.
      //
      // Below the floor the wall is DELAYED to match, rather than the panel
      // lying about how long is left. A countdown that says 15 and blocks at 7
      // would be worse than the bug it replaces.
      let left = Math.round(GRACE_SECONDS - junkStreak);
      if (left < HEADSUP_MIN_SECONDS) {
        // Push the wall out so the number on screen stays true. lastNudgeAt is
        // untouched — this moves the deadline, not the grace period's meaning.
        wallDeferUntil = Date.now() + HEADSUP_MIN_SECONDS * 1000;
        left = HEADSUP_MIN_SECONDS;
      }
      // The deadline itself, not just the size of the gap.
      //
      // The panel used to be handed a count of seconds and left to decrement it
      // once per setInterval fire. That is not a clock: a background or busy tab
      // throttles the interval, so eighteen fires could span twenty-five real
      // seconds, and the ring read 9 while the wall was already due. The two
      // sides drifted apart in one direction only — the worker measures
      // Date.now() deltas and does not drift, so every throttled second the
      // panel missed was a second of the ring lying in the tool's favour.
      //
      // Sending the wall's actual arrival time makes the panel's number derived
      // rather than counted: however badly its timer is throttled, each repaint
      // recomputes against the same deadline the worker is enforcing, so a
      // missed tick shows up as the number jumping — which is the truth —
      // instead of the countdown quietly running slow.
      //
      // One POLL_SECONDS of slack is included because the wall lands on the
      // next tick AFTER the deadline passes, not on the deadline itself.
      // Without it the panel sat at 0 for up to three seconds on every single
      // approach, which is the most visible moment it could be wrong.
      const wallAt = Math.max(wallDeferUntil, Date.now() + left * 1000) +
                     POLL_SECONDS * 1000;
      log("[GS] ⏳ heads-up: " + left + "s to the wall on tab " + tab.id);
      await headsUp(tab.id, left, wallAt);
    }

    // A deferred wall is one the panel promised more time for. Honoured as a
    // condition rather than an early return, so the rest of the tick — the
    // task nudge, the badge, the streak checkpoint — still runs.
    let deferred = false;
    if (wallDeferUntil) {
      if (Date.now() < wallDeferUntil) deferred = true;
      else wallDeferUntil = 0;
    }

    const dueFirst = (lastNudgeAt === 0 && junkStreak >= GRACE_SECONDS);
    const dueAgain = (lastNudgeAt > 0 && (junkStreak - lastNudgeAt) >= RENUDGE_SECONDS);
    if (!wallUp && !deferred && (dueFirst || dueAgain)) {
      lastNudgeAt = junkStreak;
      // Which wall. verdictBasis was set by the classify() call above in this
      // same tick, so it describes exactly the verdict being enforced here.
      const host = hostOf(tab.url);
      const { todos } = await getState();
      const ov = await overridesFor(host);
      const tier = wallTierFor(category, verdictBasis, {
        platform: learningPlatform(tab.url),
        hostOverrides: ov.hostOverrides,
        todosCount: todos.length,
        // Set by the same classify() call above that set verdictBasis.
        score: lastScore
      });
      log("[GS] 🔒 " + (category === "unsure" ? "SELF-CHECK" : "LOCKING") + " tab " + tab.id +
          " (" + (verdictBasis || "?") +
          (lastScore >= 0 ? " " + lastScore : "") + " → " + tier + ")");
      await nudge(tab.id, title, junkStreak, category, tier);
    }
    // Written on every junk tick, deliberately.
    //
    // A throttle was tried here and rejected: the re-nudge test compares
    // junkStreak against lastNudgeAt, so any checkpoint the next worker
    // rehydrates from that is not the CURRENT value shifts every subsequent
    // re-nudge. Simulating a 45s worker lifetime, a 6-second checkpoint moved
    // the wall times from 27,72,102,147… to 27,75,123,153… — a visible change
    // in when the wall re-asserts, which is exactly what must not move.
    //
    // The cost of writing is small and bounded: it is one storage.session key
    // (memory-backed, not disk), written only while a junk tab is actually on
    // screen and only every POLL_SECONDS. Ticks on productive or neutral pages
    // write nothing, and the reset branch below writes once on the transition
    // rather than repeatedly.
    persistStreak();
  } else {
    if (junkStreak || lastNudgeAt || headsUpAt || dwellSeconds) {
      junkStreak = 0;
      lastNudgeAt = 0;
      headsUpAt = 0;
      wallDeferUntil = 0;      // the wall it was holding back is no longer coming
      holdWindowStart = 0;     // and the typing budget resets with the streak
      persistStreak();
    }
  }

  // Once a day, if the list is empty, say so. The popup carries the same prompt
  // but only reaches someone who opens it — and the day this matters most is
  // the day you never think about the tool at all.
  await nudgeForTasks();

  // Countdown on the toolbar icon while a grant is running, so the borrowed
  // time is visible instead of just ending. Without this the block returning
  // feels arbitrary — you never saw the clock.
  updatePauseBadge();

  // note: lastTitle is set above (normalized) as part of dwell tracking —
  // do not overwrite it with the raw title here or dwell resets every tick.
  lastTabId = tab.id;
}

// ---- scheduling ---------------------------------------------------
// chrome.alarms can't fire faster than every 60s, so we use a
// self-scheduling setTimeout loop for the fast poll, and a 1-min
// alarm purely as a keep-alive to wake the service worker if it sleeps.
let loopHandle = null;
async function pollLoop() {
  try { await tick(); } catch (e) { /* keep looping */ }
  loopHandle = setTimeout(pollLoop, POLL_SECONDS * 1000);
}
function startLoop() {
  if (loopHandle) clearTimeout(loopHandle);
  pollLoop();
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create("keepAlive", { periodInMinutes: 1 });
  pruneTaskHostAllows();
  startLoop();
  // Setup is not really optional: with no mission and no key the classifier
  // falls back to a fixed keyword list, which is the blunt domain blocker this
  // tool exists to replace. Nothing prompted the user toward it before — the
  // extension installed silently and did nothing visible — so the one thing
  // that makes it worth having was reachable only by accident.
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("ui/welcome.html") });
  }
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("keepAlive", { periodInMinutes: 1 });
  pruneTaskHostAllows();
  reassertOffPaint();
  startLoop();
});
// keep-alive: if the worker was asleep, this wakes it and the loop resumes
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepAlive") { tick(); startLoop(); }
});

// A restarted worker begins with offReason = OFF_NONE and the default colour
// icon, regardless of what the switch actually says. Chrome tears the worker
// down after ~30s idle, so without this a switched-off extension spends most
// of its life LOOKING armed — the exact failure the grey icon exists to fix.
// Runs at top level so it lands on every worker start, not just a browser one.
reassertOffPaint();

// The switch is written by the popup, so the worker learns about it through
// storage rather than a message. Repainting here makes the icon change the
// instant the toggle moves, instead of on the next poll.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.enabled) return;
  if (changes.enabled.newValue === false) { noteOffState(OFF_DISABLED); return; }
  // Switched back ON. Do NOT assign offReason directly and repaint: the switch
  // is only one of the things that can stand the tool down, and claiming
  // "running" here painted the icon blue for a few milliseconds before the
  // tick found the REAL reason and greyed it again — a flicker that read as
  // the button not working.
  //
  // Re-deriving instead means the icon goes blue only when the tool can
  // genuinely run, and stays grey with the right tooltip when it can't.
  // reassertOffPaint() clears offSince on the way through noteOffState, so
  // the "how long has it been off" clock is reset properly too.
  (async () => {
    try {
      // Refresh the cached answer by REPLACING it, not by nulling it. Setting
      // it to null leaves a window in which doTick() — which runs every 3s and
      // reads this same variable — sees "unknown" and re-derives concurrently.
      // The two then raced, and the icon could end up painted from whichever
      // finished last, which is how it stayed grey while the popup said the
      // tool was watching.
      try {
        hostAccess = await chrome.permissions.contains({ origins: ["<all_urls>"] });
      } catch (e) { /* keep the previous answer rather than a null hole */ }
      await reassertOffPaint();
      tick();
    } catch (e) { /* never let a listener reject: it kills the worker */ }
  })();
});

// tick immediately on tab switches / title changes for snappy reset + detect
chrome.tabs.onActivated.addListener(() => tick());
chrome.tabs.onUpdated.addListener((id, info) => { if (info.title || info.status === "complete") tick(); });

// ---- reload re-assert -------------------------------------------------
// A reload destroys the injected wall, and the worker only rebuilt it on the
// next tick — after the AI round-trip. That left the blocked page visible for
// a second or two, which is a free look at exactly the thing being blocked,
// repeatable by holding F5. The tab a locked wall was standing on is
// remembered here, so a reload of THAT tab is re-covered at document_start,
// before the page gets to paint. The cover is deliberately dumb: no
// classification, no network, no awaiting state — it must land in the same
// turn the navigation commits or it is useless.
// Persisted, not just in memory. An MV3 service worker is killed after ~30s
// idle, and an in-memory Map died with it — so the first reload after a short
// pause found no mark and let the page through, which is exactly the bug this
// exists to close. chrome.storage.session survives worker restarts, is cleared
// when the browser closes (a stale lock must never outlive the session), and
// is never exposed to page scripts.
const lockedTabs = new Map();   // tabId -> { host, title } — hot cache

async function loadLocks() {
  try {
    const d = await chrome.storage.session.get("lockedTabs");
    const saved = d.lockedTabs || {};
    for (const id in saved) lockedTabs.set(Number(id), saved[id]);
  } catch (e) {}
}
function persistLocks() {
  const out = {};
  lockedTabs.forEach((v, k) => { out[k] = v; });
  try { chrome.storage.session.set({ lockedTabs: out }); } catch (e) {}
}
// Every listener below may be the first thing to run in a freshly-started
// worker, so each one rehydrates before reading the map.
const locksReady = loadLocks();

// Injected bare, before the page's own scripts run. It only has to make the
// viewport opaque; the real wall replaces it on the tick that follows.
function showHold() {
  if (document.getElementById("__focusshield__")) return;
  if (document.getElementById("__fshold__")) return;
  // A grant just landed — this reload is allowed through.
  if (window.__fsGrantedAt && (Date.now() - window.__fsGrantedAt) < 8000) return;
  var d = document.createElement("div");
  d.id = "__fshold__";
  d.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#000000;" +
    "display:flex;align-items:center;justify-content:center;" +
    "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,sans-serif;" +
    "color:rgba(235,235,245,.60);font-size:15px;letter-spacing:-.01em";
  d.textContent = "Nice try.";
  (document.documentElement || document).appendChild(d);
  // The page is still parsing, so <body> may not exist yet and the node can be
  // lost when the parser replaces the document element. Re-attach until the
  // real wall (or a grant) takes over.
  var keepDone = false;
  var keep = setInterval(function () {
    if (document.getElementById("__focusshield__")) { clearInterval(keep); keepDone = true; d.remove(); return; }
    if (!d.isConnected && document.documentElement) document.documentElement.appendChild(d);
  }, 50);
  setTimeout(function () { clearInterval(keep); keepDone = true; }, 15000);
  // Opaque was not enough. The cover lands before the page's scripts, but the
  // page still boots behind it, and YouTube starts playing the moment its
  // player is ready — seconds before the real wall (and its media freeze)
  // arrives after the AI round-trip. So a hard refresh on a walled video
  // showed a black screen with the video's audio playing behind it. Same
  // pause the wall runs, at the same cadence, until the wall takes over. It
  // keeps going while the cover stands: a black screen with sound is worse
  // than either alone.
  var hush = setInterval(function () {
    if (document.getElementById("__focusshield__") || (keepDone && !d.isConnected)) { clearInterval(hush); return; }
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {}
    try { if (document.pictureInPictureElement) document.exitPictureInPicture(); } catch (e) {}
    document.querySelectorAll("video,audio").forEach(function (m) {
      try { if (!m.paused) m.pause(); } catch (e) {}
    });
  }, 250);
}

async function onNavigated(details, isSpa) {
  if (details.frameId !== 0) return;             // main frame only
  if (!(await hasHostAccess())) return;          // nothing to re-cover without access

  // A reprieve lasts until you leave the page it was claimed on, so leaving is
  // what ends it. Released here rather than on a timer because "until you
  // navigate away" is the actual promise, and a timer would either cut a long
  // lecture short or keep exempting a page abandoned an hour ago.
  //
  // This runs BEFORE the lockedTabs early-return below: a reprieved page was
  // never walled, so it has no lock, and releasing after that return would mean
  // reprieves were never released at all.
  //
  // The identity of the page being LEFT is not in `details` — that carries
  // where you are going. So every reprieve except the one for the destination
  // is dropped: navigating anywhere ends every other page's reprieve, while a
  // reload or an in-page jump that lands on the same identity keeps its own.
  // That is the correct reading of "until you leave" and it needs no memory of
  // where you were.
  await loadReprieves();
  if (reprieved.size) {
    const to = linkIdentity(details.url);
    let changed = false;
    for (const id of Array.from(reprieved.keys())) {
      if (id !== to) { reprieved.delete(id); changed = true; }
    }
    if (changed) { persistReprieves(); log("[GS] reprieve released on navigate"); }
  }

  await locksReady;
  const mark = lockedTabs.get(details.tabId);
  if (!mark) return;
  // Navigating AWAY to a different site is the outcome we want — let it go.
  if (hostOf(details.url) !== mark.host) {
    lockedTabs.delete(details.tabId); persistLocks(); return;
  }
  // A pushState within the same host did NOT tear the document down, so the
  // wall (if any) is still standing and the hold cover would only black out a
  // page that is already covered. But the PAGE changed underneath it, so the
  // streak has to re-arm: without this, clicking from one walled video to the
  // next left "already nudged" set and the new page rode out the old grant.
  if (isSpa) {
    await loadStreak();
    lastNudgeAt = 0;
    persistStreak();
    tick();
    return;
  }
  // A grant is running — the pause is loaded from storage first, because a
  // restarted worker has pausedUntil=0 and would re-cover a page you just paid
  // for. This is the one await before injecting, and it is a local read.
  await loadPause();
  if (isPaused()) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      func: showHold,
      injectImmediately: true
    });
  } catch (e) { /* restricted page — the normal tick still handles it */ }
  // The wall is gone with the old document, so the next tick must rebuild it
  // rather than seeing a stale "already nudged" timer. Persisted along with the
  // streak it belongs to: this listener can be the first thing a fresh worker
  // runs, and leaving the stored copy saying "already nudged" would hand the
  // reload the free grace window showHold exists to close.
  await loadStreak();
  lastNudgeAt = 0;
  persistStreak();
  tick();
}

chrome.webNavigation.onCommitted.addListener((d) => onNavigated(d, false));
// Same-document navigation: a YouTube video-to-video click never fires
// onCommitted, so a walled tab could move to a different page while the worker
// still believed it had already nudged the old one.
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => onNavigated(d, true));

chrome.tabs.onRemoved.addListener((id) => {
  if (lockedTabs.delete(id)) persistLocks();
  // A requireInteraction notification outlives the tab it was about, so it has
  // to be cleared explicitly or it sits in the tray pointing at nothing.
  try { chrome.notifications.clear("focus_nudge_tab_" + id); } catch (e) {}
});

// Clicking the daily task nudge should land you where the tasks are. openPopup
// is the right destination but is not available everywhere (and only works
// from a user gesture in some builds), so a failure falls back to the setup
// page, which carries the same "what are you working on today" field.
chrome.notifications.onClicked.addListener((id) => {
  if (!String(id).startsWith("focus_tasks_")) return;
  try { chrome.notifications.clear(id); } catch (e) {}
  const openFallback = () => {
    try { chrome.tabs.create({ url: chrome.runtime.getURL("ui/welcome.html") }); } catch (e) {}
  };
  try {
    if (chrome.action && chrome.action.openPopup) {
      const p = chrome.action.openPopup();
      // Promise-returning on newer builds, callback-style on older ones —
      // guard both rather than assuming a shape.
      if (p && typeof p.catch === "function") p.catch(openFallback);
    } else {
      openFallback();
    }
  } catch (e) { openFallback(); }
});

// kick the loop the moment this worker script loads
pruneTaskHostAllows();
startLoop();

// ---- messages from popup -----------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // gauntlet passed → grant a global stand-down and reset the streak so it
  // doesn't immediately re-lock. When the grant expires, classify() sees junk again.
  // page finished the questions → judge the answers, return verdict (+ a fresh
  // 15-word sentence in case the user failed and must do the typing test).
  if (msg.type === "judgeAnswers") {
    (async () => {
      const { todos, apiKey, mission } = await getState();
      log("[GS] judgeAnswers received:", JSON.stringify(msg.answers));
      let verdict = { pass: false, reason: "" };
      try {
        verdict = await aiJudgeAnswers(msg.title || "", msg.questions || [], msg.answers || [], todos, apiKey, mission);
      } catch (e) { log("[GS] judge handler error:", String(e.message || e)); }
      log("[GS] → responding pass=" + verdict.pass);
      sendResponse({ pass: verdict.pass, reason: verdict.reason, sentence: makeSentence(15) });
    })();
    return true;
  }

  // page needs a fresh set of 15 words (failed the 3-min timer, retrying)
  if (msg.type === "newSentence") {
    sendResponse({ sentence: makeSentence(15) });
    return true;
  }

  // A task's link, clicked from the wall. Opened in a NEW tab and focused, so
  // the blocked tab stays blocked behind it — walking away from the distraction
  // rather than trading it for another one.
  if (msg.type === "openTask") {
    const url = String(msg.url || "");
    // Only ever open a link that genuinely belongs to one of today's open
    // tasks. The message comes from a script running inside a blocked page, so
    // the URL is checked against stored state rather than trusted.
    (async () => {
      const { todoItems } = await getState();
      const known = todoItems.some(t => t.url && t.url === url);
      if (!known) { log("[GS] openTask refused — not a task link"); return; }
      if (!/^https?:\/\//i.test(url)) { log("[GS] openTask refused — bad scheme"); return; }
      try { await chrome.tabs.create({ url, active: true }); } catch (e) {}
    })();
    return;
  }

  // "Leave — I don't need this" → close the tab entirely
  // Sent the moment Leave is pressed, ahead of the goodbye message. Separate
  // from closeTab so the credit is recorded exactly once even if the tab is
  // closed by hand while that message is still on screen — closeTab may never
  // arrive, or may arrive after the tab is already gone.
  if (msg.type === "leaving") {
    const tid = sender && sender.tab && sender.tab.id;
    (async () => {
      // Credit is tied to a wall that actually stood, not to a timer.
      //
      // leftTabs alone was an in-memory Set with a 10s TTL, and every other
      // guard in this file is deliberately persisted because MV3 kills the
      // worker after ~30s idle. That made the walk-away award farmable three
      // separate ways — worker restart, TTL expiry, and one payment per tab —
      // at roughly 30 coins a minute, which is five hours of honest armed time
      // for one minute of clicking. A balance that can be printed that fast
      // makes the whole scoreboard worthless, which is the one thing this
      // economy exists to avoid.
      //
      // lockedTabs is the record of a wall this worker actually put up, it
      // already survives worker death in storage.session, and it is already
      // deleted on grant/appeal/tab-close. Consuming the mark here makes the
      // credit exactly-once structurally: no mark, no wall, no payment.
      // locksReady is the module-load hydration; awaiting it is enough. Calling
      // loadLocks() again would merge the stored copy back over the live map and
      // could resurrect a mark this worker had already consumed.
      await locksReady;
      if (tid != null) {
        if (!lockedTabs.has(tid)) { log("[GS] leaving ignored — no wall was up"); return; }
        lockedTabs.delete(tid);
        persistLocks();
      }
      // The in-memory set stays as a cheap same-turn double-send guard.
      if (tid != null && leftTabs.has(tid)) return;
      if (tid != null) {
        leftTabs.add(tid);
        setTimeout(() => leftTabs.delete(tid), 10000);
      }
      await logSaved(hostOf(sender && sender.url ? sender.url : ""));
    })();
    return;
  }

  if (msg.type === "closeTab") {
    if (sender && sender.tab && sender.tab.id != null) {
      try { chrome.tabs.remove(sender.tab.id); } catch (e) {}
    }
    return;
  }

  // Closing the tab from the countdown panel, BEFORE any wall stood.
  //
  // This is the best outcome the tool has — you were warned, and you left
  // without needing to be blocked — so it is credited like a walk-away rather
  // than treated as an ordinary tab close. It cannot go through the "leaving"
  // handler above: that one is deliberately gated on lockedTabs holding a mark,
  // which only exists once a wall has actually been injected. From the panel
  // there is no mark, so leaving would be correctly ignored and pay nothing.
  //
  // The anti-farming property is kept by a different route: the junk streak is
  // reset and the tab is closed immediately, so there is no page left to press
  // it on again. leftTabs still guards a same-turn double-send.
  if (msg.type === "quitEarly") {
    const tid = sender && sender.tab && sender.tab.id;
    (async () => {
      if (tid != null) {
        if (leftTabs.has(tid)) return;
        leftTabs.add(tid);
        setTimeout(() => leftTabs.delete(tid), 10000);
      }
      // A wall may never stand on this tab now, so its mark (if any) goes too.
      await locksReady;
      if (tid != null && lockedTabs.delete(tid)) persistLocks();
      resetStreak();
      await logSaved(hostOf(sender && sender.url ? sender.url : ""));
      log("[GS] 👋 quit from the countdown — credited as a walk-away");
      if (tid != null) { try { await chrome.tabs.remove(tid); } catch (e) {} }
    })();
    return;
  }

  if (msg.type === "grantAccess") {
    // Derive the host from the SENDER's real URL, never from the message body —
    // otherwise any script in a blocked page can post {host:"youtube.com"} and
    // grant itself access. msg.host is only a fallback for senders with no URL.
    const host = hostOf(sender && sender.url ? sender.url : "") || msg.host;
    // ONLY cache the title as productive when the AI genuinely approved it.
    // Forcing in via the typing test is an override, not an endorsement — it is
    // never remembered, so you must justify the same title again next time.
    // The title comes from the sender's real tab, not the message body, so a
    // page can't poison the cache for a title it doesn't actually have.
    (async () => {
      // The grant is set INSIDE this async block, after the state it depends on
      // has been hydrated. Setting pausedUntil synchronously above was a real
      // bug: an MV3 worker is killed after ~30s idle, so by the time a wall is
      // answered the worker is often a fresh one with pauseLoaded=false and
      // pausedUntil=0. Writing the grant first and letting a later loadPause()
      // run would overwrite the three minutes just earned with the stale value
      // from storage — the user pays the gauntlet and is walled again seconds
      // later. loadSession() is awaited for the same reason: sessionActive()
      // read against an unhydrated `session` reports false and would let a
      // strict wall grant access.
      await loadPause();
      await loadSession();
      // A strict wall offers no route here, but the message is sent from a page
      // and must not be trusted to have come from one. Refusing during a session
      // closes the gap between "the UI doesn't offer it" and "it can't happen".
      if (host && !sessionActive()) {
        pausedUntil = Date.now() + GRANT_MS;   // whole extension stands down
        pauseKind = "grant";
        persistPause();
        await openDown("grant");
        updatePauseBadge();
        log("[GS] ✅ " + (msg.legit ? "AI-approved" : "typing-test") + " access to " + host +
            " for " + Math.round(GRANT_MS / 60000) + " min");
      }

      let realTitle = "";
      if (sender && sender.tab && sender.tab.id != null) {
        try { realTitle = (await chrome.tabs.get(sender.tab.id)).title || ""; } catch (e) {}
      }
      let key = "";
      if (msg.legit && realTitle) {
        key = await cacheKeyFor(normalizeTitle(realTitle).toLowerCase());
        rememberVerdict(key, "productive");
        persistCache();
        log("[GS] 🧠 remembered AI-approved title");
      }
      // Record BOTH kinds of pass — the typing-test ones matter most here,
      // since those are the times you overrode the block rather than earned it.
      await recordAccess(host, realTitle || msg.title || "", msg.legit ? "answers" : "typing", key);
    })();
    resetStreak();
    // The wall came down legitimately — stop re-covering this tab's reloads.
    if (sender && sender.tab && sender.tab.id != null && lockedTabs.delete(sender.tab.id)) persistLocks();
    if (sendResponse) sendResponse({ ok: true, host });
    return true;
  }

  // "This was flagged by mistake" — the appeal, from the typing-test screen.
  //
  // This is the only path that can turn a junk verdict into a productive one
  // without the AI agreeing, and that is the point: title-only classification
  // misfires, and the alternative remedy was typing fifteen words to reach a
  // page that was never a distraction. It writes the corrected verdict to the
  // same cache the classifier reads, so the page stops being walled rather than
  // being let through once.
  //
  // The correction is kept (capped) so the misfires are inspectable — a list of
  // "what it got wrong, and why" is the one artefact that can actually sharpen
  // the rules, and it is the user's own data, held locally like everything else.
  if (msg.type === "appealVerdict") {
    (async () => {
      // The strict wall offers no appeal, and the message arrives from a page,
      // so the rule is enforced here rather than assumed from the UI.
      await loadSession();
      if (sessionActive()) { log("[GS] appeal refused — session running"); return; }
      // Title from the sender's real tab, never the message body — a script in
      // a blocked page must not be able to whitelist a title it doesn't have.
      let realTitle = "";
      if (sender && sender.tab && sender.tab.id != null) {
        try { realTitle = (await chrome.tabs.get(sender.tab.id)).title || ""; } catch (e) {}
      }
      const title = normalizeTitle(realTitle || "").toLowerCase();
      const host = hostOf(sender && sender.url ? sender.url : "") || String(msg.host || "");
      let key = "";
      if (title) {
        await loadCache();
        key = await cacheKeyFor(title);
        rememberVerdict(key, "productive");
        persistCache();
        log("[GS] ↩ appeal accepted — \"" + title + "\" now productive");
      }

      // Recorded in the same audit trail as every other pass, carrying the
      // cache key — so "What got past the wall" can revoke a correction that
      // turns out to have been a lie to oneself, exactly like any other entry.
      await recordAccess(host, realTitle || "", "appeal", key, msg.reason);

      // The page is no longer junk, so nothing should re-assert against it.
      resetStreak();
      if (sender && sender.tab && sender.tab.id != null && lockedTabs.delete(sender.tab.id)) persistLocks();
    })();
    return;
  }

  // A note written on the way out of a wall. Goes on today's list rather than
  // being lost with the tab.
  //
  // The worker owns this rather than the wall because only this side can read
  // storage — the wall is injected into an arbitrary page and has no access to
  // the task list to compare against.
  //
  // The page's URL is attached as a REAL task link (url + host), not just as
  // readable provenance. That is a deliberate change from how the removed
  // post-wall capture screen worked, and it is safe for one specific reason:
  // answering the countdown already grants this exact page a reprieve, so the
  // link is not buying access that was not just granted. It only makes the
  // exemption outlive the reprieve, for as long as the task stays open.
  //
  // The bound is the task, and the task is visible. taskLinkIdentities() only
  // honours a link on a task that is OPEN and dated today or earlier — so
  // ticking the task off, or deleting it, takes the exemption with it. That is
  // the property that keeps this from being a permanent pass: you can see every
  // page you have exempted, in your own list, and closing the task closes the
  // hole. A pass you cannot see is the thing worth refusing; this one is a row
  // on the list you read every morning.
  //
  // msg.attachTo (an index into todos) attaches this page to a task you already
  // wrote instead of creating another one.
  if (msg.type === "taskFromTab") {
    // ---- a task from the tab you are on ----
    // The popup's "this tab" chip. This is the third writer of a linked task,
    // beside the popup's add row (a link you pasted: free, planned) and the
    // wall's task door (a link written under a block: priced, late). It has
    // to be one or the other, and which one is decided HERE, by what the tool
    // was doing to that page when the chip was pressed — never by the popup,
    // which could otherwise turn the priced door into a free one-click.
    //
    //   walled  → refused. The wall has its own door and it is the only door.
    //   warned  → the countdown strip is up on this page: same moment, same
    //             price, same `late` mark as answering the strip. The strip is
    //             stood down and the page reprieved, as the strip would.
    //   neither → free and planned, exactly as if the link had been pasted.
    //
    // The page is read from the active tab on this side. The popup only says
    // which day it was looking at, and optionally a text to use instead of
    // the page's title.
    //
    // Whatever happens in here, the popup gets an answer. A throw after
    // `return true` leaves the port open with nothing on it, and the popup
    // can only report that as "couldn't reach the worker" — which is what a
    // stale worker with no handler at all looks like too. The two must not
    // read the same, so a throw is caught and sent back as its own reason.
    (async () => {
     try {
      let tab = null;
      try {
        let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tabs[0]) tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = tabs[0] || null;
      } catch (e) {}
      const url = (tab && /^https?:/i.test(tab.url || "")) ? String(tab.url).slice(0, 500) : "";
      // Stored the way the popup's add row stores it (no www.), so the list
      // line and the chip's "already on your list" check read one host.
      const host = hostOf(url).replace(/^www\./, "");
      const id = url ? linkIdentity(url) : "";
      if (!url || !host || !id) { sendResponse({ ok: false, reason: "nopage" }); return; }

      await locksReady;
      if (tab.id != null && lockedTabs.get(tab.id)) {
        sendResponse({ ok: false, reason: "walled", host });
        return;
      }

      const d = await chrome.storage.local.get("todos");
      const list = Array.isArray(d.todos) ? d.todos : [];
      // One page, one open task. Matched on identity, not the string — the
      // same video with a &t= on it is the same page.
      const dupe = list.find(t => t && typeof t === "object" && !t.done && t.url &&
                                  linkIdentity(t.url) === id);
      if (dupe) { sendResponse({ ok: false, reason: "exists", text: dupe.text || "", host }); return; }

      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(msg.date || "")) ? String(msg.date) : todayKey();
      const given = String(msg.text || "").trim().slice(0, 200);
      const text = given || taskTextFor(tab.title || "", host);
      // "Warned" means the strip is up on THIS page: headsUpAt is set when it
      // is shown and cleared with the streak, and lastTitle is the page the
      // streak belongs to. A strip on some other tab is not this page's.
      const warned = headsUpAt > 0 && normalizeTitle(tab.title || "") === lastTitle;

      const item = { text, done: false, date, rank: nextTaskRank(list, date), url, host };
      if (warned) item.late = true;
      list.push(item);
      await chrome.storage.local.set({ todos: list });

      let charge = null, held = false;
      if (warned) {
        // Charged after the write, never before — see chargeLateTask.
        charge = await chargeLateTask("added from the popup on " + host);
        // The link only exempts a task whose day has arrived, so a page
        // filed for Saturday gets no reprieve today: the wall it was warned
        // about still stands, and the popup says so.
        if (date <= todayKey()) {
          grantReprieve(id, text);
          held = true;
          await clearHeadsUp(0, "On your list.", "This page is exempt while the task is open.");
        }
      }
      // Same as taskLinkAdded: a tab already sitting on the page stops being
      // walled without waiting for the streak to notice.
      resetStreak();
      sendResponse({ ok: true, text, host, date, charge, late: warned, reprieved: held,
                     index: list.length - 1 });
     } catch (e) {
      const err = String(e && e.message ? e.message : e);
      log("[GS] taskFromTab failed:", err);
      try { sendResponse({ ok: false, reason: "error", err }); } catch (e2) {}
     }
    })();
    return true;
  }

  if (msg.type === "captureTask") {
    (async () => {
      const text = String(msg.text || "").trim().slice(0, 200);
      const url = (msg.url && /^https?:/i.test(msg.url)) ? String(msg.url).slice(0, 500) : "";
      const attachTo = Number.isInteger(msg.attachTo) ? msg.attachTo : -1;

      const d = await chrome.storage.local.get("todos");
      const list = Array.isArray(d.todos) ? d.todos : [];

      // ---- attaching to an existing task ----
      // No new task, so no late charge: you had already written this one down.
      // The only thing being added is where the work lives.
      if (attachTo >= 0) {
        const t = list[attachTo];
        if (!t || typeof t !== "object" || t.done) {
          sendResponse({ added: false, error: "gone" });
          return;
        }
        if (url) {
          t.url = url;
          t.host = hostOf(url);
          await chrome.storage.local.set({ todos: list });
        }
        let held = false;
        if (url) {
          const id = linkIdentity(url);
          if (id) { grantReprieve(id, t.text || ""); resetStreak(); held = true; }
        }
        // Attaching at the wall is still overruling the wall.
        if (msg.fromWall && held) await wallOverride(sender, t.text || "");
        sendResponse({ added: true, text: t.text || "", merged: false,
                       attached: true, linked: !!url, reprieved: held, charge: null });
        return;
      }

      if (!text) { sendResponse({ added: false, text: "" }); return; }

      // Compare against what is already there, so writing down the same
      // intention twice doesn't leave you with two of it. Only OPEN tasks
      // count: something already ticked off is not a duplicate of work you are
      // writing down now — it is a reason to write it down again.
      const norm = (s) => String(s || "").toLowerCase()
        .replace(/https?:\/\/\S+/g, " ")     // a pasted link isn't the task
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ").trim();
      const key = norm(text);
      let merged = false;
      if (key) {
        for (const t of list) {
          const other = typeof t === "string" ? t : (t && t.text);
          if (!other) continue;
          if (typeof t === "object" && t.done) continue;
          const k2 = norm(other);
          if (!k2) continue;
          // Exact match after normalising, or one plainly contained in the
          // other — "reply to Anil" against "reply to Anil about the invoice".
          //
          // Containment is only trusted when BOTH strings are substantial. The
          // length floor has to cover the existing task as well as the new one:
          // guarding only the new text still let a stubby task already on the
          // list ("api") swallow a real one ("read the api docs for stripe"),
          // which is the worse direction — a false merge silently discards what
          // the user just wrote, where a duplicate is merely untidy.
          const short = key.length < 8 || k2.length < 8;
          if (k2 === key || (!short && (k2.includes(key) || key.includes(k2)))) {
            merged = true;
            break;
          }
        }
      }

      let charge = null;
      let linked = false;
      if (!merged) {
        // Ranked to the bottom of today, the same as a task typed into the
        // popup. A task written from a wall is still a task you wrote now, so
        // it queues behind what was already there -- and it MUST carry a rank:
        // the lists sort on it, and a task without one sorts above everything
        // you deliberately put in order.
        const item = { text, done: false, date: todayKey(),
                       rank: nextTaskRank(list, todayKey()) };
        // The page becomes the task's link, so the list says WHERE the work is
        // and not just what it was. See the note above on why this is a real
        // exemption rather than plain provenance — it is bounded by the task
        // staying open, and it is visible in the popup.
        if (url) { item.url = url; item.host = hostOf(url); linked = true; }
        // Marks it as reconstructed rather than planned, so the popup can say
        // so and the charge below has something to point at.
        item.late = true;
        list.push(item);
        await chrome.storage.local.set({ todos: list });
        // Charged AFTER the write, never before: the task is saved whatever the
        // balance says. See chargeLateTask — refusing to record work because it
        // cannot be paid for would destroy the thing this path exists to save.
        //
        // A duplicate is not charged. You had already written that one down, at
        // whatever time you wrote it; billing you again for remembering it would
        // be charging for the same task twice.
        // One coin more from the wall than from the countdown — the countdown
        // was the cheap window, and it said so. See WALL_TASK_CHARGE.
        charge = msg.fromWall
          ? await chargeLateTask("added at the wall on " + (hostOf(msg.url || "") || "a page"), WALL_TASK_CHARGE)
          : await chargeLateTask("added from a block on " + (hostOf(msg.url || "") || "a page"));
      }

      // Answering ahead of the wall calls that wall off, on this page only,
      // until you leave it. `reprieve` is opt-in from the caller: the panel that
      // runs during the countdown asks for it, the wall's own capture screen
      // does not — by the time that screen is reached the page is already
      // blocked and you have chosen to leave, so there is nothing to protect.
      let held = false;
      if (msg.reprieve && msg.url) {
        const id = linkIdentity(msg.url);
        if (id) {
          grantReprieve(id, text);
          // The streak dies with the verdict that fed it. Without this the
          // counter keeps climbing while the page is exempt, and the wall lands
          // the instant the reprieve ends — which would read as the tool having
          // waited to punish you.
          resetStreak();
          held = true;
          log("[GS] reprieve granted: " + id);
        }
      }
      if (msg.fromWall && held) await wallOverride(sender, text);
      sendResponse({ added: true, text, merged, reprieved: held, charge, linked });
    })();
    return true;
  }

  // The other door: fifteen minutes on this page, bought, counted as wasted.
  //
  // Everything that decides the price or the page comes from this side. The
  // tier is read off the tab's lock mark (set when the wall went up), the URL
  // is the sender's, and no mark means no wall stood — the same structural
  // guard the walk-away credit uses, so a page cannot buy a pass for a wall it
  // never had. Refused during a session, like every other route past one.
  if (msg.type === "claimOnce") {
    const tid = sender && sender.tab && sender.tab.id;
    (async () => {
      await loadSession();
      if (sessionActive()) { sendResponse({ ok: false, reason: "session" }); return; }
      const url = sender && sender.url ? sender.url : "";
      const host = hostOf(url);
      const id = /^https?:/i.test(url) ? linkIdentity(url) : "";
      if (!host || !id) { sendResponse({ ok: false, reason: "nopage" }); return; }
      await locksReady;
      const mark = tid != null ? lockedTabs.get(tid) : null;
      if (!mark) { sendResponse({ ok: false, reason: "nowall" }); return; }

      const ov = await overridesFor(host);
      const price = oncePrice({ claimsToday: ov.claimsToday, tier: mark.tier || "low" });
      const nth = ov.claimsToday + 1;
      const why = (nth > 1
        ? nth + (nth === 2 ? "nd" : nth === 3 ? "rd" : "th") + " today"
        : "") + (mark.tier === "medium" ? (nth > 1 ? ", " : "") + "over a read verdict" : "");
      const res = await spendOnce(price, why);
      if (!res.ok) { sendResponse(res); return; }

      const until = Date.now() + ONCE_MINUTES * 60 * 1000;
      await loadReprieves();
      grantReprieve(id, "just this once", { kind: "once", until });
      lockedTabs.delete(tid); persistLocks();
      resetStreak();
      let realTitle = "";
      try { realTitle = (await chrome.tabs.get(tid)).title || ""; } catch (e) {}
      await recordAccess(host, realTitle, "once", "");
      log("[GS] 🚪 once door: " + host + " for " + ONCE_MINUTES + " min at " + price);
      sendResponse({ ok: true, minutes: ONCE_MINUTES, until, price, balance: res.balance });
    })();
    return true;
  }

  // A link was attached to a to-do. Nothing is written to the allow-list —
  // the exemption is derived from the to-do list per page. This just clears
  // the streak so a tab already sitting on that page stops being walled.
  if (msg.type === "taskLinkAdded") {
    resetStreak();
    return;
  }

  // Settings were saved. A key that was rejected five minutes ago may have been
  // topped up or re-enabled at the provider since, and the key itself hasn't
  // changed — so nothing else would invalidate the remembered failure. Saving is
  // the user asking to be re-checked, so honour that.
  if (msg.type === "settingsSaved") {
    aiStatus = { at: 0, forKey: "", resp: null };
    return;
  }

  // ---- focus session ----
  if (msg.type === "sessionState") {
    (async () => {
      await loadSession();
      await reapSession();
      sendResponse({
        active: sessionActive(),
        leftMs: sessionLeftMs(),
        task: (session && session.task) || "",
        totalMs: session ? (session.until - session.startedAt) : 0
      });
    })();
    return true;
  }

  if (msg.type === "startSession") {
    (async () => {
      await loadSession();
      const mins = Math.max(5, Math.min(180, Number(msg.minutes) || 25));
      const now = Date.now();
      session = {
        until: now + mins * 60 * 1000,
        startedAt: now,
        task: String(msg.task || "").slice(0, 200)
      };
      persistSession();
      // A session starting cancels any pause — the two states contradict each
      // other, and the one the user just chose is the one that should win.
      if (pausedUntil) { pausedUntil = 0; pauseKind = ""; persistPause(); await closeDown(); }
      resetStreak(); lastTickTs = 0;
      updatePauseBadge();
      log("[GS] 🎯 session started: " + mins + "m on \"" + session.task + "\"");
      sendResponse({ ok: true, until: session.until });
      // A panel already counting down when the session starts is now describing
      // the wrong wall: it offers "add to my tasks" to call off a block, and a
      // session refuses that. resetStreak() above has already moved the ground
      // under it. Stood down with session copy rather than the pause's.
      await clearHeadsUp(0, "Session on. No way past now.",
                         "This page is blocked for the next " + mins + " min.");
    })();
    return true;
  }

  // Abandoning. Deliberately NOT logged as a completed session — see
  // logSessionDone. It is allowed without friction: a tool that traps you is a
  // tool you uninstall, and the cost of ending it is already the honest one of
  // having to admit you did.
  if (msg.type === "endSession") {
    (async () => {
      await loadSession();
      session = null;
      persistSession();
      resetStreak(); lastTickTs = 0;
      updatePauseBadge();
      log("[GS] 🎯 session abandoned");
      sendResponse({ ok: true });
    })();
    return true;
  }

  // ---- host permission ----
  // Whether the extension can actually see pages. The popup gates its setup
  // checklist on this, and the welcome flow asks for it.
  //
  // NOTE: the request itself cannot happen here. chrome.permissions.request
  // must be called from a user gesture in a page context — from the worker it
  // rejects outright — so the pages call it directly and this only reports.
  if (msg.type === "hostAccess") {
    (async () => { sendResponse({ granted: await hasHostAccess() }); })();
    return true;
  }
  // A page just granted (or revoked) it. The cached answer is dropped so the
  // next tick re-reads, and the loop is kicked so blocking starts immediately
  // rather than up to POLL_SECONDS later.
  if (msg.type === "hostAccessChanged") {
    hostAccess = null;
    tick();
    if (sendResponse) sendResponse({ ok: true });
    return true;
  }

  // ---- pause state (popup banner) ----
  if (msg.type === "pauseState") {
    (async () => { await loadPause(); sendResponse({ pausedUntil, pauseKind }); })();
    return true;
  }

  // The countdown panel says someone is typing in it — hold the wall.
  //
  // Without this the ring could freeze while the wall landed anyway, which is
  // the panel making a promise the worker never heard. The hold is short and
  // re-armed by every keystroke (the panel re-sends as it types), so a tab
  // left with a text box open resumes counting down within seconds of the
  // typing stopping — this extends the deadline, it never removes it.
  //
  // Deliberately NOT gated on coins or rationed. The thing being bought here
  // is the time to answer the tool's own question honestly; charging for that
  // would price the useful answer above the useless one, and "work" typed in
  // two seconds would become the rational move.
  if (msg.type === "holdWall") {
    // The total is capped HERE, not just in the panel. The panel bounds itself
    // and stops asking once its budget is spent — but this message arrives from
    // a script injected into an arbitrary page, and a page that simply kept
    // sending it would hold the wall off forever. Trusting the sender to stop
    // asking is not a limit; it is a request. So the worker keeps its own
    // clock: the first hold of a streak opens the window, and once
    // HEADSUP_HOLD_MAX_MS of wall-time has passed since then, no further hold
    // is granted no matter who asks or what they claim.
    //
    // Cleared with the streak (see resetStreak), so leaving the page and coming
    // back to a genuinely new approach gets a fresh budget — the cap bounds one
    // run at one wall, not the user forever.
    const now = Date.now();
    if (!holdWindowStart) holdWindowStart = now;
    const spent = now - holdWindowStart;
    if (spent >= HEADSUP_HOLD_MAX_MS) {
      log("[GS] ⌨ hold refused — " + Math.round(spent / 1000) + "s budget spent");
      sendResponse({ ok: false, reason: "spent" });
      return true;
    }
    // A rolling window, not an accumulation: each keystroke pushes the wall to
    // HEADSUP_HOLD_IDLE_MS from now, clipped so it can never reach past the
    // budget above.
    const until = Math.min(now + HEADSUP_HOLD_IDLE_MS,
                           holdWindowStart + HEADSUP_HOLD_MAX_MS);
    // Never pull a deferral IN. Another hold (or the heads-up's own
    // HEADSUP_MIN_SECONDS floor) may already hold the wall further out, and
    // taking the max means a keystroke can only ever buy time, never spend it.
    if (until > wallDeferUntil) wallDeferUntil = until;
    log("[GS] ⌨ wall held while typing (" + Math.round(spent / 1000) + "s of " +
        Math.round(HEADSUP_HOLD_MAX_MS / 1000) + "s budget used)");
    sendResponse({ ok: true, until: wallDeferUntil });
    return true;
  }

  // A deliberate stand-down, asked for from the popup. The only other way to
  // stop the tool was the on/off switch, which has no end — flipped in a moment
  // of frustration it stays off, and the extension is quietly dead from then on.
  // A pause that expires by itself turns "I'm done with this" into "not for the
  // next hour", which is the difference between an uninstall and a return.
  //
  // The same pausedUntil the gauntlet grants, so it needs no separate state and
  // the badge counts it down exactly the same way.
  if (msg.type === "pauseFor") {
    (async () => {
      // A session outranks the pause. Allowing it here would make the session's
      // promise "strict, unless you press 30 min" — the popup hides the control
      // during a session, and this is the enforcement behind that.
      await loadSession();
      if (sessionActive()) {
        sendResponse({ ok: false, reason: "session" });
        return;
      }
      // The popup's own free row is rationed: one a day, and none once the
      // budget is spent. Enforced here, not in the popup, so hiding the
      // buttons is a courtesy and this is the rule. The off-switch sheet
      // sends no source and is never refused — a break offered instead of
      // switching off has to stay free, because switching off is.
      //
      // UNLESS the build is in testing mode. Exercising the extension means
      // standing it down over and over — a rule that allows one free pause a
      // day makes the tool untestable by its own author, who then reaches for
      // the off switch instead and tests nothing at all. FREE_PAUSE_UNLIMITED
      // lifts the ration and NOTHING else: every pause is still logged, still
      // gets its ledger row at zero, still counts toward the downtime budget
      // and still shows up on the scoreboard. The hole stays visible, which is
      // the property that lets this be turned back off honestly before ship.
      if (msg.source === "row" && !FREE_PAUSE_UNLIMITED) {
        const c = await pauseCtx();
        if (c.freesToday >= 1 || c.overBudget) {
          sendResponse({ ok: false, reason: "budget", over: c.overBudget });
          return;
        }
      }
      const mins = Math.max(1, Math.min(240, Number(msg.minutes) || 0));
      // Minutes EXTEND a pause already running, exactly as buyPause does.
      // This used to assign Date.now() + mins outright, so pressing "30 min"
      // forty minutes into an hour did not add half an hour — it threw away
      // the twenty still held and left thirty. The button says "30 min"; the
      // only reading of that on a running pause is thirty MORE. loadPause()
      // first, because a fresh worker holds pausedUntil = 0 and would have
      // "extended" from nothing.
      await loadPause();
      const from = Math.max(Date.now(), pausedUntil || 0);
      pausedUntil = from + mins * 60 * 1000;
      pauseKind = "free";
      persistPause();
      await openDown("free");
      updatePauseBadge();
      resetStreak(); lastTickTs = 0;
      await logPause(mins, msg.reason, "free");
      // A pause that costs nothing still gets a ledger row — at zero. See
      // noteFreePause: the wallet has to know about every stand-down, or the
      // one that is free becomes the one it cannot account for.
      await noteFreePause(mins, msg.reason);
      log("[GS] ⏸ paused for " + mins + " min by request" +
          (msg.reason ? " — \"" + msg.reason + "\"" : ""));
      // Answer the popup first. The panel is a courtesy on a page that may not
      // even exist, and the popup should not sit waiting on an injection into
      // someone else's tab to confirm a pause that has already happened.
      sendResponse({ ok: true, pausedUntil });
      // Total time left, not the minutes just added — see buyPause.
      await clearHeadsUp(Math.round(pauseLeftMs() / 60000));
    })();
    return true;
  }

  // Why the tool is not running, for the popup's banner. Derived fresh rather
  // than read from offReason: this may be the first thing a restarted worker
  // is asked, and the in-memory value would still be at its default.
  //
  // The banner exists because "on" and "cannot run" look identical from the
  // outside — flipping the switch back on when host access is missing changes
  // nothing visible, which reads as a broken button rather than a missing
  // permission.
  // Everything the icon logic knows about itself, for diagnosing a stuck
  // icon from the service-worker console:
  //   chrome.runtime.sendMessage({type:"iconDebug"}, console.log)
  // Also FORCES a repaint, so it doubles as the manual recovery.
  if (msg.type === "iconDebug") {
    (async () => {
      try {
        const d = await chrome.storage.local.get(["enabled", "offSince"]);
        let perm = null, permErr = "";
        try { perm = await chrome.permissions.contains({ origins: ["<all_urls>"] }); }
        catch (e) { permErr = String(e && e.message ? e.message : e); }
        const before = { offReason, lastIconPaint, lastIconError, lastBadge };
        lastIconError = "";
        await paintIcon();                     // force it
        sendResponse({
          storedEnabled: d.enabled, offSince: d.offSince || 0,
          hostPermission: perm, permError: permErr,
          cachedHostAccess: hostAccess,
          before,
          after: { offReason, lastIconPaint, lastIconError, lastBadge }
        });
      } catch (e) {
        sendResponse({ error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (msg.type === "offState") {
    (async () => {
      // Every path below must reach a sendResponse. A message handler that
      // returns true and then throws leaves the popup's callback waiting
      // forever, and the popup that never finishes loading is indistinguishable
      // from an extension that won't open.
      try {
        const d = await chrome.storage.local.get(["enabled", "offSince", "schedule"]);
        let reason = OFF_NONE;
        if (d.enabled === false) reason = OFF_DISABLED;
        else {
          // Ask chrome directly rather than clearing the shared cache. Nulling
          // `hostAccess` here raced doTick(), which reads it every 3s: the tick
          // could re-populate it mid-flight and the two would then disagree
          // about whether the tool was running — the popup saying "watching
          // your tabs" while the icon stayed grey.
          let granted;
          try {
            granted = await chrome.permissions.contains({ origins: ["<all_urls>"] });
          } catch (e) {
            granted = await hasHostAccess();      // fall back to the cache
          }
          if (!granted) reason = OFF_NOACCESS;
          else if (!scheduleActiveAt(Array.isArray(d.schedule) ? d.schedule : [], new Date())) {
            reason = OFF_SCHEDULE;
          }
        }
        sendResponse({ reason, since: d.offSince || 0 });
      } catch (e) {
        // Report "can't tell" rather than nothing. renderOffBar treats a blank
        // reason as "fine", so the banner stays hidden instead of the popup
        // hanging on a promise that never settles.
        sendResponse({ reason: OFF_NONE, since: 0 });
      }
    })();
    return true;
  }

  // ---- coins ----
  // Read the wallet. liveStreak is resolved here rather than in the UI so the
  // popup and the scoreboard can never disagree about whether a streak is
  // still alive.
  if (msg.type === "wallet") {
    (async () => {
      const w = await getWallet();
      const ctx = await pauseCtx();
      sendResponse({
        balance: w.balance || 0,
        earned: w.earned || 0,
        spent: w.spent || 0,
        streak: liveStreak(w),
        bestStreak: w.bestStreak || 0,
        multiplier: streakMultiplier(liveStreak(w)),
        // Progress toward the coin currently being earned, so the popup can
        // show movement instead of a number that sits still for ten minutes.
        partialPct: Math.min(100, Math.round(((w.partialSec || 0) /
          (COIN_MINUTES_PER_TICK * 60)) * 100)),
        // Is today's day already banked, or is the streak riding on the next
        // ten minutes? Same number, opposite feeling — this is what the popup
        // leads with.
        earnedToday: earnedToday(w),
        atRisk: streakAtRisk(w),
        nextMilestone: nextMilestone(liveStreak(w)),
        // Every milestone ever reached. Sent whole — there are at most eight,
        // so there is nothing to paginate.
        held: Array.isArray(w.held) ? w.held : [],
        milestones: MILESTONES,
        ledger: (w.ledger || []).slice(0, 40),
        // Live prices, not list prices. `base` is kept so the popup can show
        // what the surcharge is on top of.
        store: STORE.map(i => ({ ...i, base: i.price, price: pausePrice(i, ctx) })),
        pricing: ctx,
        budgetMin: DOWN_BUDGET_MIN
      });
    })();
    return true;
  }

  // The downtime record: today, split by kind, live — an open episode counts
  // up to now — plus the last seven days for the scoreboard.
  if (msg.type === "downtime") {
    (async () => {
      const rows = await readDown();
      const now = Date.now();
      const days = {};
      for (let i = 0; i < 7; i++) {
        const dt = new Date(); dt.setDate(dt.getDate() - i);
        const k = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") +
                  "-" + String(dt.getDate()).padStart(2, "0");
        days[k] = downSummary(rows, k, now);
      }
      const open = rows.find(r => r && !r.closed);
      sendResponse({
        today: days[todayKey()],
        days,
        budgetMin: DOWN_BUDGET_MIN,
        open: open && (now - open.to <= DOWN_STALE_MS) ? open.kind : ""
      });
    })();
    return true;
  }

  // Read-and-clear a pending celebration. See claimCelebration().
  if (msg.type === "claimCelebration") {
    (async () => {
      try { sendResponse(await claimCelebration()); }
      catch (e) { sendResponse({ milestone: 0, brokeFrom: 0 }); }
    })();
    return true;
  }

  // Buy pause minutes. The debit and the grant happen here together so a
  // popup that closes mid-purchase cannot take the coins without giving the
  // time — the two used to be separable and that is exactly the bug worth
  // avoiding in anything that spends a balance.
  if (msg.type === "buyPause") {
    (async () => {
      await loadSession();
      if (sessionActive()) { sendResponse({ ok: false, reason: "session" }); return; }
      const item = storeItem(msg.itemId);
      if (!item) { sendResponse({ ok: false, reason: "unknown" }); return; }
      // Priced here, not by the popup. The popup shows the same number, but
      // a price the page could set is not a price.
      const ctx = await pauseCtx();
      const price = pausePrice(item, ctx);
      const nth = ctx.pausesToday + 1;
      const why = ctx.mult > 1
        ? nth + (nth === 2 ? "nd" : nth === 3 ? "rd" : "th") + " today" +
          (ctx.overBudget ? ", over budget" : "")
        : "";
      const res = await spend(item.id, price, why);
      if (!res.ok) { sendResponse(res); return; }
      // Purchased minutes EXTEND an existing pause rather than replacing it,
      // so buying twice in a row can't shorten the time you already hold.
      await loadPause();
      const from = Math.max(Date.now(), pausedUntil || 0);
      pausedUntil = from + item.minutes * 60 * 1000;
      pauseKind = "bought";
      persistPause();
      await openDown("bought");
      updatePauseBadge();
      resetStreak(); lastTickTs = 0;
      await logPause(item.minutes, "bought with coins", "bought");
      log("[GS] 🪙 bought " + item.label + " for " + item.price);
      sendResponse({ ok: true, pausedUntil, balance: res.balance, minutes: item.minutes });
      // Total time left, not the minutes just bought: these EXTEND an existing
      // pause (see above), so item.minutes would understate what is actually
      // held and the panel would name a return time that isn't true.
      await clearHeadsUp(Math.round(pauseLeftMs() / 60000));
    })();
    return true;
  }

  // Ending the pause early is always allowed — it only ever costs the user
  // time they'd already earned, so there's nothing to guard against.
  if (msg.type === "endPause") {
    pausedUntil = 0;
    pauseKind = "";
    persistPause();
    closeDown();
    updatePauseBadge();
    resetStreak(); lastTickTs = 0;
    sendResponse({ ok: true });
    return true;
  }

  // ---- access log queries (used by ui/access.html) ----
  if (msg.type === "getAccessLog") {
    (async () => {
      const d = await chrome.storage.local.get(["accessLog", "allowDomains"]);
      sendResponse({
        entries: Array.isArray(d.accessLog) ? d.accessLog : [],
        allowDomains: d.allowDomains || [],
        // live grants are in-memory and expire; surfaced so the page can show
        // which hosts are open RIGHT NOW rather than only historically
        pausedUntil
      });
    })();
    return true;
  }

  // Revoke a host: drop its live grant, forget every cached verdict it earned,
  // remove it from the user's always-allowed list, and delete its log rows.
  // This is the "I was wrong to let that through" button — it has to undo the
  // memory too, or the site sails past the classifier on its cached verdict.
  if (msg.type === "revokeHost") {
    (async () => {
      const host = String(msg.host || "");
      if (!host) { sendResponse({ ok: false }); return; }


      const d = await chrome.storage.local.get(["accessLog", "allowDomains"]);
      const entries = Array.isArray(d.accessLog) ? d.accessLog : [];

      // forget the cached verdicts this host's approvals wrote
      await loadCache();
      let forgotten = 0;
      for (const e of entries) {
        if (e.host === host && e.cacheKey && verdictCache.delete(e.cacheKey)) forgotten++;
      }
      if (forgotten) persistCache();

      // drop it from the always-allowed list, including subdomain matches
      const allow = (d.allowDomains || []).filter(dm => dm !== host && !host.endsWith("." + dm));
      const kept = entries.filter(e => e.host !== host);
      await chrome.storage.local.set({ accessLog: kept, allowDomains: allow });
      log("[GS] ⛔ revoked " + host + " (" + forgotten + " cached verdicts forgotten)");
      sendResponse({ ok: true, forgotten });
    })();
    return true;
  }

  if (msg.type === "clearAccessLog") {
    (async () => {
      await chrome.storage.local.set({ accessLog: [] });
      sendResponse({ ok: true });
    })();
    return true;
  }

  // popup asks: is the AI actually working? surfaces real errors instead of
  // silently degrading to keyword matching.
  if (msg.type === "aiStatus") {
    (async () => {
      const { apiKey } = await getState();
      if (!apiKey) { sendResponse({ state: "nokey" }); return; }
      // The Settings "Test the key" button asks for a real call. Answering it
      // from a five-minute cache would make the button a liar the one time
      // someone is deliberately checking.
      const cached = msg.fresh ? null : cachedAiStatus(apiKey);
      if (cached) { sendResponse(cached); return; }
      let resp;
      try {
        // fixed mission so this tests API reachability, not the user's own config
        const v = await aiRelevant("Two Sum - LeetCode", [], apiKey, "learning to code");
        resp = { state: "ok", provider: providerOf(apiKey), sample: v };
      } catch (e) {
        resp = { state: "error", provider: providerOf(apiKey), err: lastAiError || String(e.message || e) };
      }
      rememberAiStatus(apiKey, resp);
      sendResponse(resp);
    })();
    return true;
  }

  // The wall, on demand, from the end of setup. Seeing it once by choice is what
  // stops the first real block reading as a hijacked browser — and it's the only
  // safe way to show it, since the genuine article arrives unannounced on a page
  // the user cared about.
  //
  // Targets the SENDER's tab (the welcome page), not whatever happens to be
  // active, so it can't land somewhere unexpected.
  // The setup page's "show me the wall" demo. It returns the wall's DATA rather
  // than injecting it: chrome.scripting cannot touch chrome-extension:// pages,
  // so injecting into the setup tab silently failed and fell through to a
  // notification. The setup page loads wall.js itself and draws it in its own
  // document, which is the one place that is allowed to.
  if (msg.type === "demoWall") {
    (async () => {
      const tid = sender && sender.tab && sender.tab.id;
      try {
        const data = await wallData(tid, "Nice Try — what a block looks like", "demo");
        // A demo must not leave real state behind. The tab is never added to
        // lockedTabs (so no reload cover), and the wall is told it's a demo so
        // passing it grants nothing.
        data.demo = true;
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, err: String(e && e.message ? e.message : e) });
      }
    })();
    return true; // async response
  }
});
