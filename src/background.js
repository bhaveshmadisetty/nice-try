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

// hostname -> ms timestamp until which access is granted (after passing the gauntlet)
const grantedUntil = {};
const GRANT_MS = 5 * 60 * 1000;   // 5 minutes of access per successful gauntlet
function isGranted(host) { return host && grantedUntil[host] && Date.now() < grantedUntil[host]; }

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
    todos: (d.todos || []).map(t => (typeof t === "string" ? t : t && t.text) || "").filter(Boolean),
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
async function logTime(category, seconds, title) {
  const { log } = await getState();
  const day = todayKey();
  if (!log[day]) log[day] = { productive: 0, junk: 0, neutral: 0, sites: {} };
  log[day][category] += seconds;
  // track per-title time too — normalize first so "(3) WhatsApp" and "WhatsApp"
  // merge into one row instead of fragmenting the breakdown.
  const label = shortLabel(normalizeTitle(title));
  log[day].sites[label] = (log[day].sites[label] || 0) + seconds;
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
  // recently unlocked via the gauntlet — grant is time-limited (5 min)
  if (isGranted(host)) return "neutral";
  // search engines & AI assistants — never blocked (this is how work gets done).
  // YouTube search is deliberately NOT here; that's browsing, not researching.
  if (hostInList(host, SEARCH_HOSTS)) return "neutral";
  // allowlisted domains (built-in list + the user's own) — always productive
  const { allowDomains } = await getState();
  if (domainAllowed(host, allowDomains)) return "productive";
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

// ---- Nice Try: opaque wall + gauntlet ------------------------
async function nudge(tabId, title, streakSec, mode) {
  const { todos, apiKey, mission } = await getState();
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

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: showShield,
      args: [{ heading, fomo, todos: todos || [], questions, host, title }]
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

  var wrap = document.createElement("div");
  wrap.id = ID;
  wrap.style.cssText = [
    "position:fixed","inset:0","z-index:2147483647","background:#0E0C0A",
    "display:flex","align-items:center","justify-content:center",
    "font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif",
    "color:#ECE6DC","animation:__fsIn .3s ease"
  ].join(";");
  var st = document.createElement("style");
  st.textContent =
    "@keyframes __fsIn{from{opacity:0}to{opacity:1}}" +
    "@keyframes __fsStep{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}" +
    "#" + ID + " ::placeholder{color:#5c554c}";
  wrap.appendChild(st);
  document.documentElement.appendChild(wrap);

  function cleanup() {
    clearInterval(freezer);
    if (timerHandle) clearInterval(timerHandle);
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
    node.style.cssText = "max-width:520px;width:100%;padding:32px 28px;text-align:center;animation:__fsStep .28s ease";
    wrap.appendChild(node);
  }
  function dots(count, at, color) {
    var d = "";
    for (var i = 0; i < count; i++) {
      var c = i < at ? "#68A98A" : (i === at ? (color || "#D9A54E") : "#302A22");
      var w = i === at ? "22px" : "7px";
      d += '<span style="height:7px;width:' + w + ';border-radius:20px;background:' + c + ';transition:.3s"></span>';
    }
    return '<div style="display:flex;gap:6px;justify-content:center;margin-bottom:32px">' + d + '</div>';
  }

  // ---------- PHASE 1: questions, one at a time ----------
  function renderQuestion() {
    var box = document.createElement("div");
    box.innerHTML =
      dots(questions.length, idx) +
      '<div style="font-family:monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#CF6F76;margin-bottom:18px">🛡 ' + esc(data.heading) + '</div>' +
      '<div style="font-family:Georgia,serif;font-size:25px;line-height:1.35;color:#fff;font-weight:700;margin-bottom:26px">' + esc(questions[idx]) + '</div>' +
      '<input id="__fs_in" type="text" autocomplete="off" ' +
        'style="width:100%;background:#141110;border:1px solid #302A22;border-radius:10px;color:#ECE6DC;font-size:16px;padding:14px 16px;font-family:inherit;text-align:center" ' +
        'placeholder="answer honestly, then press Enter…">' +
      '<p style="color:#6F675D;font-size:11.5px;margin:10px 0 22px">Your answers decide if you get in. Be honest — vague excuses fail.</p>' +
      '<div style="display:flex;gap:10px">' +
        (idx === 0 ? "" : '<button id="__fs_back" style="background:none;border:1px solid #302A22;color:#A79D91;border-radius:10px;padding:13px 18px;font-size:14px;cursor:pointer">Back</button>') +
        '<button id="__fs_next" style="flex:1;background:#302A22;color:#6F675D;border:none;border-radius:10px;padding:13px;font-weight:700;font-size:15px;cursor:not-allowed;transition:.15s">' +
          (idx === questions.length - 1 ? "Submit for review" : "Next") + '</button>' +
      '</div>' +
      '<button id="__fs_leave" style="width:100%;margin-top:12px;background:none;border:none;color:#6F675D;font-size:12.5px;cursor:pointer;text-decoration:underline">Leave — I don\'t need this</button>';
    swap(box);

    var input = box.querySelector("#__fs_in");
    var next = box.querySelector("#__fs_next");
    input.focus();
    if (answers[idx]) input.value = answers[idx];
    function ok() { return input.value.trim().length >= 2; }
    function paint() {
      var v = ok();
      next.style.background = v ? "#D9A54E" : "#302A22";
      next.style.color = v ? "#1B1206" : "#6F675D";
      next.style.cursor = v ? "pointer" : "not-allowed";
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
      '<div style="font-family:Georgia,serif;font-size:24px;color:#fff;margin-bottom:14px">Weighing your reasons…</div>' +
      '<div style="width:34px;height:34px;border:3px solid #302A22;border-top-color:#D9A54E;border-radius:50%;margin:8px auto;animation:__fsSpin .8s linear infinite"></div>';
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
  function renderPass(reason) {
    var box = document.createElement("div");
    box.innerHTML =
      '<div style="font-size:44px;margin-bottom:12px">✓</div>' +
      '<div style="font-family:Georgia,serif;font-size:26px;color:#68A98A;font-weight:700;margin-bottom:10px">Fair enough. You\'re in.</div>' +
      (reason ? '<p style="color:#A79D91;font-size:14px;margin:0 0 22px">' + esc(reason) + '</p>' : '<p style="color:#A79D91;font-size:14px;margin:0 0 22px">5 minutes. Use them well, then get back to it.</p>') +
      '<button id="__fs_enter" style="background:#D9A54E;color:#1B1206;border:none;border-radius:10px;padding:13px 30px;font-weight:700;font-size:15px;cursor:pointer">Enter the site</button>';
    swap(box);
    box.querySelector("#__fs_enter").addEventListener("click", function () { grantAndExit(true); });  // AI approved → legit
  }

  // ---------- FAIL → 15 words, 3 minutes, retry on timeout ----------
  function startTyping(sentence, reason) {
    var LIMIT = 180;                     // 3 minutes
    var remaining = LIMIT;

    function draw(sent) {
      var box = document.createElement("div");
      box.innerHTML =
        '<div style="font-family:monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#CF6F76;margin-bottom:14px">Not convincing enough</div>' +
        '<div style="font-family:Georgia,serif;font-size:23px;line-height:1.35;color:#fff;font-weight:700;margin-bottom:8px">If you really need this, earn it.</div>' +
        (reason ? '<p style="color:#A79D91;font-size:13.5px;margin:0 0 8px">' + esc(reason) + '</p>' : '') +
        '<p style="color:#A79D91;font-size:14px;margin:0 0 18px">Type these 15 words within the time. Miss it and you get a fresh set.</p>' +
        '<div style="font-family:monospace;font-size:26px;font-weight:800;color:#D9A54E;margin-bottom:16px" id="__fs_clock">3:00</div>' +
        '<div style="background:#141110;border:1px solid #302A22;border-radius:10px;padding:15px;font-size:16px;line-height:1.7;color:#D9A54E;user-select:none;margin-bottom:12px">' + esc(sent) + '</div>' +
        '<textarea id="__fs_in" rows="2" spellcheck="false" autocomplete="off" ' +
          'style="width:100%;background:#141110;border:1px solid #302A22;border-radius:10px;color:#ECE6DC;font-size:16px;line-height:1.7;padding:13px;font-family:inherit;resize:none;text-align:center" ' +
          'placeholder="type the 15 words, all lowercase…"></textarea>' +
        '<p id="__fs_hint" style="color:#CF6F76;font-size:12px;min-height:15px;margin:9px 0 18px"></p>' +
        '<button id="__fs_leave" style="width:100%;background:none;border:1px solid #302A22;color:#A79D91;border-radius:10px;padding:12px;font-size:13px;cursor:pointer">Give up — leave the site</button>';
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
        clock.style.color = remaining <= 30 ? "#CF6F76" : "#D9A54E";
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
          grantAndExit(false);   // forced in via typing test → NOT cached
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
  await logTime(logBucket, elapsed, title);

  // both "junk" and "unsure" get nudged; "unsure" shows the self-check variant
  if (category === "junk" || category === "unsure") {
    // First time this tab is judged junk, credit the time already spent here.
    // Without this the AI's 30s wait would push the lock out to 30+45=75s;
    // with it, the lock still lands at ~GRACE_SECONDS of real presence.
    if (junkStreak === 0 && dwellSeconds > elapsed) junkStreak = dwellSeconds - elapsed;
    junkStreak += elapsed;
    const dueFirst = (lastNudgeAt === 0 && junkStreak >= GRACE_SECONDS);
    const dueAgain = (lastNudgeAt > 0 && (junkStreak - lastNudgeAt) >= RENUDGE_SECONDS);
    if (dueFirst || dueAgain) {
      lastNudgeAt = junkStreak;
      log("[GS] 🔒 " + (category === "unsure" ? "SELF-CHECK" : "LOCKING") + " tab " + tab.id);
      await nudge(tab.id, title, junkStreak, category);
    }
  } else {
    junkStreak = 0;
    lastNudgeAt = 0;
  }

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
  startLoop();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("keepAlive", { periodInMinutes: 1 });
  startLoop();
});
// keep-alive: if the worker was asleep, this wakes it and the loop resumes
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepAlive") { tick(); startLoop(); }
});

// tick immediately on tab switches / title changes for snappy reset + detect
chrome.tabs.onActivated.addListener(() => tick());
chrome.tabs.onUpdated.addListener((id, info) => { if (info.title || info.status === "complete") tick(); });

// kick the loop the moment this worker script loads
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
      grantedUntil[host] = Date.now() + GRANT_MS;   // 5-min access either way
      log("[GS] ✅ " + (msg.legit ? "AI-approved" : "typing-test") + " access to " + host + " for 5 min");
    }
    // ONLY cache the title as productive when the AI genuinely approved it.
    // Forcing in via the typing test is an override, not an endorsement — it is
    // never remembered, so you must justify the same title again next time.
    // The title comes from the sender's real tab, not the message body, so a
    // page can't poison the cache for a title it doesn't actually have.
    if (msg.legit && sender && sender.tab && sender.tab.id != null) {
      (async () => {
        let realTitle = "";
        try { realTitle = (await chrome.tabs.get(sender.tab.id)).title || ""; } catch (e) {}
        if (!realTitle) return;
        const key = await cacheKeyFor(normalizeTitle(realTitle).toLowerCase());
        verdictCache.set(key, "productive");
        persistCache();
        log("[GS] 🧠 remembered AI-approved title");
      })();
    }
    junkStreak = 0;
    lastNudgeAt = 0;
    if (sendResponse) sendResponse({ ok: true, host });
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
