// ============================================================
//  Nice Try  ·  background service worker
//  Polls the active tab, classifies it (rules → cache → LLM),
//  tracks attention time, and walls off distraction with a gauntlet.
// ============================================================

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
// OpenRouter rotates its :free model list constantly, so we DISCOVER models at
// runtime instead of hardcoding slugs that silently 404 weeks later.
const GROQ_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "gemma2-9b-it"
];
let discoveredFreeModels = null;   // cached OpenRouter :free list
let lastDiscoveryTs = 0;
let lastAiError = "";              // surfaced in the popup so failures are visible

function providerOf(key) {
  const k = (key || "").trim();
  if (k.startsWith("gsk_")) return "groq";
  if (k.startsWith("sk-or-")) return "openrouter";
  return k ? "openrouter" : "";    // default guess
}
const GRACE_SECONDS  = 30;    // 30s in junk before we lock
const RENUDGE_SECONDS = 30;   // re-assert lock every 30s if dismissed
const AI_AFTER_SECONDS = 20;  // sit on a tab this long before we spend an AI call
const IDLE_AFTER_SECONDS = 60; // no keyboard/mouse this long = you've walked away

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
function persistCache() {
  // cap at 500 entries so storage doesn't grow forever
  const obj = {};
  let n = 0;
  for (const [k, v] of verdictCache) { if (n++ >= 500) break; obj[k] = v; }
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

// ---- state -------------------------------------------------------
let lastTabId = null;
let lastTitle = "";
let junkStreak = 0;        // seconds continuously in junk
let lastNudgeAt = 0;       // junkStreak value at last nudge
let lastTickTs = 0;        // wall-clock ms of the previous accounted tick
let ticking = false;       // in-flight guard so concurrent ticks don't race
let dwellSeconds = 0;      // seconds of REAL presence on the current title

// Passing the gauntlet buys a global pause, not access to one site. For the
// duration the extension stands down entirely: nothing is classified, no time
// is attributed, no wall can fire. Scoping it to a host meant justifying one
// video then being blocked on the next thing you opened, which is the tool
// arguing with a decision it had already accepted.
const GRANT_MS = 3 * 60 * 1000;   // 3 minutes off per successful gauntlet
let pausedUntil = 0;
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
    const d = await chrome.storage.local.get("pausedUntil");
    if (typeof d.pausedUntil === "number") pausedUntil = d.pausedUntil;
  } catch (e) {}
}
function persistPause() { chrome.storage.local.set({ pausedUntil }); }

// ---- access log ---------------------------------------------------
// Every time you talk your way past the wall, it's recorded here — which host,
// which title, and crucially HOW you got in: "answers" (the AI accepted your
// reason) or "typing" (you forced it). The 5-minute grant itself is ephemeral,
// but the record is not: this is the audit trail for deciding later that a site
// you argued your way into should never have been let through.
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
  // Everything else: host + path, query dropped. Trailing slash normalized so
  // /dsa/arrays and /dsa/arrays/ are the same page.
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return host + path;
}

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
async function taskLinkIdentities() {
  const d = await chrome.storage.local.get("todos");
  const list = Array.isArray(d.todos) ? d.todos : [];
  const out = [];
  for (const t of list) {
    if (t && typeof t === "object" && t.url) {
      const id = linkIdentity(t.url);
      if (id) out.push(id);
    }
  }
  return out;
}

async function recordAccess(host, title, legit, cacheKey) {
  if (!host) return;
  const d = await chrome.storage.local.get("accessLog");
  const logArr = Array.isArray(d.accessLog) ? d.accessLog : [];
  logArr.unshift({
    host,
    title: normalizeTitle(title || ""),
    via: legit ? "answers" : "typing",
    at: Date.now(),
    // only "answers" grants write a cached verdict; typing-test entries have none
    cacheKey: cacheKey || ""
  });
  await chrome.storage.local.set({ accessLog: logArr.slice(0, ACCESS_LOG_CAP) });
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
// machine must not be idle. Without this, time accrues for tabs you opened
// and walked away from — which is what inflated the old scoreboard numbers.
async function userIsPresent() {
  try {
    const win = await chrome.windows.getLastFocused();
    if (!win || !win.focused) return false;          // Chrome is behind another app
  } catch (e) { /* no window info — assume present */ }
  try {
    const state = await chrome.idle.queryState(IDLE_AFTER_SECONDS);
    if (state !== "active") return false;            // locked or walked away
  } catch (e) { /* idle API unavailable — assume present */ }
  return true;
}

// ---- storage helpers ---------------------------------------------
async function getState() {
  const d = await chrome.storage.local.get([
    "todos", "apiKey", "log", "enabled", "lastReset", "allowDomains", "mission"
  ]);
  return {
    // todos are stored as [{text, done}] but older versions stored plain
    // strings — normalize both to text[] for everything downstream.
    // Completed tasks are dropped: a finished task should stop vouching for
    // its topic. Leaving them in meant ticking "revise DP" off still told the
    // classifier that DP videos were today's work.
    todos: (d.todos || [])
      .filter(t => typeof t === "string" || !(t && t.done))
      .map(t => (typeof t === "string" ? t : t && t.text) || "").filter(Boolean),
    // The same open tasks, but keeping the link a task may carry. The flat
    // todos[] above stays as-is because every AI prompt joins it into text;
    // the wall needs the URL so a task with a link is openable from the block
    // screen — that link IS the way back to work.
    todoItems: (d.todos || [])
      .filter(t => typeof t === "string" || !(t && t.done))
      .map(t => (typeof t === "string"
        ? { text: t, url: "", host: "" }
        : { text: (t && t.text) || "", url: (t && t.url) || "", host: (t && t.host) || "" }))
      .filter(t => t.text),
    apiKey: d.apiKey || "",
    log: d.log || {},
    enabled: d.enabled !== false,
    lastReset: d.lastReset || todayKey(),
    allowDomains: d.allowDomains || [],
    // what the user is actually working toward — drives every AI prompt.
    // blank means "no stated mission", handled by missionBlock().
    mission: (d.mission || "").trim()
  };
}

function todayKey() {
  const dt = new Date();
  return dt.getFullYear() + "-" + String(dt.getMonth()+1).padStart(2,"0") + "-" + String(dt.getDate()).padStart(2,"0");
}

// add seconds to today's log under a category (productive|junk|neutral)
async function logTime(category, seconds, title, url) {
  const { log } = await getState();
  const day = todayKey();
  if (!log[day]) log[day] = { productive: 0, junk: 0, neutral: 0, sites: {} };
  log[day][category] += seconds;
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

function shortLabel(title) {
  if (!title) return "unknown";
  return title.length > 60 ? title.slice(0, 57) + "…" : title;
}

// strip leading "(3) " unread-count prefixes (YouTube/WhatsApp/Gmail add these);
// keeps one video from busting the cache / re-calling the AL for every count change
function normalizeTitle(title) {
  return (title || "").replace(/^\(\d+\)\s*/, "").trim();
}

// ---- classification ----------------------------------------------
// returns "productive" | "junk" | "neutral"
// Titles that are clearly the browser's own pages / blank — never nag.
const IGNORE_TITLES = ["new tab", "extensions", "settings", "chrome://", "about:blank", "go study"];

// Utility / communication tools that are NEEDED — never lock these.
const NEUTRAL_UTILITY = [
  "whatsapp", "gmail", "mail", "google calendar", "calendar", "maps",
  "drive", "notion", "keep", "translate", "meet", "zoom", "teams", "outlook"
];

// Bare landing pages (no real content opened yet) — a plain "YouTube" homepage,
// a bare domain with nothing consumed. Judge only when actual content is open.
const BARE_LANDINGS = ["youtube", "google", "bing", "duckduckgo"];

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

async function classify(title, url, dwell) {
  await loadCache();

  // local files, extension pages, and browser-internal URLs are never distractions
  const u = (url || "").toLowerCase();
  if (u.startsWith("file:") || u.startsWith("chrome:") || u.startsWith("chrome-extension:") ||
      u.startsWith("edge:") || u.startsWith("about:") || u.startsWith("devtools:")) {
    return "neutral";
  }

  const host = hostOf(url);
  // search engines & AI assistants — never blocked (this is how work gets done).
  // YouTube search is deliberately NOT here; that's browsing, not researching.
  if (hostInList(host, SEARCH_HOSTS)) return "neutral";
  // allowlisted domains (built-in list + the user's own) — always productive
  const { allowDomains } = await getState();
  if (domainAllowed(host, allowDomains)) return "productive";
  // THIS page is attached to a to-do. Checked before the junk-domain list so a
  // lecture on an otherwise-blocked site gets through — but only that page.
  // Any other page on the same host falls straight through to the rules below.
  const id = linkIdentity(url);
  if (id) {
    const taskLinks = await taskLinkIdentities();
    if (taskLinks.includes(id)) { log("[GS] task link exempt: " + id); return "productive"; }
  }
  // hard junk domains (x.com, instagram.com…) — always junk, title be damned
  if (hostInList(host, JUNK_DOMAINS)) return "junk";

  const t = normalizeTitle(title).toLowerCase();
  if (!t) return "neutral";
  for (const ig of IGNORE_TITLES) if (t.includes(ig)) return "neutral";

  // utility tools — never lock (WhatsApp, Gmail, Calendar, Maps, etc.)
  for (const u of NEUTRAL_UTILITY) if (t.includes(u)) return "neutral";

  // bare landing page: the WHOLE title is just the site name (e.g. "YouTube",
  // "Google") with nothing opened → neutral. A real video's title is longer.
  if (BARE_LANDINGS.includes(t)) return "neutral";

  // Mixed-use hosts skip the blunt keyword rules and go straight to the judge —
  // a subreddit name or Discord server can trip either list for the wrong reason.
  const mixed = hostInList(host, MIXED_USE_DOMAINS);
  if (!mixed) {
    // 1) junk keywords FIRST (so "Prime Video" isn't caught by a productive term)
    for (const j of ALWAYS_JUNK)       if (t.includes(j)) return "junk";
    // 2) obvious productive coding/work titles — skip the AI, instant pass
    for (const p of ALWAYS_PRODUCTIVE) if (t.includes(p)) return "productive";
  }

  // 3) EVERYTHING ELSE goes to the judge — but an AI call is expensive, so:
  //    - a cached verdict is free, return it immediately;
  //    - otherwise wait until you've actually sat here AI_AFTER_SECONDS.
  //      Tabs you glance at (or opened and left) never cost a call.
  const cached = await cachedVerdict(t);
  if (cached) { log("[GS] cache hit → " + cached); return cached; }
  if ((dwell || 0) < AI_AFTER_SECONDS) { log("[GS] dwell " + Math.round(dwell) + "s < " + AI_AFTER_SECONDS + "s — waiting to judge"); return "neutral"; }
  log("[GS] ⚖ calling judge for: " + t);
  const v = await judgeRelevance(t);
  log("[GS] judge returned → " + v);
  return v;
}

// For YouTube etc: is this title relevant to today's to-dos?
// Try OpenRouter AI first; fall back to keyword matching.
// The verdict depends on today's to-dos (Rule 1 override), so the cache key
// carries a to-dos signature — change your tasks and stale verdicts are re-judged.
async function cacheKeyFor(title) {
  const { todos } = await getState();
  return title + "␟" + todos.map(s => s.toLowerCase().trim()).sort().join("|");
}
async function cachedVerdict(title) {
  const k = await cacheKeyFor(title);
  return verdictCache.has(k) ? verdictCache.get(k) : null;
}

async function judgeRelevance(title) {
  const { todos, apiKey, mission } = await getState();

  // 0) cache — judge each unique title once
  const cacheKey = await cacheKeyFor(title);
  if (verdictCache.has(cacheKey)) {
    return verdictCache.get(cacheKey);
  }

  // 1) AI path — runs even with no to-dos, because genuine learning
  //    (a CS lecture, an ML talk) is productive regardless of today's list.
  let aiFailed = false;
  if (apiKey) {
    try {
      const verdict = await aiRelevant(title, todos, apiKey, mission);
      log("[GS] AI verdict for \"" + title + "\" = " + verdict);
      if (verdict === "productive" || verdict === "junk") {
        verdictCache.set(cacheKey, verdict);   // remember it (persisted below)
        persistCache();
        return verdict;
      }
    } catch (e) {
      aiFailed = true;
      log("[GS] AI call failed:", String(e));
    }
  }

  // 2) keyword fallback — cheap, offline. Trust it when it's confident.
  if (todos.length && keywordRelevant(title, todos)) return "productive";
  if (looksLikeEntertainment(title)) return "junk";

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

async function aiRelevant(title, todos, apiKey, mission) {
  const todoBlock = todos.length
    ? "Today's specific tasks:\n" + todos.map((x, i) => (i + 1) + ". " + x).join("\n") + "\n\n"
    : "(No specific tasks set for today.)\n\n";

  const prompt =
    "You are a strict focus filter. Decide whether the current browser tab serves the " +
    "user's mission or is a distraction from it.\n\n" +
    missionBlock(mission) +
    todoBlock +
    "Current tab title:\n\"" + title + "\"\n\n" +
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
    "Answer with exactly one word: WORK or DISTRACTION.";

  const answer = (await aiChat(prompt, apiKey, 5)).toLowerCase();
  if (answer.includes("distraction") || answer.includes("junk"))   { lastAiError = ""; return "junk"; }
  if (answer.includes("work") || answer.includes("productive"))    { lastAiError = ""; return "productive"; }
  throw new Error("unclear answer");
}

// Low-level chat call: tries each model, handles 401/402/429, returns raw text.
async function aiChat(prompt, apiKey, maxTokens) {
  const provider = providerOf(apiKey);
  const endpoint = provider === "groq"
    ? "https://api.groq.com/openai/v1/chat/completions"
    : "https://openrouter.ai/api/v1/chat/completions";
  const models = provider === "groq" ? GROQ_MODELS : await getFreeModels(apiKey);
  if (!models.length) { lastAiError = "no models available"; throw new Error(lastAiError); }

  let lastErr = "no models";
  for (const model of models) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          model, messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens, temperature: 0.3
        })
      });
      if (res.status === 401) { lastErr = "invalid API key"; break; }
      if (res.status === 402) { lastErr = "no credits for " + model; continue; }
      if (res.status === 429) { lastErr = "rate limited"; continue; }
      if (!res.ok) { lastErr = "HTTP " + res.status; continue; }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || "";
      if (text) { lastAiError = ""; return text; }
      lastErr = "empty answer";
    } catch (e) {
      lastErr = String(e && e.message ? e.message : e);
    }
  }
  lastAiError = lastErr;
  throw new Error(lastErr);
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
    const raw = await aiChat(prompt, apiKey, 60);
    log("[GS] judge raw AI reply:", raw);
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const o = JSON.parse(m[0]);
      log("[GS] judge verdict → pass=" + !!o.pass + " reason=\"" + (o.reason || "") + "\"");
      return { pass: !!o.pass, reason: String(o.reason || "") };
    }
    const pass = /\bpass\b|\btrue\b|\byes\b/i.test(raw) && !/reject|false|no\b/i.test(raw);
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
    const res = await fetch("https://openrouter.ai/api/v1/models");
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
  if (/reasoning|thinking/i.test(id)) s += 15;                      // slower, overkill
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
const FOMO_LINES = [
  // — the gap between want and do —
  "Look at what you SAID you wanted. Now look at this screen. See the problem?",
  "You want a 40 LPA life but you're living a 4 LPA afternoon. Which one wins?",
  "Wanting it isn't the same as earning it. This screen is you not earning it.",
  "You'll tell yourself 'just 5 more minutes' — and lose the whole evening. Again.",
  "Is THIS the thing that gets you placed? No? Then why is it open?",
  "The version of you that clears the loan does not have this tab open right now.",
  "You don't rise to your goals. You fall to your habits. This is the habit.",
  "Dreaming about the future while wasting the present. Pick one.",
  "Every scroll is a small vote for the life you're trying to escape.",
  "You already know you shouldn't be here. That's why this hurts to read.",
  // — family / the loan —
  "Your family is counting on the person you're supposed to become. Not this.",
  "The loan doesn't pause because you're tired. Neither should you.",
  "Somewhere your parents are hoping. This screen is where that hope leaks out.",
  "You carry a weight your family can't. Don't set it down for a video.",
  "The debt gets paid by the disciplined version of you. Where is he right now?",
  "You wanted to be the one they could rely on. Reliable people don't drift here.",
  "Every minute here, someone you love waits a little longer to breathe easy.",
  "This isn't just your time you're wasting. It's theirs too.",
  "Picture handing your family the news that it worked. You don't get there from here.",
  "The people who bet on you deserve better than this tab.",
  // — future self / regret —
  "In 5 years you'll either thank tonight or resent it. Choose now.",
  "Future-you is watching this exact moment. Don't make him ashamed.",
  "The gap between you and where you want to be is made of moments like THIS.",
  "You will not remember this video next week. You'll remember staying behind.",
  "Regret is heavier than discipline. Pick the lighter weight.",
  "One day you'll wish you started today. Today is that day.",
  "The person you're jealous of on LinkedIn closed this tab and got to work.",
  "Time is the one thing you can't earn back. You're spending it here.",
  "Every hour wasted now is an hour you'll beg for later.",
  "You're not behind because you're not smart. You're behind because of moments like this.",
  // — the work waiting —
  "The work isn't going to do itself while you watch this.",
  "Close this. Open the editor. One problem. That's the whole ask.",
  "The work is boring and this is fun — that's exactly why the work matters more.",
  "Discipline is choosing what you want MOST over what you want NOW. Choose.",
  "Nobody is coming to do it for you. It's you or it's nothing.",
  "The compound interest of showing up starts the second you close this.",
  "You're one closed tab away from being back on track. Do it.",
  "Champions are built in the hours nobody claps for. This is one of them.",
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
  let text = "", colour = "#0A84FF";
  const left = pauseLeftMs();
  if (left > 0) {
    // Under a minute, count seconds — a badge stuck on "1" for sixty seconds
    // gives no sense that time is running out.
    if (left <= 60000) { text = String(Math.ceil(left / 1000)); colour = "#FF2D2A"; }
    else { text = String(Math.ceil(left / 60000)); colour = "#FF9F0A"; }
  }
  if (text === lastBadge) return;                // don't hammer the API
  lastBadge = text;
  try {
    chrome.action.setBadgeText({ text });
    if (text) chrome.action.setBadgeBackgroundColor({ color: colour });
  } catch (e) {}
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
async function nudge(tabId, title, streakSec, mode) {
  const { todos, todoItems, apiKey, mission } = await getState();
  const fomo = pick(mode === "unsure" ? UNSURE_LINES : FOMO_LINES);
  const heading = mode === "unsure" ? "Can't verify this — prove it's worth it" : "Off-task — blocked";

  // one AI-generated, site-specific justification question (+ 4 fixed ones)
  const aiQ = await aiQuestion(title, todos, apiKey, mission);
  const questions = [
    "Is this on your to-do list right now?",
    "Which of today's tasks does opening this actually serve?",
    "What will you give up or skip to make time for this?",
    aiQ,
    "In one hour, will you be glad you spent this time here?"
  ];
  let host = "";
  try { host = hostOf((await chrome.tabs.get(tabId)).url); } catch (e) {}

  // Remember what this wall is standing on, so a reload can be re-covered at
  // document_start instead of flashing the page while the next tick thinks.
  if (host) { lockedTabs.set(tabId, { host, title }); persistLocks(); }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: showShield,
      args: [{ heading, fomo, todos: todos || [], todoItems: todoItems || [], questions, host, title,
               grantMinutes: Math.round(GRANT_MS / 60000),
               // absolute extension URL — the wall is injected into arbitrary
               // pages, so a relative path would resolve against their origin
               mark: chrome.runtime.getURL("assets/logo-mark.png") }]
    });
  } catch (e) {
    chrome.notifications.create("focus_nudge_" + Date.now(), {
      type: "basic", iconUrl: "assets/icon128.png", title: "Nice Try",
      message: fomo, priority: 2, requireInteraction: true
    });
  }
}

// injected into the page — opaque wall. Flow: answer questions one at a time →
// AI judges → PASS = instant 5-min access; FAIL = type 15 words within 3 min
// (fresh words + timer on each miss) to force your way in.
// data = { heading, fomo, todos[], questions[], host, title }
function showShield(data) {
  var ID = "__focusshield__";
  if (document.getElementById(ID)) return;
  if (window.__fsGrantedAt && (Date.now() - window.__fsGrantedAt) < 8000) return;

  function freezeMedia() {
    document.querySelectorAll("video,audio").forEach(function (m) { try { m.pause(); } catch (e) {} });
  }
  freezeMedia();
  var freezer = setInterval(freezeMedia, 500);
  var prevOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = "hidden";

  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) {
    return { "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]; }); };

  var questions = data.questions || [];
  var idx = 0;                 // which question
  var answers = [];
  var timerHandle = null;

  var reduceMotion = false;
  try { reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
  var reduceTransparency = false;
  try { reduceTransparency = window.matchMedia("(prefers-reduced-transparency: reduce)").matches; } catch (e) {}
  var moreContrast = false;
  try { moreContrast = window.matchMedia("(prefers-contrast: more)").matches; } catch (e) {}

  var EASE = "cubic-bezier(.32,.72,0,1)";

  var wrap = document.createElement("div");
  wrap.id = ID;
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-modal", "true");
  wrap.setAttribute("aria-label", "Focus block — justify this page to continue");
  // The wall must stay opaque enough that the page behind is genuinely gone —
  // this is a blocker, not a scrim. The blur is layered ON TOP of a near-solid
  // base so it reads as material without ever becoming see-through, and it is
  // dropped entirely when the user asks for reduced transparency.
  var useMaterial = !reduceTransparency && !moreContrast;
  var wrapStyle = [
    "position:fixed","inset:0","z-index:2147483647",
    "background:" + (useMaterial ? "rgba(0,0,0,.86)" : "#000000"),
    // Centred by the grid, which — unlike flex + align-items:center — never
    // clips the top of an over-tall child: the row floor is the content's own
    // height, so it grows downward and the wall scrolls instead. That means one
    // rule handles both cases and no JS has to measure anything.
    //
    // min-height uses dvh where supported (a fallback vh is emitted first).
    // Mobile browsers change viewport height as the URL bar hides, and vh alone
    // is frozen at the TALLER value, so the bottom of the wall sat under the
    // chrome and "Leave" became unreachable.
    "display:grid","place-items:center","min-height:100vh","min-height:100dvh",
    "overflow-y:auto","overscroll-behavior:contain",
    // Margins are the smallest that keep the panel off the screen edge, and
    // they shrink on small screens rather than being a fixed block of dead
    // space. env() keeps clear of notches / rounded corners.
    "padding:max(0.75rem, env(safe-area-inset-top)) max(0.75rem, env(safe-area-inset-right))" +
      " max(0.75rem, env(safe-area-inset-bottom)) max(0.75rem, env(safe-area-inset-left))",
    "box-sizing:border-box",
    "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,sans-serif",
    "color:#FFFFFF"
  ];
  if (useMaterial) {
    wrapStyle.push("-webkit-backdrop-filter:blur(20px) saturate(180%)");
    wrapStyle.push("backdrop-filter:blur(20px) saturate(180%)");
  }
  // Materialize on enter: blur + scale together, so the surface arrives like a
  // physical panel rather than a flat opacity fade. Reduced motion gets the
  // plain cross-fade instead.
  wrapStyle.push("animation:" + (reduceMotion ? "__fsFade .12s linear" : "__fsIn .42s " + EASE));
  wrap.style.cssText = wrapStyle.join(";");

  var st = document.createElement("style");
  st.textContent =
    "@keyframes __fsFade{from{opacity:0}to{opacity:1}}" +
    "@keyframes __fsIn{from{opacity:0;-webkit-backdrop-filter:blur(0);backdrop-filter:blur(0)}" +
      "to{opacity:1}}" +
    "@keyframes __fsStep{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}" +
    "@keyframes __fsStepReduced{from{opacity:0}to{opacity:1}}" +
    "#" + ID + " ::placeholder{color:#5c554c}" +
    // Keyboard focus must be unmistakable on top of an opaque wall.
    "#" + ID + " :focus-visible{outline:2px solid #409CFF;outline-offset:3px;border-radius:12px}" +
    // focus ring on the text fields, which have no border of their own now
    "#" + ID + " input:focus,#" + ID + " textarea:focus{outline:none;box-shadow:0 0 0 4px rgba(64,156,255,.25)}" +
    // The wall's sizes are in rem, which resolve against the HOST PAGE's root
    // font size — a site that sets html{font-size:12px} shrank the whole wall.
    // Pin our own base so the wall is the same size on every site.
    //
    // The base then SCALES WITH THE VIEWPORT. Everything inside is sized in em,
    // so this one number sets the whole panel.
    //
    // Both axes feed it, because each one alone gets a case wrong: pure vh
    // makes a short wide window tiny, pure vw makes a tall narrow one huge.
    // The vh term leads (the buttons-below-the-fold failure is the one that
    // actually breaks the wall) with vw contributing enough to fill a big
    // display. The layout no longer depends on this fitting exactly — the grid
    // scrolls if it doesn't — so this is now purely about how big it FEELS.
    "#" + ID + "{font-size:clamp(15px, 1.55vh + 0.45vw, 27px)}" +
    // The wall is injected into arbitrary pages whose own CSS reaches every
    // element on the document. Pinning box-sizing keeps padded elements from
    // measuring wider than their container and scrolling the wall sideways.
    "#" + ID + ",#" + ID + " *{box-sizing:border-box}" +
    // The panel is a flex column, where children shrink by default. The things
    // you must be able to read and press are exempt: only the task list gives
    // up space. Without this a short window squeezed the textarea below its two
    // rows and flattened the buttons.
    "#" + ID + " .__fs_step > *{flex:none}" +
    "#" + ID + " input,#" + ID + " textarea,#" + ID + " button{flex:none}" +
    // …except the task card, which is the designated shrinkable one. Declared
    // after the blanket rule so it wins on source order at equal specificity.
    "#" + ID + " .__fs_flex{flex:0 1 auto;min-height:0}" +
    "#" + ID + " button{transition:transform .16s " + EASE + ",filter .16s " + EASE +
      ",background .16s " + EASE + ",border-color .16s " + EASE + ",color .16s " + EASE + "}" +
    "#" + ID + " button.__fs_press{transform:scale(.975);filter:brightness(.94)}" +
    (reduceMotion ? "#" + ID + " *{animation-duration:.01ms !important;transition-duration:.01ms !important}" +
      "#" + ID + " button.__fs_press{transform:none}" : "");
  wrap.appendChild(st);
  document.documentElement.appendChild(wrap);
  // The document_start placeholder has done its job — the real wall is up.
  var hold = document.getElementById("__fshold__");
  if (hold) hold.remove();

  // No pasting into the wall's fields. On the typing test this is the whole
  // point — copying the sentence would defeat the gate outright — and on the
  // questions it stops a canned answer being dropped in. Drag-and-drop and
  // middle-click paste are blocked for the same reason.
  ["paste", "drop", "dragover", "auxclick"].forEach(function (evt) {
    wrap.addEventListener(evt, function (e) {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) {
        e.preventDefault();
        var hint = wrap.querySelector("#__fs_hint");
        if (hint) hint.textContent = "Type it out — pasting is disabled.";
      }
    }, true);
  });

  // Belt and braces: block the shortcuts too, so a paste that never raises a
  // paste event still can't land.
  wrap.addEventListener("keydown", function (e) {
    if (!e.target || (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA")) return;
    var k = (e.key || "").toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "v") { e.preventDefault(); }
    if (e.shiftKey && e.key === "Insert") { e.preventDefault(); }
  }, true);

  // A task link is the way BACK to work, so it's the one navigation the wall
  // actively helps with. Handled here rather than by the anchor's own default:
  // the wall lives inside a blocked page, and a plain target=_blank inherits
  // that page's context. The worker opens it instead, and the wall stays up —
  // this tab is still blocked, you're just leaving it behind.
  wrap.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("[data-fs-task-link]");
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    var url = a.getAttribute("data-fs-task-link");
    if (!url) return;
    try { chrome.runtime.sendMessage({ type: "openTask", url: url }); } catch (err) {}
  }, true);

  // press feedback on pointer-down for every button inside the wall
  wrap.addEventListener("pointerdown", function (e) {
    var b = e.target.closest && e.target.closest("button");
    if (b) b.classList.add("__fs_press");
  });
  var clearPress = function () {
    var n = wrap.querySelectorAll("button.__fs_press");
    for (var i = 0; i < n.length; i++) n[i].classList.remove("__fs_press");
  };
  wrap.addEventListener("pointerup", clearPress);
  wrap.addEventListener("pointercancel", clearPress);
  wrap.addEventListener("pointerleave", clearPress);

  // Keep keyboard focus inside the wall. Without this, Tab walks straight into
  // the page behind it — the block would be defeated by pressing Tab twice.
  function focusables() {
    return wrap.querySelectorAll("input,textarea,button,[href],[tabindex]:not([tabindex='-1'])");
  }
  function trapKey(e) {
    if (e.key !== "Tab") return;
    var f = focusables();
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener("keydown", trapKey, true);
  // if focus escapes some other way (click, programmatic), pull it back
  function refocus(e) {
    if (!wrap.contains(e.target)) {
      var f = focusables();
      if (f.length) { e.stopPropagation(); f[0].focus(); }
    }
  }
  document.addEventListener("focusin", refocus, true);

  function cleanup() {
    clearInterval(freezer);
    if (timerHandle) clearInterval(timerHandle);
    document.removeEventListener("keydown", trapKey, true);
    document.removeEventListener("focusin", refocus, true);
    document.documentElement.style.overflow = prevOverflow;
    wrap.remove();
  }
  // legit=true → the AI genuinely approved (may be remembered);
  // legit=false → forced in via typing test (5-min access only, NEVER cached).
  function grantAndExit(legit) {
    window.__fsGrantedAt = Date.now();
    try { chrome.runtime.sendMessage({ type: "grantAccess", host: data.host, title: data.title, legit: !!legit }); } catch (e) {}
    cleanup();
  }
  function leave() {
    cleanup();
    // close the tab entirely — ask the worker (window.close only works on
    // script-opened tabs, so the worker does it via chrome.tabs.remove)
    try { chrome.runtime.sendMessage({ type: "closeTab" }); } catch (e) {}
    try { window.close(); } catch (e) {}   // best-effort fallback
  }

  function swap(node) {
    var old = wrap.querySelector(".__fs_step");
    if (old) old.remove();
    node.className = "__fs_step";
    // margin:auto centres the panel vertically while it fits and simply stops
    // centring once it's taller than the wall — which is what keeps a long task
    // list reachable instead of clipped off the top.
    // The panel is a column: the task list is the only part allowed to absorb
    // leftover space (and to give it back), so the question, the input and the
    // buttons keep their natural size and the buttons can never be pushed off
    // the bottom. Sizes are in em, so the fluid base scales the whole thing.
    // border-box so the horizontal padding is INSIDE width:100% — without it
    // the panel measured wider than its container on a narrow window and the
    // wall scrolled sideways. Host pages set wild global box-sizing, so it is
    // stated here rather than assumed.
    node.style.cssText = "max-width:34em;width:100%;box-sizing:border-box;" +
      "padding:1.25em 1.5em;text-align:center;" +
      "display:flex;flex-direction:column;min-height:0;" +
      "animation:" +
      (reduceMotion ? "__fsStepReduced .12s linear" : "__fsStep .28s " + EASE);
    wrap.appendChild(node);
  }
  function dots(count, at, color) {
    var d = "";
    for (var i = 0; i < count; i++) {
      var c = i < at ? "#46C45B" : (i === at ? (color || "#409CFF") : "#2C2C2E");
      var w = i === at ? "1.375em" : "0.438em";
      d += '<span style="height:.438em;width:' + w + ';border-radius:20px;background:' + c +
           ';transition:width .28s ' + EASE + ',background .28s ' + EASE + '"></span>';
    }
    return '<div aria-hidden="true" style="display:flex;gap:6px;justify-content:center;margin-bottom:1.25em">' + d + '</div>';
  }

  // Hosts arrive as the raw hostname, so "www." leaks into the UI where it
  // carries no meaning.
  function prettyHost(h) {
    return String(h || "this site").replace(/^www\./, "");
  }

  // The open tasks. This is the ARGUMENT the wall is making — "you said you'd
  // do something else" — so it leads the panel rather than trailing it as a
  // footnote under the buttons, where it read as decoration you scroll past.
  // Every task is listed: truncating to five and saying "and 2 more" hid the
  // exact thing the wall exists to remind you of. The list scrolls on its own
  // once it gets long, so a big backlog can't push the answer box off-screen.
  // last=true when the card ends the screen, so it drops the bottom margin it
  // otherwise needs to clear the answer box below it.
  function todoPanel(last) {
    var gap = last ? "0" : "0 0 1.25em";
    // Prefer the rich list (carries links); fall back to the flat strings so a
    // worker mid-update still renders something.
    var list = (data.todoItems && data.todoItems.length)
      ? data.todoItems.filter(function (t) { return t && t.text; })
      : (data.todos || []).filter(Boolean).map(function (t) { return { text: t, url: "", host: "" }; });
    if (!list.length) {
      // No tasks set is worth saying out loud — an empty list is the reason
      // this page looked appealing in the first place.
      return '<div style="margin:' + gap + ';padding:.75em .875em;background:#1C1C1E;border-radius:.75em;' +
        'text-align:left;font-size:.813em;line-height:1.45;letter-spacing:-.01em;color:rgba(235,235,245,.60)">' +
        'You set no tasks today. That\'s the real problem — not this page.' +
      '</div>';
    }
    // This sits between the question and the answer box, so every pixel it
    // takes is one the buttons lose. As the panel's only shrinkable child
    // (min-height:0 lets a flex item shrink below its content) it absorbs
    // slack on a tall screen and yields it on a short one, scrolling its own
    // list rather than pushing anything off the bottom.
    return '<div class="__fs_flex" style="margin:' + gap + ';padding:.75em .875em;background:#1C1C1E;' +
      'border-radius:.75em;text-align:left;display:flex;flex-direction:column">' +
      '<div style="font-size:.688em;font-weight:600;letter-spacing:.02em;text-transform:uppercase;' +
        'color:#409CFF;margin-bottom:.5em;flex:none">' +
        'Do this instead' +
      '</div>' +
      // Capped in vh, not em: the list is the one part that should give space
      // back when the window is short, and take it when there's room. Below the
      // cap it is simply as tall as its content — no dead space for one task.
      // The cap is a ceiling, not a target — flex shrinking can take it lower
      // still on a screen whose fixed content leaves less room.
      '<div style="max-height:min(14em, 26vh);overflow-y:auto;overscroll-behavior:contain;' +
        'flex:0 1 auto;min-height:0">' +
        list.map(function (t) {
          // A task carrying a link is the shortest path back to the work, so
          // it's a real anchor. The worker opens it in a new tab and the link
          // is already exempt from scanning, so clicking it can't re-trigger
          // the wall on arrival.
          var label = t.url
            ? '<a href="' + esc(t.url) + '" data-fs-task-link="' + esc(t.url) + '" ' +
                'rel="noreferrer noopener" ' +
                'style="font-size:.875em;line-height:1.4;letter-spacing:-.01em;color:#FFFFFF;' +
                'overflow-wrap:anywhere;min-width:0;text-decoration:none;border-bottom:1px solid rgba(64,156,255,.45)">' +
                esc(t.text) +
                '<span style="color:#409CFF;margin-left:.35em;font-size:.85em">&#8599;</span>' +
              '</a>'
            : '<span style="font-size:.875em;line-height:1.4;letter-spacing:-.01em;color:#FFFFFF;' +
                'overflow-wrap:anywhere;min-width:0">' + esc(t.text) + '</span>';
          return '<div style="display:flex;gap:.5em;align-items:baseline;padding:.156em 0">' +
            '<span aria-hidden="true" style="color:#409CFF;flex:none;font-size:.75em">&#8226;</span>' +
            label +
          '</div>';
        }).join("") +
      '</div>' +
    '</div>';
  }

  // ---------- PHASE 1: questions, one at a time ----------
  function renderQuestion() {
    var box = document.createElement("div");
    box.innerHTML =
      dots(questions.length, idx) +
      (data.mark
        ? '<img src="' + esc(data.mark) + '" alt="" aria-hidden="true" ' +
          'style="width:2.25em;height:2.25em;display:block;margin:0 auto .625em;opacity:.95">'
        : '') +
      '<div style="font-size:.813em;font-weight:600;letter-spacing:-.006em;color:#FF2D2A;margin-bottom:.75em">' + esc(data.heading) + '</div>' +
      // Large display type: negative tracking, tight leading — the size-specific
      // typography rule, not one tracking value applied everywhere.
      '<h2 id="__fs_q" style="font-family:inherit;font-size:1.625em;line-height:1.16;letter-spacing:-.028em;color:#fff;font-weight:700;margin:0 0 1em">' + esc(questions[idx]) + '</h2>' +
      // The tasks sit directly above the answer box: the last thing read before
      // typing an excuse should be the work the excuse is competing with.
      todoPanel() +
      '<input id="__fs_in" type="text" autocomplete="off" aria-labelledby="__fs_q" ' +
        'style="width:100%;background:#1C1C1E;border:none;border-radius:.75em;color:#FFFFFF;font-size:1.0625em;padding:.813em 1em;font-family:inherit;text-align:center;letter-spacing:-.01em;transition:box-shadow .16s ' + EASE + '" ' +
        'placeholder="answer honestly, then press Enter…">' +
      '<p style="color:rgba(235,235,245,.60);font-size:.813em;line-height:1.4;letter-spacing:-.006em;margin:.625em 0 1em">Your answers decide if you get in. Be honest — vague excuses fail.</p>' +
      '<div style="display:flex;gap:.625em">' +
        (idx === 0 ? "" : '<button id="__fs_back" style="background:#2C2C2E;border:none;color:#409CFF;border-radius:980px;padding:.875em 1.375em;font-size:1.0625em;font-weight:500;cursor:pointer;font-family:inherit;letter-spacing:-.01em">Back</button>') +
        '<button id="__fs_next" style="flex:1;background:#2C2C2E;color:rgba(235,235,245,.30);border:none;border-radius:980px;padding:.875em;font-weight:600;font-size:1.0625em;cursor:not-allowed;font-family:inherit;letter-spacing:-.01em">' +
          (idx === questions.length - 1 ? "Submit for review" : "Next") + '</button>' +
      '</div>' +
      '<button id="__fs_leave" style="width:100%;margin-top:.875em;background:none;border:none;color:rgba(235,235,245,.60);font-size:.938em;cursor:pointer;font-family:inherit;letter-spacing:-.01em">Leave — I don\'t need this</button>';
    swap(box);

    var input = box.querySelector("#__fs_in");
    var next = box.querySelector("#__fs_next");
    input.focus();
    if (answers[idx]) input.value = answers[idx];
    function ok() { return input.value.trim().length >= 2; }
    function paint() {
      var v = ok();
      next.style.background = v ? "#0A84FF" : "#2C2C2E";
      next.style.color = v ? "#FFFFFF" : "rgba(235,235,245,.30)";
      next.style.cursor = v ? "pointer" : "not-allowed";
      next.style.fontWeight = v ? "600" : "500";
      // aria-disabled (not the disabled attribute) keeps it focusable, so a
      // keyboard user can still reach it and hear why it won't activate.
      next.setAttribute("aria-disabled", v ? "false" : "true");
    }
    paint();
    input.addEventListener("input", paint);
    function go() {
      if (!ok()) return;
      answers[idx] = input.value.trim();
      if (idx === questions.length - 1) { submit(); return; }
      idx++; renderQuestion();
    }
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); go(); } });
    next.addEventListener("click", go);
    var back = box.querySelector("#__fs_back");
    if (back) back.addEventListener("click", function () { idx--; renderQuestion(); });
    box.querySelector("#__fs_leave").addEventListener("click", leave);
  }

  // ---------- PHASE 2: submit answers → AI judges ----------
  function submit() {
    var box = document.createElement("div");
    box.innerHTML =
      '<div role="status" aria-live="polite" style="font-family:inherit;font-size:1.5em;font-weight:600;letter-spacing:-.024em;color:#fff;margin-bottom:.875em">Weighing your reasons…</div>' +
      // A spinner is a continuous animation — under reduced motion, show a
      // static indicator instead of a rotating one.
      (reduceMotion
        ? '<div aria-hidden="true" style="width:2.125em;height:2.125em;border:3px solid #2C2C2E;border-top-color:#409CFF;border-radius:50%;margin:.5em auto"></div>'
        : '<div aria-hidden="true" style="width:2.125em;height:2.125em;border:3px solid #2C2C2E;border-top-color:#409CFF;border-radius:50%;margin:.5em auto;animation:__fsSpin .8s linear infinite"></div>');
    swap(box);
    if (!wrap.querySelector("#__fsSpinKf")) {
      var k = document.createElement("style"); k.id = "__fsSpinKf";
      k.textContent = "@keyframes __fsSpin{to{transform:rotate(360deg)}}"; wrap.appendChild(k);
    }
    try {
      chrome.runtime.sendMessage(
        { type: "judgeAnswers", title: data.title, questions: questions, answers: answers },
        function (resp) {
          if (chrome.runtime.lastError || !resp) { startTypingSafe(""); return; }  // AI dead → typing test
          if (resp.pass) renderPass(resp.reason);
          else startTypingSafe(resp.sentence || "", resp.reason);
        }
      );
    } catch (e) { startTypingSafe(""); }
  }

  // ---------- PASS ----------
  // Both routes end on the same screen so the terms are always stated; the
  // AI's reason, when there is one, is carried through to it.
  function renderPass(reason) { renderGranted(true, reason); }

  // ---------- GRANTED: state the terms before letting go ----------
  // Reached from both routes. legit=true means the AI accepted the reasons;
  // false means the typing test was completed. Same 5 minutes either way, but
  // the wording differs — one was earned, the other was forced, and the tool
  // shouldn't congratulate someone for overriding it.
  function renderGranted(legit, reason) {
    var mins = data.grantMinutes || 5;
    var box = document.createElement("div");
    box.innerHTML =
      // Sized to match the question screen. This screen carries the most fixed
      // content of any step — mark, headline, clock card, terms, two buttons —
      // so oversized display type here was what pushed it off both ends.
      (data.mark
        ? '<img src="' + esc(data.mark) + '" alt="" aria-hidden="true" ' +
          'style="width:2.25em;height:2.25em;display:block;margin:0 auto .5em;opacity:.9">'
        : '<div aria-hidden="true" style="font-size:2.25em;margin-bottom:.375em">' + (legit ? "✓" : "⏱") + '</div>') +
      '<h2 role="status" style="font-family:inherit;font-size:1.5em;line-height:1.16;letter-spacing:-.028em;color:' +
        (legit ? "#46C45B" : "#FFFFFF") + ';font-weight:700;margin:0 0 .625em">' +
        (legit ? "Fair enough. You're in." : "You typed it out. Fine.") + '</h2>' +
      '<div style="background:#1C1C1E;border-radius:.75em;padding:.813em 1em;margin-bottom:1em">' +
        '<div style="font-size:1.875em;font-weight:700;letter-spacing:-.028em;color:#409CFF;' +
          'font-variant-numeric:tabular-nums;line-height:1.1">' + mins + ':00</div>' +
        '<div style="font-size:.938em;color:#FFFFFF;letter-spacing:-.014em;margin-top:.375em">' +
          'Nice Try is off' +
        '</div>' +
        '<div style="font-size:.813em;color:rgba(235,235,245,.60);letter-spacing:-.006em;margin-top:.125em">' +
          'Nothing is blocked or tracked until it ends' +
        '</div>' +
      '</div>' +
      (legit && reason
        ? '<p style="color:rgba(235,235,245,.60);font-size:.938em;line-height:1.45;letter-spacing:-.01em;margin:0 0 .75em">' +
          esc(reason) + '</p>'
        : '') +
      '<p style="color:rgba(235,235,245,.60);font-size:.875em;line-height:1.4;letter-spacing:-.01em;margin:0 0 1.125em">' +
        (legit
          ? "The clock starts when you continue. When it runs out, everything is watched again."
          : "This wasn't earned, so it isn't remembered — you'll have to justify this page again next time.") +
      '</p>' +
      '<button id="__fs_enter" style="background:#0A84FF;color:#FFFFFF;border:none;border-radius:980px;padding:.875em 2em;' +
        'font-weight:600;font-size:1.0625em;cursor:pointer;font-family:inherit;letter-spacing:-.01em">Start the ' + mins + ' minutes</button>' +
      '<button id="__fs_leave2" style="width:100%;margin-top:.875em;background:none;border:none;' +
        'color:rgba(235,235,245,.60);font-size:.938em;cursor:pointer;font-family:inherit;letter-spacing:-.01em">' +
        'Actually, take me back to work</button>' +
      // On the grant screen the tasks trail rather than lead — access is
      // already won, so this is a parting reminder, not the argument. The
      // wrapper must carry __fs_flex too: as a bare child of the flex column it
      // was pinned at full height by the blanket flex:none rule, so a long list
      // pushed this screen off both ends instead of scrolling inside the card.
      // The card carries a bottom margin for the question screen, where the
      // input follows it. Here it is last, so that margin is cancelled rather
      // than left as dead space above the panel's own padding.
      '<div class="__fs_flex" style="margin-top:1.25em;display:flex;flex-direction:column">' +
        todoPanel(true) +
      '</div>';
    swap(box);
    var go = box.querySelector("#__fs_enter");
    go.focus();
    go.addEventListener("click", function () { grantAndExit(legit); });
    box.querySelector("#__fs_leave2").addEventListener("click", leave);
  }

  // ---------- FAIL → 15 words, 3 minutes, retry on timeout ----------
  function startTyping(sentence, reason) {
    var LIMIT = 180;                     // 3 minutes
    var remaining = LIMIT;

    function draw(sent) {
      var box = document.createElement("div");
      box.innerHTML =
        '<div style="font-size:.813em;font-weight:600;letter-spacing:-.006em;color:#FF2D2A;margin-bottom:.875em">Not convincing enough</div>' +
        '<h2 style="font-family:inherit;font-size:1.625em;line-height:1.18;letter-spacing:-.028em;color:#fff;font-weight:700;margin:0 0 .5em">If you really need this, earn it.</h2>' +
        (reason ? '<p style="color:rgba(235,235,245,.60);font-size:.875em;line-height:1.45;letter-spacing:-.01em;margin:0 0 .5em">' + esc(reason) + '</p>' : '') +
        '<p id="__fs_lbl" style="color:rgba(235,235,245,.60);font-size:.938em;line-height:1.45;letter-spacing:-.01em;margin:0 0 1.125em">Type these 15 words within the time. Miss it and you get a fresh set.</p>' +
        // Rounded, tabular numerals — the iOS timer treatment. The digits must
        // not reflow as the countdown ticks.
        '<div id="__fs_clock" role="timer" aria-live="off" style="font-size:2.25em;font-weight:600;letter-spacing:-.02em;color:#409CFF;font-variant-numeric:tabular-nums;margin-bottom:1em;transition:color .28s ' + EASE + '">3:00</div>' +
        '<div style="background:#1C1C1E;border:none;border-radius:.75em;padding:1em;font-size:1.0625em;line-height:1.65;letter-spacing:-.01em;color:#409CFF;user-select:none;margin-bottom:.75em">' + esc(sent) + '</div>' +
        '<textarea id="__fs_in" rows="2" spellcheck="false" autocomplete="off" aria-labelledby="__fs_lbl" ' +
          'style="width:100%;background:#1C1C1E;border:none;border-radius:.75em;color:#FFFFFF;font-size:1.0625em;line-height:1.65;letter-spacing:-.01em;padding:.875em;font-family:inherit;resize:none;text-align:center;transition:box-shadow .16s ' + EASE + '" ' +
          'placeholder="type the 15 words, all lowercase…"></textarea>' +
        '<p id="__fs_hint" role="status" aria-live="polite" style="color:#FF2D2A;font-size:.813em;line-height:1.4;letter-spacing:-.006em;min-height:1em;margin:.625em 0 1.125em"></p>' +
        '<button id="__fs_leave" style="width:100%;background:#2C2C2E;border:none;color:rgba(235,235,245,.60);border-radius:980px;padding:.875em;font-size:1.0625em;font-weight:500;cursor:pointer;font-family:inherit;letter-spacing:-.01em">Give up — leave the site</button>';
      swap(box);

      var input = box.querySelector("#__fs_in");
      var clock = box.querySelector("#__fs_clock");
      var hint = box.querySelector("#__fs_hint");
      input.focus();

      if (timerHandle) clearInterval(timerHandle);
      remaining = LIMIT;
      timerHandle = setInterval(function () {
        remaining--;
        var mm = Math.floor(remaining / 60), ss = remaining % 60;
        clock.textContent = mm + ":" + (ss < 10 ? "0" : "") + ss;
        clock.style.color = remaining <= 30 ? "#FF2D2A" : "#409CFF";
        if (remaining <= 0) {
          clearInterval(timerHandle); timerHandle = null;
          // fresh words + fresh timer
          try {
            chrome.runtime.sendMessage({ type: "newSentence" }, function (r) {
              draw((r && r.sentence) ? r.sentence : sent);
            });
          } catch (e) { draw(sent); }
        }
      }, 1000);

      input.addEventListener("input", function () {
        if (input.value.trim() === sent) {
          clearInterval(timerHandle); timerHandle = null;
          // Don't dump the user straight onto the page. Say what they've been
          // given and for how long, so the block ending is a decision they
          // acknowledge rather than something that just stops happening.
          renderGranted(false);
        } else if (input.value) {
          hint.textContent = "Doesn't match — type all 15 words exactly, lowercase.";
        } else { hint.textContent = ""; }
      });
      box.querySelector("#__fs_leave").addEventListener("click", leave);
    }
    draw(sentence);
  }

  // if the typing test is reached without a sentence (AI dead), fetch one first
  function startTypingSafe(sentence, reason) {
    if (sentence) { startTyping(sentence, reason); return; }
    try {
      chrome.runtime.sendMessage({ type: "newSentence" }, function (r) {
        startTyping((r && r.sentence) ? r.sentence : "focus work study code build learn grow steady honest patient effort matter choice moment reason", reason);
      });
    } catch (e) {
      startTyping("focus work study code build learn grow steady honest patient effort matter choice moment reason", reason);
    }
  }

  // start
  if (!questions.length) { startTypingSafe(""); }
  else renderQuestion();
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
  if (!enabled) { log("[GS] disabled"); return; }

  // Paused: the extension is genuinely off, not just permissive. No
  // classification, no time attributed, no wall. Checked before anything else
  // so the pause costs nothing and can't be half-applied.
  await loadPause();
  if (isPaused()) {
    lastTickTs = 0;              // don't back-count the paused stretch on return
    junkStreak = 0; lastNudgeAt = 0;
    updatePauseBadge();
    return;
  }
  // pause just ended — clear the badge and start counting cleanly
  if (pausedUntil) { pausedUntil = 0; persistPause(); lastTickTs = 0; updatePauseBadge(); }

  let tab;
  try {
    let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs[0]) tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
  } catch (e) { log("[GS] tabs.query failed", e); return; }
  if (!tab || !tab.title) { log("[GS] no active tab/title"); return; }

  // Are you actually sitting here? If Chrome is behind another app, minimised,
  // or the machine is idle, this tab costs nothing: no time logged, no streak,
  // no AI call. A tab you opened and left is invisible to us.
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

  const title = tab.title;
  // dwell = uninterrupted PRESENT time on this same title; resets when it changes
  const titleKey = normalizeTitle(title);
  if (titleKey !== lastTitle) { dwellSeconds = 0; lastTitle = titleKey; }
  dwellSeconds += elapsed;

  const category = await classify(title, tab.url, dwellSeconds);
  log("[GS] \"" + title + "\" → " + category +
              " | dwell=" + Math.round(dwellSeconds) + "s" +
              " | streak=" + Math.round(junkStreak) + "s");

  // log time: "unsure" counts toward junk for the scoreboard (it's un-verified time)
  const logBucket = (category === "unsure") ? "junk" : category;
  await logTime(logBucket, elapsed, title, tab.url);

  // both "junk" and "unsure" get nudged; "unsure" shows the self-check variant
  if (category === "junk" || category === "unsure") {
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

    const dueFirst = (lastNudgeAt === 0 && junkStreak >= GRACE_SECONDS);
    const dueAgain = (lastNudgeAt > 0 && (junkStreak - lastNudgeAt) >= RENUDGE_SECONDS);
    if (!wallUp && (dueFirst || dueAgain)) {
      lastNudgeAt = junkStreak;
      log("[GS] 🔒 " + (category === "unsure" ? "SELF-CHECK" : "LOCKING") + " tab " + tab.id);
      await nudge(tab.id, title, junkStreak, category);
    }
  } else {
    junkStreak = 0;
    lastNudgeAt = 0;
  }

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

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("keepAlive", { periodInMinutes: 1 });
  pruneTaskHostAllows();
  startLoop();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("keepAlive", { periodInMinutes: 1 });
  pruneTaskHostAllows();
  startLoop();
});
// keep-alive: if the worker was asleep, this wakes it and the loop resumes
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepAlive") { tick(); startLoop(); }
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
  var keep = setInterval(function () {
    if (document.getElementById("__focusshield__")) { clearInterval(keep); d.remove(); return; }
    if (!d.isConnected && document.documentElement) document.documentElement.appendChild(d);
  }, 50);
  setTimeout(function () { clearInterval(keep); }, 15000);
}

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;             // main frame only
  await locksReady;
  const mark = lockedTabs.get(details.tabId);
  if (!mark) return;
  // Navigating AWAY to a different site is the outcome we want — let it go.
  if (hostOf(details.url) !== mark.host) {
    lockedTabs.delete(details.tabId); persistLocks(); return;
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
  // rather than seeing a stale "already nudged" timer.
  lastNudgeAt = 0;
  tick();
});

chrome.tabs.onRemoved.addListener((id) => {
  if (lockedTabs.delete(id)) persistLocks();
});

// kick the loop the moment this worker script loads
pruneTaskHostAllows();
startLoop();

// ---- messages from popup -----------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // gauntlet passed → grant this host 5 minutes and reset the streak so it
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
  if (msg.type === "closeTab") {
    if (sender && sender.tab && sender.tab.id != null) {
      try { chrome.tabs.remove(sender.tab.id); } catch (e) {}
    }
    return;
  }

  if (msg.type === "grantAccess") {
    // Derive the host from the SENDER's real URL, never from the message body —
    // otherwise any script in a blocked page can post {host:"youtube.com"} and
    // grant itself access. msg.host is only a fallback for senders with no URL.
    const host = hostOf(sender && sender.url ? sender.url : "") || msg.host;
    if (host) {
      pausedUntil = Date.now() + GRANT_MS;   // whole extension stands down
      persistPause();
      updatePauseBadge();
      log("[GS] ✅ " + (msg.legit ? "AI-approved" : "typing-test") + " access to " + host + " for 5 min");
    }
    // ONLY cache the title as productive when the AI genuinely approved it.
    // Forcing in via the typing test is an override, not an endorsement — it is
    // never remembered, so you must justify the same title again next time.
    // The title comes from the sender's real tab, not the message body, so a
    // page can't poison the cache for a title it doesn't actually have.
    (async () => {
      let realTitle = "";
      if (sender && sender.tab && sender.tab.id != null) {
        try { realTitle = (await chrome.tabs.get(sender.tab.id)).title || ""; } catch (e) {}
      }
      let key = "";
      if (msg.legit && realTitle) {
        key = await cacheKeyFor(normalizeTitle(realTitle).toLowerCase());
        verdictCache.set(key, "productive");
        persistCache();
        log("[GS] 🧠 remembered AI-approved title");
      }
      // Record BOTH kinds of pass — the typing-test ones matter most here,
      // since those are the times you overrode the block rather than earned it.
      await recordAccess(host, realTitle || msg.title || "", !!msg.legit, key);
    })();
    junkStreak = 0;
    lastNudgeAt = 0;
    // The wall came down legitimately — stop re-covering this tab's reloads.
    if (sender && sender.tab && sender.tab.id != null && lockedTabs.delete(sender.tab.id)) persistLocks();
    if (sendResponse) sendResponse({ ok: true, host });
    return true;
  }

  // A link was attached to a to-do. Nothing is written to the allow-list —
  // the exemption is derived from the to-do list per page. This just clears
  // the streak so a tab already sitting on that page stops being walled.
  if (msg.type === "taskLinkAdded") {
    junkStreak = 0; lastNudgeAt = 0;
    return;
  }

  // ---- pause state (popup banner) ----
  if (msg.type === "pauseState") {
    (async () => { await loadPause(); sendResponse({ pausedUntil }); })();
    return true;
  }

  // Ending the pause early is always allowed — it only ever costs the user
  // time they'd already earned, so there's nothing to guard against.
  if (msg.type === "endPause") {
    pausedUntil = 0;
    persistPause();
    updatePauseBadge();
    junkStreak = 0; lastNudgeAt = 0; lastTickTs = 0;
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
      try {
        // fixed mission so this tests API reachability, not the user's own config
        const v = await aiRelevant("Two Sum - LeetCode", [], apiKey, "learning to code");
        sendResponse({ state: "ok", provider: providerOf(apiKey), sample: v });
      } catch (e) {
        sendResponse({ state: "error", provider: providerOf(apiKey), err: lastAiError || String(e.message || e) });
      }
    })();
    return true;
  }

  if (msg.type === "testLock") {
    (async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab) { sendResponse({ ok: false, err: "no active tab" }); return; }
      try {
        await nudge(tab.id, tab.title || "(this tab)", GRACE_SECONDS);
        sendResponse({ ok: true, title: tab.title });
      } catch (e) {
        sendResponse({ ok: false, err: String(e) });
      }
    })();
    return true; // async response
  }
});
