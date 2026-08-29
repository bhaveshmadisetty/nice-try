// welcome.js — first-run setup. Opens once, on install.
//
// The extension's whole argument is that it judges what you're doing rather than
// where you are, and that judgment needs two things it cannot invent: a mission
// to measure against, and (for the ambiguous cases) an API key. Without them it
// degrades to a domain blocker — the exact product it exists to replace. Leaving
// both in a settings page nobody is told about meant most installs never saw the
// thing that makes this worth having.
//
// So: ask on install, when intent is highest. Every step after the mission is
// skippable, and the demo puts the payoff on screen before anything is asked of
// the user's time or trust.

const el = id => document.getElementById(id);

// ---------- storage ----------
// Opened as a file:// URL — which is how this page gets previewed during
// development — `chrome` exists but `chrome.storage` does not, so every
// `chrome.storage.local.*` call throws a TypeError. Because the callers are
// async, that rejection is swallowed and the step silently fails to advance:
// Continue looks broken while Skip works, since only one of them touches
// storage.
//
// Nothing here can be persisted without the extension APIs, and that is fine —
// the flow is still worth walking through. So reads return empty and writes are
// dropped, and navigation continues either way. A real storage failure inside
// the extension is reported rather than swallowed.
const hasStorage = typeof chrome !== "undefined" &&
                   chrome.storage && chrome.storage.local;

async function storeGet(keys) {
  if (!hasStorage) return {};
  try {
    return await chrome.storage.local.get(keys);
  } catch (e) {
    console.warn("[Nice Try] storage read failed:", e);
    return {};
  }
}

async function storeSet(obj) {
  if (!hasStorage) return false;
  try {
    await chrome.storage.local.set(obj);
    return true;
  } catch (e) {
    console.warn("[Nice Try] storage write failed:", e);
    return false;
  }
}

const STEPS = ["s0", "s1", "sPerm", "s2", "s3"];
let at = 0;

// One illustration per step, but there are five steps and four SVGs — the
// permission step borrows the demo's diagram rather than shipping a fifth. An
// explicit map, because the art no longer lines up with the step index and an
// off-by-one here shows the wrong picture rather than throwing.
const ART_FOR = { s0: 0, s1: 1, sPerm: 1, s2: 2, s3: 3 };

// Steps are referred to by name, not by number. A step inserted in the middle
// used to mean hunting down every show(2) in the file and deciding whether it
// still meant what it said.
function stepAt(id) { return STEPS.indexOf(id); }

// ---------- the shared action bar ----------
// Both buttons live in the window's footer, outside the steps, so they hold one
// position for the whole flow instead of jumping as each screen's content
// changes height. That means a step cannot own its own buttons — it declares
// what the bar should say and do, and `show()` wires it up.
//
// A table rather than a switch inside show(): each step's two actions sit next
// to each other where they can be read as a pair, and adding a step is one entry
// instead of edits in four places.
const primary = el("primary");
const secondary = el("secondary");
const back = el("back");

// `back:false` means this step is a dead end going backwards. Step 1 has nowhere
// to go; every other step can be revisited, including the final one — setup is
// already saved by then, so returning to change the key is harmless.
const BAR = {
  // Continue is gated on a usable mission; `enabled` is re-checked on every
  // keystroke, not just on arrival.
  s0: {
    back: false,
    primary: { label: "Continue", act: saveMission, enabled: () => missionOk() },
    secondary: { label: "Skip", act: () => { show(stepAt("s1")); runDemo(); } }
  },
  // Nothing to skip past on the demo — it costs one click and is the reason the
  // rest of the setup is worth finishing. A lone Continue, centred trust line.
  s1: {
    back: true,
    primary: { label: "Continue", act: () => show(stepAt("sPerm")) },
    secondary: null
  },
  // The grant button is inside the step (a permission request must fire from a
  // real user gesture), so the bar's primary is only ever "move on". It stays
  // enabled without the grant: refusing to let someone past a permission ask is
  // how a setup flow becomes a hostage situation. The popup keeps surfacing it
  // as an unfinished step, which is the honest amount of pressure.
  sPerm: {
    back: true,
    primary: { label: "Continue", act: () => show(stepAt("s2")) },
    secondary: { label: "Not now", act: () => show(stepAt("s2")) }
  },
  s2: {
    back: true,
    primary: { label: "Continue", act: saveKey },
    secondary: { label: "Skip for now", act: finishSetup }
  },
  // The last screen's primary is the demo wall; "Done" closes the tab.
  s3: {
    back: true,
    primary: { label: "Show me the wall", act: openDemoWall },
    secondary: { label: "Done", act: closeTab }
  }
};

// Going back must not re-run a step's side effects. Moving forward off the
// mission step saves it and starts the demo; stepping back to it should just
// show it again. So this only moves the index — never calls saveMission,
// finishSetup or runDemo.
function goBack() {
  if (at <= 0) return;
  show(at - 1);
}

// Repainting only the disabled state, called from the mission input as well as
// from show(). Split out so a keystroke doesn't rebuild labels and handlers.
function paintBar() {
  const cfg = BAR[STEPS[at]];
  const ok = !cfg.primary.enabled || cfg.primary.enabled();
  primary.setAttribute("aria-disabled", ok ? "false" : "true");
}

function wireBar() {
  const cfg = BAR[STEPS[at]];

  primary.textContent = cfg.primary.label;
  primary.onclick = () => {
    // Re-check rather than trusting the attribute: aria-disabled does not stop a
    // click the way the disabled property would, and it is deliberately not
    // `disabled` here so the control stays focusable and screen-reader visible.
    const cur = BAR[STEPS[at]].primary;
    if (cur.enabled && !cur.enabled()) return;
    cur.act();
  };

  if (cfg.secondary) {
    secondary.hidden = false;
    secondary.textContent = cfg.secondary.label;
    secondary.onclick = () => BAR[STEPS[at]].secondary.act();
  } else {
    secondary.hidden = true;
    secondary.onclick = null;
  }

  back.hidden = !cfg.back;

  paintBar();
}

// `initial` on first paint: there's been no step change to announce, and moving
// focus before the user has done anything just steals it from the document.
function show(i, initial) {
  at = Math.max(0, Math.min(STEPS.length - 1, i));
  STEPS.forEach((id, n) => { el(id).hidden = n !== at; });

  // One illustration per step. A single image reused across all four would stop
  // being read after the first screen; changing it is what marks progress in the
  // corner of the eye, before the numbers are consciously read.
  //
  // classList, not `.hidden`: these are SVG elements, and `hidden` is not a
  // reflected IDL property on SVGElement — assigning it silently does nothing.
  const wantArt = ART_FOR[STEPS[at]];
  [0, 1, 2, 3].forEach((n) => { el("art" + n).classList.toggle("off", n !== wantArt); });

  // Step 2's diagram animates as a sequence. Restart it on every arrival —
  // Back makes revisiting an ordinary path, and a diagram that only ever
  // assembles once would sit half-finished the second time.
  //
  // Removing the class, forcing a reflow, then re-adding it is what actually
  // restarts a CSS animation; toggling alone is coalesced into no change at all
  // before the next paint.
  const diagram = el("art1");
  if (diagram) {
    diagram.classList.remove("is-live");
    // Only the demo step re-runs the sequence. The permission step shows the
    // same diagram, but as a settled picture — re-animating it there would
    // pull the eye back to the illustration on the one screen whose whole job
    // is to get a button pressed.
    if (STEPS[at] === "s1") {
      void diagram.getBoundingClientRect();
      diagram.classList.add("is-live");
    }
  }

  // The permission step's button must reflect a grant that may have been made
  // on a previous visit, or revoked in Chrome's settings since.
  if (STEPS[at] === "sPerm") paintPerm();

  // A filled rail plus "Step 2 of 5". Anonymous pips never answered the only
  // question a setup screen is actually asked — how much more is there.
  el("railFill").style.width = ((at + 1) / STEPS.length * 100) + "%";
  el("progN").textContent = "Step " + (at + 1) + " of " + STEPS.length;

  wireBar();

  // Move focus to the new step's heading so a screen reader announces the change
  // rather than leaving the user on a button that just changed label underneath
  // them — the bar persists across steps, so without this there is nothing at
  // all to signal that the screen moved.
  if (!initial) {
    const h = el(STEPS[at]).querySelector("h1");
    if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
    window.scrollTo({ top: 0, behavior: "auto" });
  }
}

// ---------- step 1: mission ----------
const mission = el("mission");

// A one-word mission is worse than none — it gives the classifier nothing to
// judge against while looking like it was answered. Twelve characters is the
// same floor the wall uses before it will quote a mission back at you.
const MIN_MISSION = 12;
function missionOk() { return mission.value.trim().length >= MIN_MISSION; }

// Must match the textarea's maxlength in welcome.html. A tight ceiling is the
// right call: the mission is quoted back on the wall and fed to the classifier,
// and two sharp lines judge better than a paragraph that dilutes the signal.
const MAX_MISSION = 180;

function paintCount() {
  // maxlength only limits typing — it does not touch a value set from script.
  // A mission saved under the old, longer limit would otherwise load intact and
  // show an impossible "300 / 180", so clamp here rather than trusting the
  // attribute to have done it.
  if (mission.value.length > MAX_MISSION) {
    mission.value = mission.value.slice(0, MAX_MISSION);
  }

  const n = mission.value.trim().length;
  const ok = missionOk();

  // Reads as a budget — "how much room do I have" — rather than a demand, which
  // is what a bare countdown to a minimum becomes on an empty field. It turns
  // green the moment the field is actually long enough to be useful, so the
  // threshold is still communicated without ever nagging about it.
  const c = el("mCount");
  c.classList.toggle("ok", ok);
  // Turns amber over 90% so running out of room is visible before it bites,
  // rather than the text simply stopping mid-word with no explanation.
  c.classList.toggle("near", n > MAX_MISSION * 0.9);
  c.textContent = n + " / " + MAX_MISSION;

  paintBar();
}
mission.addEventListener("input", paintCount);

// Types `text` into the mission field character by character, fast at the start
// and easing to a stop. The point is not decoration: an instant fill leaves you
// unsure whether the box was filled or was already like that, whereas watching
// it type makes the field unmistakably yours and puts your eye at the end of the
// sentence, which is exactly where editing continues.
//
// Driven by requestAnimationFrame against elapsed time rather than a per-character
// setInterval — a fixed interval cannot ease, and would drift under load.
let typing = null;
function typeInto(text) {
  // Cancel a run already in flight so tapping two chips quickly cannot interleave
  // two sentences into the same field.
  if (typing) cancelAnimationFrame(typing);

  const full = text.slice(0, MAX_MISSION);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    mission.value = full;
    typing = null;
    paintCount();
    mission.setSelectionRange(full.length, full.length);
    return;
  }

  // Long enough to read as typing, short enough never to be in the way. Scales
  // with length so a short mission does not crawl.
  const dur = Math.min(420 + full.length * 5.5, 900);
  const start = performance.now();

  const step = (now) => {
    const t = Math.min((now - start) / dur, 1);
    // easeOutQuart: fast out of the gate, long settle — the same decelerating
    // character as --ease, so this moves like everything else on the page.
    const eased = 1 - Math.pow(1 - t, 4);
    const n = Math.round(eased * full.length);

    mission.value = full.slice(0, n);
    paintCount();
    // Keep the caret pinned to the end as it grows, so the field scrolls with
    // the text instead of the tail typing out of view.
    mission.setSelectionRange(n, n);

    if (t < 1) {
      typing = requestAnimationFrame(step);
    } else {
      typing = null;
    }
  };

  mission.value = "";
  paintCount();
  typing = requestAnimationFrame(step);
}

// Example cards. A blank "what are you working toward?" is the hardest question
// on this page, and a placeholder can't be edited — you have to retype it from
// scratch. One tap drops in a real sentence that can then be changed, which is
// the difference between a starting point and a blank wall.
el("chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-fill]");
  if (!b) return;
  // Focus before typing: focusing afterwards would fight the caret we just set.
  mission.focus();
  typeInto(b.dataset.fill);
});

// Typing by hand should win over an animation still running — otherwise the
// next frame overwrites whatever was just typed.
mission.addEventListener("keydown", () => {
  if (typing) { cancelAnimationFrame(typing); typing = null; }
});

async function saveMission() {
  // Advance regardless of whether the write landed. Blocking navigation on
  // storage means one failed API call strands the user on step 1 with a button
  // that appears dead.
  await storeSet({ mission: mission.value.trim() });
  show(stepAt("s1"));
  runDemo();
}

// ---------- host permission ----------
// Asked for on its own step because Chrome's install-time wording for
// <all_urls> is the single biggest reason people abandon an unknown extension.
// See the note on the step in welcome.html.
async function hostGranted() {
  try {
    return await chrome.permissions.contains({ origins: ["<all_urls>"] });
  } catch (e) {
    return false;
  }
}

// Repaints the grant button to match reality. Called on arrival at the step and
// after a request resolves, so re-visiting a step already granted doesn't offer
// to grant it again.
async function paintPerm() {
  const btn = el("permGrant");
  const hint = el("permHint");
  if (!btn) return;
  if (await hostGranted()) {
    btn.textContent = "Access allowed";
    btn.classList.add("is-granted");
    if (hint) hint.textContent = "Revoke any time from Chrome's extensions page.";
  } else {
    btn.textContent = "Allow access";
    btn.classList.remove("is-granted");
    if (hint) hint.textContent = "You can revoke this any time from Chrome's extensions page.";
  }
}

(function wirePerm() {
  const btn = el("permGrant");
  if (!btn) return;
  btn.addEventListener("click", () => {
    // NOT async, and nothing is awaited before the request: Chrome only honours
    // permissions.request() inside a user gesture, and any await beforehand
    // ends that gesture — the call then rejects with "must be called during a
    // user gesture" no matter how the promise is chained.
    try {
      chrome.permissions.request({ origins: ["<all_urls>"] }, (granted) => {
        paintPerm();
        if (granted) {
          // Tell the worker straight away so blocking starts now rather than
          // whenever it next happens to re-check.
          try { chrome.runtime.sendMessage({ type: "hostAccessChanged" }); } catch (e) {}
        }
      });
    } catch (e) {
      paintPerm();
    }
  });
})();

// ---------- step 2: the demo ----------
// Deliberately not a live API call. It must work with no key, no network and no
// browsing history, because at this moment the user has none of those — and a
// spinner that fails is a worse first impression than no demo at all. The two
// titles are ones the offline rules already classify correctly, so this shows
// real behaviour rather than a mock-up.
let demoRun = false;
function runDemo() {
  // Before the early return: the verdicts only play once, but the title cycle
  // must survive leaving and re-entering this step, which the Back button makes
  // an ordinary path. cycleTitles has its own guard against double-starting.
  cycleTitles();

  if (demoRun) return;
  demoRun = true;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Verdicts land one after the other rather than together — the beat between
  // them is what makes it read as two decisions being made, which is the whole
  // claim this page is making.
  const stamp = (id, delay) => {
    const n = el(id);
    if (reduce) { n.classList.add("show"); return; }
    setTimeout(() => n.classList.add("show"), delay);
  };
  stamp("v1", 380);
  stamp("v2", 820);

  const m = (mission.value || "").trim();
  if (m) {
    setTimeout(() => {
      el("demoNote").innerHTML =
        "Any site, judged against <b>what you just wrote</b>.";
    }, reduce ? 0 : 1150);
  }
}

// ---------- the cycling demo titles ----------
// The two rows rotate rather than the headline. A fixed pair makes the extension
// look like it knows about exactly two videos; watching titles from different
// kinds of work get sorted is what actually shows the range — and it teaches the
// real lesson, which is that the verdict follows the title, not the domain.
//
// Written as pairs so the work row is never the same field twice running: a
// student, an editor, a founder, a designer, someone learning an instrument.
// The junk row is deliberately the kind of thing that is genuinely tempting
// while you are doing that specific work, not generic "bad internet".
// Each entry carries its own site, and BOTH rows sit on that same site. That is
// the whole argument: "YouTube good, Reddit bad" is a blocklist and every
// blocklist already does it. "This Reddit tab is work and that one isn't" is the
// claim only this product can make, and it is far more persuasive because the
// user has lived both halves of it.
//
// Rotating the site also answers the objection this screen used to invite —
// that the thing is a YouTube blocker — without ever asking the user to operate
// a picker to find out.
// `tags` exist so the pairs shown can be biased toward what the user actually
// wrote as their mission. Someone who typed "video editing" should meet the
// Premiere example early, not on the fourteenth rotation they will never see.
//
// Every pair follows the same rule, which is what makes them legible without
// explanation: the WORK row is a specific question a real person has while
// working, and the JUNK row is what that same person drifts to — plausible,
// tempting, often feels productive. Junk is never obviously worthless, because
// obviously worthless is a call any blocklist can already make.
const TITLES = [
  // ---- video / creative ----
  { site: "youtube.com", tint: "#FF4E45", tags: ["video", "general"],
    work: "How to Actually Finish What You Start",
    junk: "Top 50 Party Songs 2026 [Bass Boosted Megamix]" },
  { site: "reddit.com", tint: "#FF7043", tags: ["video"],
    work: "r/premiere — Best export settings for client work?",
    junk: "r/all — You will not believe what happened next" },
  { site: "youtube.com", tint: "#FF4E45", tags: ["video"],
    work: "Colour Grading in Premiere — Full Walkthrough",
    junk: "I Bought the World's Most Expensive Keyboard" },
  { site: "youtube.com", tint: "#FF4E45", tags: ["video"],
    work: "Fixing Muddy Audio in 4 Minutes",
    junk: "Try Not to Laugh — Editing Fails Compilation" },

  // ---- code / study ----
  { site: "stackoverflow.com", tint: "#F58025", tags: ["code", "study"],
    work: "Why does my useEffect run twice in React 18?",
    junk: "Hot Network Questions: what is the oldest joke?" },
  { site: "github.com", tint: "#B8BFC9", tags: ["code"],
    work: "Pull request #482 — fix race in auth refresh",
    junk: "Trending this week: awesome-awesome-awesome" },
  { site: "youtube.com", tint: "#FF4E45", tags: ["study", "code"],
    work: "Binary Search — Every Edge Case, Explained",
    junk: "A Day in the Life of a FAANG Engineer" },
  { site: "news.ycombinator.com", tint: "#FF9F5A", tags: ["code"],
    work: "Ask HN: how do you scope a first contract?",
    junk: "Show HN: I made a clock out of clocks" },
  { site: "chatgpt.com", tint: "#19C37D", tags: ["code", "study"],
    work: "Explain this stack trace line by line",
    junk: "Write a rap about my cat as a pirate" },

  // ---- founder / business ----
  { site: "x.com", tint: "#9AA4B2", tags: ["founder"],
    work: "Thread: how we priced our first 100 customers",
    junk: "Everyone is arguing about this take again" },
  { site: "youtube.com", tint: "#FF4E45", tags: ["founder"],
    work: "How to Talk to Your First 10 Customers",
    junk: "Billionaire Morning Routine (5AM Club)" },
  { site: "linkedin.com", tint: "#3B8BEA", tags: ["founder", "career"],
    work: "Draft: outreach message to the 12 leads",
    junk: "Agree? 🚀 I fired my best employee. Here's why." },
  { site: "notion.so", tint: "#C9CDD4", tags: ["founder", "general"],
    work: "Q3 plan — what ships before the 30th",
    junk: "Template gallery: 47 productivity dashboards" },

  // ---- design ----
  { site: "medium.com", tint: "#4ECD8F", tags: ["design"],
    work: "Figma Auto Layout, Explained Properly",
    junk: "12 Habits of Insanely Productive People" },
  { site: "dribbble.com", tint: "#EA4C89", tags: ["design"],
    work: "Dashboard patterns for dense data tables",
    junk: "Shots you'll never build — 3D gradient blobs" },
  { site: "youtube.com", tint: "#FF4E45", tags: ["design"],
    work: "Type Scales That Actually Work on Mobile",
    junk: "Reacting to the Worst App Designs Ever" },

  // ---- study / exams ----
  { site: "youtube.com", tint: "#FF4E45", tags: ["study"],
    work: "Organic Chemistry — Reaction Mechanisms, Part 3",
    junk: "I Studied 16 Hours a Day for 30 Days" },
  { site: "wikipedia.org", tint: "#C9CDD4", tags: ["study", "general"],
    work: "Fourier transform — properties and examples",
    junk: "List of unusual deaths" },
  { site: "quora.com", tint: "#D9534F", tags: ["study", "career"],
    work: "How do I revise a subject I keep forgetting?",
    junk: "What is the most awkward thing that ever happened?" },

  // ---- career / job hunt ----
  { site: "linkedin.com", tint: "#3B8BEA", tags: ["career"],
    work: "Backend Engineer — apply before Friday",
    junk: "See who viewed your profile this week" },
  { site: "glassdoor.com", tint: "#4EC08C", tags: ["career"],
    work: "Interview questions — systems design round",
    junk: "The 20 highest paying jobs you've never heard of" },

  // ---- music / hobby ----
  { site: "youtube.com", tint: "#FF4E45", tags: ["music"],
    work: "Barre Chords — Why Yours Buzz and How to Fix It",
    junk: "Top 10 Guitar Solos That Broke the Internet" },

  // ---- writing ----
  { site: "docs.google.com", tint: "#4A8CF7", tags: ["writing", "general"],
    work: "Chapter 4 — second draft",
    junk: "Untitled document (37 minutes, nothing typed)" },
  { site: "substack.com", tint: "#FF8A47", tags: ["writing"],
    work: "Editing the piece that goes out Thursday",
    junk: "17 newsletters you should be reading instead" }
];

// Words that map a mission to the tags above. Deliberately short and lowercase:
// this is a nudge toward relevant examples, not a classifier, and a miss simply
// falls back to the shuffled order — nothing breaks.
const TAG_WORDS = {
  video:   ["video", "edit", "editing", "premiere", "footage", "youtube", "film"],
  code:    ["code", "coding", "developer", "engineer", "software", "dsa", "leetcode", "backend", "frontend", "ml", "programming"],
  study:   ["exam", "exams", "study", "studying", "semester", "college", "revision", "syllabus", "gate", "jee", "neet"],
  founder: ["startup", "founder", "product", "customers", "business", "agency", "freelanc", "client"],
  design:  ["design", "designer", "figma", "ui", "ux", "brand"],
  career:  ["placement", "placed", "job", "interview", "hiring", "resume", "career", "internship"],
  music:   ["music", "guitar", "piano", "singing", "producer"],
  writing: ["writing", "writer", "novel", "blog", "newsletter", "essay"]
};

// Builds the order the pairs will play in. Two problems this solves:
//
//   1. A fixed sequence means everyone sees the same first four, and with 24
//      pairs at ~5s each the tail is a two-minute loop nobody reaches. Shuffling
//      means the pool's size actually buys variety instead of a long tail.
//   2. The examples that persuade are the ones the reader recognises. If the
//      mission mentions editing, the Premiere pair should come up early rather
//      than fourteenth.
//
// Relevance first (itself shuffled, so two editors don't see identical runs),
// then everything else shuffled behind it. With no mission, it is a plain
// shuffle — which is still better than a fixed list.
function orderedTitles(mission) {
  const m = (mission || "").toLowerCase();

  // Score rather than a plain set: a mission usually matches more than one tag,
  // and the one it matches MOST is the one whose examples should lead. Treating
  // every hit equally let "freelance video editing" open on a founder pair.
  //
  // Short tokens are matched on word boundaries. A bare substring test makes
  // "ui" fire inside "b-ui-lding", which put design examples in front of a
  // founder — the kind of near-miss that reads as broken rather than clever.
  const scores = {};
  if (m) {
    for (const tag in TAG_WORDS) {
      let n = 0;
      for (const w of TAG_WORDS[tag]) {
        const hit = w.length <= 3
          ? new RegExp("\\b" + w + "\\b").test(m)
          : m.includes(w);
        if (hit) n++;
      }
      if (n) scores[tag] = n;
    }
  }
  const hits = new Set(Object.keys(scores));

  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  if (!hits.size) return shuffle(TITLES);

  // A pair's weight is its best-matching tag's score, so pairs tagged with the
  // dominant subject sort ahead of pairs that merely brushed a secondary one.
  // Shuffle first, then sort: equal-weight pairs stay in random order rather
  // than always appearing in declaration order.
  const weight = (t) => Math.max(...t.tags.map((g) => scores[g] || 0));
  const rel = shuffle(TITLES.filter((t) => weight(t) > 0))
    .sort((x, y) => weight(y) - weight(x));
  const rest = shuffle(TITLES.filter((t) => weight(t) === 0));
  return rel.concat(rest);
}

// Paints the header for one entry. Defined outside cycleTitles because it has to
// run even when the cycle does not — a reduced-motion user still needs the first
// site's colour, and the markup can only carry its name.
function paintSite(entry) {
  const site = el("siteName"), fav = el("favDot");
  if (site) site.textContent = entry.site;
  if (fav) fav.style.background = entry.tint;
}

let cycling = false;
function cycleTitles() {
  if (cycling) return;

  const a = el("workTtl"), b = el("junkTtl");
  if (!a || !b) return;
  // Reduced motion keeps the first pair, which demonstrates the point on its
  // own. Note the flag is set only after the guards: latching it above would
  // mean a bail-out permanently blocks a later legitimate start.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  cycling = true;

  // Types `text` into `node`, easing out — same character as the chip
  // typewriter, so every typed thing on this page moves the same way.
  const type = (node, text) => new Promise((done) => {
    const dur = 260 + text.length * 12;
    const t0 = performance.now();
    node.classList.add("typing");
    const step = (now) => {
      const t = Math.min((now - t0) / dur, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      node.textContent = text.slice(0, Math.round(eased * text.length));
      if (t < 1) requestAnimationFrame(step);
      else { node.classList.remove("typing"); done(); }
    };
    requestAnimationFrame(step);
  });

  // Backspacing is linear and quicker than typing — deleting is a mechanical
  // action, and easing it makes the sentence feel like it is hesitating.
  const erase = (node) => new Promise((done) => {
    const text = node.textContent;
    const dur = 30 + text.length * 9;
    const t0 = performance.now();
    node.classList.add("typing");
    const step = (now) => {
      const t = Math.min((now - t0) / dur, 1);
      node.textContent = text.slice(0, Math.round((1 - t) * text.length));
      if (t < 1) requestAnimationFrame(step);
      else done();
    };
    requestAnimationFrame(step);
  });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // The verdict pills have to drop while a new title types, then land again once
  // it has settled. Leaving them up would show "✓ Work" asserted against a
  // half-typed title — the demo would be claiming a verdict before there is
  // anything to judge, which is precisely the thing it is trying to explain.
  // The header is set outright rather than typed: it is chrome, not content, and
  // a typing address bar would pull attention away from the titles, which are
  // the thing being taught.
  const setSite = paintSite;

  const v1 = el("v1"), v2 = el("v2");
  const dropPills = () => { v1.classList.remove("show"); v2.classList.remove("show"); };
  const landPills = async () => {
    await wait(220);
    v1.classList.add("show");
    await wait(300);
    v2.classList.add("show");
  };

  // Built once, when the cycle starts, so the order is stable for this visit —
  // reshuffling every rotation would let the same pair repeat back to back.
  const order = orderedTitles(mission.value);

  // The markup ships one pair as the pre-JS fallback, but the order is shuffled
  // and mission-biased, so order[0] is usually something else. Paint it now or
  // the first rotation jumps from the hardcoded pair to an unrelated one, and
  // the opening example is never the relevant one we just went to the trouble
  // of choosing.
  a.textContent = order[0].work;
  b.textContent = order[0].junk;
  paintSite(order[0]);

  let i = 0;
  (async function loop() {
    // Hold the opening pair long enough to be read and understood before
    // anything moves. The first impression has to be a settled example, not
    // text that never stops changing.
    await wait(3400);
    for (;;) {
      // Stop while the step is off-screen: an animation nobody is looking at is
      // pure battery cost, and it would race the entrance when they return.
      if (el("s1").hidden) { await wait(1200); continue; }

      const next = order[(i + 1) % order.length];
      dropPills();
      await Promise.all([erase(a), erase(b)]);
      // The site changes while both rows are empty. Swapping it mid-type would
      // put one site's header above the other site's half-typed title — a frame
      // that is briefly, visibly wrong.
      setSite(next);
      await Promise.all([type(a, next.work), type(b, next.junk)]);
      await landPills();
      i = (i + 1) % order.length;
      // Long enough to read both titles and register the verdicts before the
      // next swap starts.
      await wait(3600);
    }
  })();
}

// ---------- step 3: the key ----------
const apiKey = el("apiKey");

// Catch an obviously-wrong paste here rather than letting it fail silently later
// as a red "AI failed" pill in the popup, which reads as the extension being
// broken rather than the key being wrong.
function keyLooksValid(k) {
  const s = (k || "").trim();
  if (!s) return true;                       // empty is fine — this step is optional
  return /^gsk_[A-Za-z0-9]/.test(s) || /^sk-or-/.test(s);
}

// ---------- checking the key ----------
// A format test only proves the key is shaped right. The failure this screen
// actually needs to prevent is a key that LOOKS fine and is dead — revoked,
// mistyped in the middle, copied from the wrong account. That surfaces later as
// a red "AI failed" pill in the popup, which reads as the extension being
// broken. One request here turns a silent future failure into an answer now.
const checkBtn = el("checkKey");
const KEY_HINT_DEFAULT = "Stored locally. Only a tab's title is ever sent.";

function paintCheck() {
  const has = apiKey.value.trim().length > 0;
  checkBtn.setAttribute("aria-disabled", has ? "false" : "true");
}

function setCheckState(cls, label) {
  checkBtn.classList.remove("ok", "bad", "busy");
  if (cls) checkBtn.classList.add(cls);
  checkBtn.textContent = label;
}

function setHint(text, cls) {
  const h = el("keyHint");
  h.classList.remove("warn", "ok");
  if (cls) h.classList.add(cls);
  h.textContent = text;
}

// Smallest authenticated call each provider offers. Listing models needs a valid
// key but costs nothing and generates no tokens, so a check is free.
function keyProbe(k) {
  if (/^gsk_/.test(k)) {
    return { url: "https://api.groq.com/openai/v1/models", name: "Groq" };
  }
  if (/^sk-or-/.test(k)) {
    return { url: "https://openrouter.ai/api/v1/key", name: "OpenRouter" };
  }
  return null;
}

async function checkKey() {
  const k = apiKey.value.trim();
  if (!k) return;

  if (!keyLooksValid(k)) {
    setCheckState("bad", "Check");
    setHint("Keys start with gsk_ or sk-or-.", "warn");
    apiKey.focus();
    return;
  }

  const probe = keyProbe(k);
  if (!probe) { setHint("Keys start with gsk_ or sk-or-.", "warn"); return; }

  setCheckState("busy", "Checking…");
  setHint("Asking " + probe.name + "…");

  try {
    const res = await fetch(probe.url, {
      headers: { Authorization: "Bearer " + k }
    });

    if (res.ok) {
      setCheckState("ok", "Valid");
      setHint(probe.name + " accepted this key.", "ok");
      return;
    }

    // 401/403 is the key being wrong. Anything else is the provider having a
    // problem, and blaming the user's key for a 500 would send them to
    // regenerate a key that was fine.
    if (res.status === 401 || res.status === 403) {
      setCheckState("bad", "Rejected");
      setHint(probe.name + " rejected this key. Copy it again from the dashboard.", "warn");
    } else if (res.status === 429) {
      setCheckState("ok", "Valid");
      setHint("Key works — " + probe.name + " is rate-limiting right now.", "ok");
    } else {
      setCheckState(null, "Check");
      setHint(probe.name + " returned an error (" + res.status + "). Try again shortly.", "warn");
    }
  } catch (e) {
    // Network failure is NOT a bad key, and must not be reported as one.
    setCheckState(null, "Check");
    setHint("Couldn't reach " + probe.name + ". Check your connection.", "warn");
  }
}

checkBtn.addEventListener("click", () => {
  if (checkBtn.getAttribute("aria-disabled") === "true") return;
  checkKey();
});

// Clear the complaint as soon as they start correcting it — a warning that
// outlives the problem trains people to ignore warnings.
apiKey.addEventListener("input", () => {
  paintCheck();
  // Any edit invalidates a previous verdict: the key on screen is no longer the
  // key that was checked.
  setCheckState(null, "Check");

  const h = el("keyHint");
  if (!h.classList.contains("warn") && !h.classList.contains("ok")) return;
  h.classList.remove("ok");
  h.classList.remove("warn");
  // Must match the same string in welcome.html — this restores it after a
  // bad-key warning, so a mismatch would silently reword the hint.
  h.textContent = "Stored locally. Only a tab's title is ever sent.";
});

async function saveKey() {
  const k = apiKey.value.trim();
  if (k && !keyLooksValid(k)) {
    const h = el("keyHint");
    // Names the fix, not the failure — the prefixes are what the user acts on.
    h.textContent = "Keys start with gsk_ or sk-or-.";
    h.classList.add("warn");
    apiKey.focus();
    return;
  }
  if (k) {
    await storeSet({ apiKey: k });
    // The worker caches whether the AI is reachable; a key arriving now must
    // invalidate whatever it decided before there was one.
    try { chrome.runtime.sendMessage({ type: "settingsSaved" }); } catch (e) {}
  }
  await finishSetup();
}

// ---------- confetti ----------
// Fires only on a COMPLETE setup. Celebrating a run where the mission or the key
// was skipped would be hollow, and it would contradict the recap directly
// underneath saying what is still missing — the reward has to mean something or
// it teaches the user that this screen's signals are noise.
function confetti() {
  const cv = el("confetti");
  if (!cv) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const ctx = cv.getContext("2d");
  if (!ctx) return;

  // Backing store at device resolution, CSS box at layout size — without this
  // the pieces are visibly soft on a HiDPI screen.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = cv.getBoundingClientRect();
  const W = rect.width, H = rect.height;

  // The canvas is the whole viewport — it has to be, or a piece at the top of
  // its arc would clip against the card's edge mid-flight. But this page draws
  // its content in a WINDOW inset from the viewport, and firing from the
  // viewport's corners put confetti in the dark margin outside the card, which
  // reads as the animation missing the page rather than coming from it. The
  // sandbox never showed this: its card is full-bleed, so the two rectangles
  // were the same one.
  //
  // So the cannons are anchored to the card and the arcs still fly over the
  // full canvas. `.win` is the card — NOT `body > div`, which is an inner
  // wrapper ~130px narrower on each side; aiming at that fired the cannons from
  // well inside the card and left both corners visibly bare.
  const shell = document.querySelector(".win");
  const box = shell ? shell.getBoundingClientRect() : rect;
  const L = box.left, R = box.right, BOT = box.bottom;
  const CW = R - L;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  // Reset before scaling. finishSetup can be reached twice in one page life (Back
  // out of the last step, change the key, Continue again), and a bare scale()
  // multiplies onto the transform already there — the second run would draw at
  // 4x and the pieces would fly off the canvas.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  // Product palette. Confetti in unrelated colours reads as a stock library
  // dropped in; these are the same greens and blues used everywhere else.
  const COLORS = ["#46C45B", "#5FE07A", "#0A84FF", "#4A9BFF", "#EAF2FF", "#FF9F0A"];

  // Gravity is the free parameter; launch speed is DERIVED from it so the apex
  // always lands inside the viewport. Hand-picking both is how the last pass
  // broke: the pieces reached 5600px above a 900px screen and simply left.
  //
  // For a straight-up throw, apex = v²/(2g). Solve for the v that puts the apex
  // at a chosen fraction of the screen height:  v = sqrt(2 * g * H * frac).
  const GRAVITY = 0.115;

  // The tallest pieces top out at HI of the screen height, the shortest at
  // HI * LO_RATIO. LO_RATIO is high so even the shortest arcs climb — with a low
  // floor the weak pieces hugged the bottom and the sweep lost its long diagonal.
  const HI = 0.70, LO_RATIO = 0.44;

  // Steepens every launch by this much, measured from vertical. Applied as a
  // rotation of the solved velocity vector, so speed is preserved.
  const TILT = 2 * Math.PI / 180;   // 2 degrees

  // Horizontal drag only, and light. Applying drag to vy as well would fight
  // the gravity solve above and pull the apex below its target. These arcs are
  // long, so drag has many frames to act on them — at 0.994 the sweep died out
  // before it crossed the page.
  const DRAG = 0.9975;
  // The launch speed of the tallest possible arc — the reference for both the
  // terminal-velocity cap and the frame budget.
  // Measured against the CARD's height for the same reason as the width: the
  // arcs launch from the card's bottom edge, so an apex solved against the
  // taller viewport would sail past the top of the window.
  const CH = BOT - box.top;
  const vTop = Math.sqrt(2 * GRAVITY * CH * HI);
  // Capped at ~55% of that, so the descent is visibly gentler than the ascent
  // and the pieces flutter rather than drop.
  const TERMINAL = vTop * 0.55;

  const pieces = [];
  const burst = (ox, oy, dir, n) => {
    for (let i = 0; i < n; i++) {
      // Each piece gets its own apex height and its own horizontal landing
      // target, and BOTH velocity components are solved from those. Picking an
      // angle instead is what produced two narrow columns hugging the corners:
      // the reach was whatever the angle happened to give, which was nothing.
      //
      // Rise and reach are CORRELATED but not locked. Fully independent rolls
      // gave slow-and-high plus fast-and-low, which piled everything along the
      // bottom; a single shared roll went too far the other way and every piece
      // landed on one clean curve — a crescent. Blending a shared roll with a
      // private one keeps tall arcs generally long without the whole population
      // tracing the same path.
      const t = Math.pow(Math.random(), 0.62);   // 0 = short/near, 1 = tall/far
      const tReach = t * 0.55 + Math.random() * 0.45;

      const hFrac = LO_RATIO + t * (1 - LO_RATIO);
      const rise = CH * HI * hFrac;
      const vy0 = Math.sqrt(2 * GRAVITY * rise);

      // Time to the apex. Spending REACH over roughly that window is what makes
      // the fan wide — pieces arrive at the top already spread across the page.
      const tUp = vy0 / GRAVITY;
      // Reach is measured in CARD widths, not viewport widths — the sweep has to
      // cross the window the user is looking at.
      //
      // The floor is low on purpose. At 0.20 the SHORTEST arc still travelled a
      // fifth of the card before it came down, so every piece had left the
      // corner by the time it was visible and the two launch sites read as bare
      // — the corners looked like the confetti started somewhere in from them.
      // Dropping the floor keeps a fraction of each burst close to home, which
      // is what makes the origin legible.
      const reach = CW * (0.04 + tReach * 0.78) * (0.80 + Math.random() * 0.40);

      // Launch direction falls out of the two solved components rather than
      // being picked, so steepening it means rotating the vector — and rotating
      // (rather than scaling vx) keeps each piece's SPEED unchanged, so this is
      // a pure direction change and not a secret velocity cut.
      const vx0 = (reach / tUp) * 0.95;
      const speed = Math.hypot(vx0, vy0);
      // Angle from vertical, tilted 2° further upright.
      const ang = Math.max(0, Math.atan2(vx0, vy0) - TILT);

      pieces.push({
        // Jitter runs INWARD only (dir), not symmetrically. Centred jitter on a
        // corner cannon spawns half the burst outside the card, in the dark
        // margin where it reads as confetti leaking off the page.
        x: ox + dir * Math.random() * CW * 0.03,
        // Stagger the launch point vertically as well, so the pieces do not all
        // leave from one pixel.
        y: oy + Math.random() * 26,
        // Every piece sweeps inward: the cannons sit hard in the corners, so
        // the outward strip is only a couple of percent of the width and
        // throwing pieces backwards just wasted them off-screen.
        vx: dir * Math.sin(ang) * speed,
        vy: -Math.cos(ang) * speed,
        w: 5 + Math.random() * 5,
        h: 7 + Math.random() * 7,
        rot: Math.random() * Math.PI,
        // Slower tumble to match the slower flight — pieces spinning fast while
        // drifting gently looks like two different animations.
        vr: (Math.random() - 0.5) * 0.22,
        // Wide stagger is what breaks the arc: pieces leaving together share a
        // flight clock, and same-age pieces under one gravity sit at the same
        // radius, which IS a crescent. Measured — at 40 frames the radius
        // spread was 0.16, at 95 it was 0.94.
        //
        // Biased so the TALL arcs go first ((1-t) leads): they need the longest
        // flight, and launching them late left the top of the page empty at the
        // moment the rest of the screen was full.
        delay: (1 - t) * 22 + Math.random() * 78,
        // Sideways sway while falling, so the descent wanders instead of
        // dropping on rails. Phase is per-piece or they all sway in unison.
        swayAmp: 0.20 + Math.random() * 0.45,
        swayFreq: 0.02 + Math.random() * 0.03,
        swayPhase: Math.random() * Math.PI * 2,
        color: COLORS[(Math.random() * COLORS.length) | 0],
        life: 0
      });
    }
  };
  // Both cannons sit in the very bottom corners and fire in long, flat diagonals
  // that carry right across the page and up over the far side. Everything on
  // screen originates here — nothing falls in from above the fold, so the
  // confetti always reads as thrown from the page itself.
  //
  // Piece count is tied to the launch stagger: spreading 220 pieces over ~95
  // frames left only half of them airborne at once and the page looked sparse.
  // The wide stagger is non-negotiable (it is what breaks the arc), so the count
  // has to rise to keep the density.
  // Flush to the card's corners. The 2% inset that worked when these fired from
  // the viewport's edge is wrong here: the card is a fixed 1120px box, so 2% is
  // a visible gap rather than the rounding it was on a full-bleed page.
  burst(L, BOT + 8, 1, 230);
  burst(R, BOT + 8, -1, 230);

  // Derived from the physics rather than picked: the tallest arc spends vTop/g
  // frames climbing, and the terminal-velocity cap makes the fall slower still.
  // +40 for the launch stagger, or the last pieces to leave get cut off mid-air.
  const MAX = Math.round((vTop / GRAVITY) * 2.6) + 40;
  let frame = 0;
  let raf = 0;

  // Rounded to match the card's own 1.25rem radius, so a piece near a corner is
  // cut by the same curve the card is drawn with rather than by a square edge
  // hanging in space.
  const RADIUS = 20;

  const tick = () => {
    ctx.clearRect(0, 0, W, H);
    frame++;

    // Fade only over the last fifth. At 60% of the run the pieces would spend
    // seconds visibly dying, which reads as the animation failing rather than
    // finishing. Hoisted out of the loop — it depends only on the frame.
    const fade = frame > MAX * 0.8
      ? Math.max(0, 1 - (frame - MAX * 0.8) / (MAX * 0.2))
      : 1;

    // Clip to the card for the whole frame. The cull above stops pieces falling
    // out of the bottom, but a long flat arc can still overshoot sideways, and
    // confetti in the dark margin reads as spilling off the page rather than
    // being thrown across it.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(box.left, box.top, CW, BOT - box.top, RADIUS);
    ctx.clip();

    let alive = 0;
    for (const p of pieces) {
      // Not launched yet. Counted as alive so a staggered start cannot end the
      // animation before the late pieces have left the ground.
      if (frame < p.delay) { alive++; continue; }

      p.vy += GRAVITY;
      // Terminal velocity. Without it the fall accelerates past the launch
      // speed and the pieces plummet — real confetti flutters down slower than
      // it went up, because air resistance caps it.
      if (p.vy > TERMINAL) p.vy = TERMINAL;
      p.vx *= DRAG;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.life++;

      // Sway ramps in as the piece slows, so it climbs straight and wanders on
      // the way down — a piece swaying at full launch speed looks like it is
      // being blown sideways rather than falling.
      const settle = Math.min(1, Math.max(0, p.vy / TERMINAL));
      p.x += Math.sin(p.life * p.swayFreq + p.swayPhase) * p.swayAmp * settle;

      // Culled at the CARD's bottom, not the viewport's. Letting pieces fall into
      // the margin below the window put confetti over the footer and out onto
      // the black page, which reads as the animation escaping the surface it was
      // thrown from. +20 so a piece leaves rather than vanishing at the edge.
      if (p.y > BOT + 20 || fade <= 0) continue;
      alive++;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = fade;
      ctx.fillStyle = p.color;
      // Scaling height by cos(rot) fakes the piece turning edge-on, which is
      // what sells these as flat scraps rather than floating rectangles.
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot)));
      ctx.restore();
    }

    // Matches the clip's save() above.
    ctx.restore();

    if (alive > 0 && frame < MAX) {
      raf = requestAnimationFrame(tick);
    } else {
      ctx.clearRect(0, 0, W, H);
    }
  };

  raf = requestAnimationFrame(tick);
}

// ---------- step 4: done ----------
async function finishSetup() {
  const d = await storeGet(["mission", "apiKey"]);
  const hasMission = !!(d.mission || "").trim();
  const hasKey = !!(d.apiKey || "").trim();
  const hasAccess = await hostGranted();

  // State plainly what is and isn't on. A setup screen that says "all done"
  // regardless of what was skipped teaches the user to distrust it.
  const row = (on, title, sub) =>
    '<div class="recap-row">' +
      '<span class="ic ' + (on ? "on" : "off") + '" aria-hidden="true">' + (on ? "✓" : "–") + '</span>' +
      '<span class="tx"><b>' + title + "</b>" + sub + "</span>" +
    "</div>";

  // Each row is a state plus its one consequence. The "on" rows can be short
  // because nothing is being asked of the user; the "off" rows keep the pointer
  // to Settings, which is the only actionable thing on this screen.
  // Access leads the recap. Without it nothing else on this list does anything,
  // so it cannot sit third behind two rows that read as successes.
  el("recap").innerHTML =
    row(hasAccess,
      hasAccess ? "Blocking is on" : "Blocking is off",
      hasAccess
        ? "Obvious distractions get walled."
        : "Nice Try can't see your tabs yet. Turn it on from the popup.") +
    row(hasMission,
      hasMission ? "Mission set" : "No mission yet",
      hasMission
        ? "Every tab is judged against it."
        : "Add one in Settings.") +
    row(hasKey,
      hasKey ? "Smart judging on" : "No AI key",
      hasKey
        ? "Ambiguous pages get a real verdict."
        : "Ambiguous pages fall back to keyword rules. Add a key in Settings.");

  const complete = hasMission && hasKey && hasAccess;

  if (complete) {
    // Name what they now have, not what the software is doing. "You're set up"
    // describes the installer; "fully armed" describes them.
    el("doneTitle").textContent = "Fully armed";
    el("doneDesc").textContent =
      "Mission set, smart judging on. Nice Try now knows the difference between " +
      "the tab that gets you there and the one that doesn't.";
  } else if (!hasAccess) {
    // The one incomplete state that leaves the tool doing literally nothing
    // gets its own wording. "You're running" would be a lie here.
    el("doneTitle").textContent = "One thing left";
    el("doneDesc").textContent =
      "Nice Try can't see your tabs yet, so nothing is being blocked. " +
      "Open it from the toolbar to allow access.";
  } else {
    el("doneTitle").textContent = "You're running";
    el("doneDesc").textContent =
      "Nice Try is watching your tabs. You skipped part of the setup — " +
      "all of it is changeable in Settings.";
  }

  // Setup is finished; the popup's checklist and the first-wall notice both key
  // off real state, so nothing else needs marking here.
  await storeSet({ welcomeDone: true });
  show(STEPS.indexOf("s3"));

  // After show(), so the canvas has been laid out and has a real size to
  // measure — firing it while the step is still hidden gives a 0×0 canvas and
  // nothing renders.
  if (complete) requestAnimationFrame(confetti);
}

// ---------- first tasks ----------
// Writes real records to the same `todos` key the popup and the worker already
// read, in the same shape ({text, done, date}) — anything else would be a
// decorative input that quietly loses the user's first tasks.
//
// This is on the last screen because the task list is what makes the blocking
// accurate: it overrides every other verdict, so a day with tasks in it is
// judged far better than a day without. Telling someone to "add tasks later
// from the toolbar" loses most of them between here and the next tab.
const todoInput = el("todoInput");
const todoAdd = el("todoAdd");
const todoList = el("todoList");
let firstTasks = [];

// Local date, not toISOString — that is UTC, and after ~18:30 IST it would stamp
// tomorrow's date onto a task added today, hiding it from today's list.
function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function paintTodoAdd() {
  todoAdd.setAttribute("aria-disabled",
    todoInput.value.trim() ? "false" : "true");
}

function renderFirstTasks() {
  todoList.innerHTML = "";
  firstTasks.forEach((t, i) => {
    const li = document.createElement("li");

    const tick = document.createElement("span");
    tick.className = "tick";
    tick.textContent = "✓";
    tick.setAttribute("aria-hidden", "true");

    // textContent, never innerHTML: this is user input echoed straight back to
    // the page, and building it as markup would execute anything they typed.
    const txt = document.createElement("span");
    txt.className = "txt-t";
    txt.textContent = t;

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "rm";
    rm.textContent = "×";
    rm.setAttribute("aria-label", "Remove " + t);
    rm.addEventListener("click", () => {
      firstTasks.splice(i, 1);
      renderFirstTasks();
      saveFirstTasks();
      // Removing a task after hitting the cap has to give the field back, or the
      // card is permanently dead once three have been added and one deleted.
      unlockInput();
    });

    li.append(tick, txt, rm);
    todoList.appendChild(li);
  });
}

// The cap's two halves, split out so both the add path and the restore-from-
// storage path enforce it identically. Arriving with three already saved has to
// look exactly like adding the third.
function lockIfFull() {
  if (firstTasks.length < 3) return;
  todoInput.placeholder = "Three is plenty for today.";
  todoInput.disabled = true;
  todoAdd.setAttribute("aria-disabled", "true");
}

function unlockInput() {
  if (firstTasks.length >= 3) return;
  todoInput.disabled = false;
  todoInput.placeholder = "e.g. finish the client edit";
  paintTodoAdd();
}

async function saveFirstTasks() {
  const d = await storeGet(["todos"]);
  const existing = Array.isArray(d.todos) ? d.todos : [];
  const today = todayKey();

  // Replace only what this screen added, keyed by a flag of its own. Rewriting
  // the whole array would wipe anything the popup wrote in another tab while
  // this page sat open.
  // Scoped to TODAY, matching the filter that repopulates firstTasks below.
  //
  // Without the date test the two were asymmetric: repopulation only loads
  // tasks dated today, so reopening this page on a later day left firstTasks
  // empty — and the first save then dropped every fromWelcome task from every
  // previous day, including open and overdue ones. The flag is preserved
  // forever by normalizeTodos, so that window never closed on its own.
  const keep = existing.filter((t) => !(t && t.fromWelcome && t.date === today));
  const mine = firstTasks.map((text) => ({
    text, done: false, date: today, fromWelcome: true
  }));

  await storeSet({ todos: keep.concat(mine) });
}

function addFirstTask() {
  const text = todoInput.value.trim();
  if (!text) return;
  // Three is the honest ceiling for a first session. A longer list on day one is
  // planning, not doing, and the popup is the better place for it.
  if (firstTasks.length >= 3) {
    todoInput.value = "";
    paintTodoAdd();
    return;
  }
  firstTasks.push(text);
  todoInput.value = "";
  paintTodoAdd();
  renderFirstTasks();
  saveFirstTasks();

  lockIfFull();
}

todoInput.addEventListener("input", paintTodoAdd);
todoInput.addEventListener("keydown", (e) => {
  // Enter is how a one-line form is expected to submit; requiring the mouse for
  // every task is what makes people add one and stop.
  if (e.key === "Enter") { e.preventDefault(); addFirstTask(); }
});
todoAdd.addEventListener("click", () => {
  if (todoAdd.getAttribute("aria-disabled") === "true") return;
  addFirstTask();
});

// ---------- the demo wall ----------
// Shows the real thing, on this page, on purpose. Seeing it once by choice is
// what stops the first genuine block reading as a hijacked browser.
function openDemoWall() {
  primary.setAttribute("aria-disabled", "true");
  primary.textContent = "Opening…";

  const restore = (why) => {
    primary.textContent = "Show me the wall";
    paintBar();
    if (why) {
      const h = el("doneHint");
      if (h) { h.textContent = why; h.classList.add("warn"); }
    }
  };

  // Same file:// exposure as storage — outside the extension there is no worker
  // to ask, and calling through would throw inside the handler where nothing
  // catches it, leaving the button stuck on "Opening…".
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
    restore("The demo needs the installed extension.");
    return;
  }

  // The worker builds the wall's data; THIS page draws it. chrome.scripting
  // cannot inject into a chrome-extension:// page — not even the extension's
  // own — which is why the demo can't be injected the way a real block is.
  chrome.runtime.sendMessage({ type: "demoWall" }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok || !resp.data ||
        typeof showShield !== "function") {
      restore("Couldn't open the demo. Setup is still complete.");
      return;
    }
    showShield(resp.data);
    // The wall covers the page; when it comes down the button should work again.
    restore();
  });
}

function closeTab() {
  // Nothing left to do here. Close the tab if we're allowed to; otherwise leave
  // the page as it is rather than navigating somewhere unexpected.
  try { window.close(); } catch (e) {}
}

// ---------- keyboard navigation ----------
// Left/right arrows step the flow. The hard part is not stealing the keys from
// text entry: inside the mission box or the key field, arrows move the caret and
// must keep doing so. Same for the provider links, where arrows are how a screen
// reader user moves around.
back.addEventListener("click", goBack);

document.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  // Never override a modified arrow — those are text/OS selection gestures.
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

  const t = e.target;
  const tag = t && t.tagName;
  const typing = tag === "TEXTAREA" || tag === "INPUT" ||
                 (t && t.isContentEditable);
  if (typing) return;

  if (e.key === "ArrowLeft") {
    if (!BAR[STEPS[at]].back) return;
    e.preventDefault();
    goBack();
    return;
  }

  // Right advances only where advancing is a plain navigation. On the last step
  // the primary opens the demo wall, which is not something an arrow key should
  // trigger by accident.
  const cfg = BAR[STEPS[at]];
  if (at >= STEPS.length - 1) return;
  if (cfg.primary.enabled && !cfg.primary.enabled()) return;
  e.preventDefault();
  cfg.primary.act();
});

// ---------- press feedback ----------
// Same contract as every other surface: commit on pointerdown, release on
// up/cancel or when the pointer is dragged off the control.
(function pressFeedback() {
  const SEL = ".btn, .chip, .prov";
  let pressed = null;
  const release = () => { if (pressed) { pressed.classList.remove("is-press"); pressed = null; } };
  document.addEventListener("pointerdown", (e) => {
    const t = e.target.closest && e.target.closest(SEL);
    if (!t) return;
    pressed = t;
    t.classList.add("is-press");
  });
  document.addEventListener("pointerup", release);
  document.addEventListener("pointercancel", release);
  document.addEventListener("pointermove", (e) => {
    if (pressed && e.target.closest && e.target.closest(SEL) !== pressed) release();
  });
  window.addEventListener("blur", release);
})();

// ---------- start ----------
// Re-opening a finished setup shouldn't wipe what's already there.
(async function start() {
  const d = await storeGet(["mission", "apiKey", "todos"]);
  if (d.mission) mission.value = d.mission;
  if (d.apiKey) apiKey.value = d.apiKey;

  // Today's tasks, restored. Without this the card always opened empty even when
  // tasks existed — so a task added in the popup was invisible here, and the
  // first save from this screen then DELETED it, because saveFirstTasks() drops
  // every `fromWelcome` record and rewrites the list from an array that had
  // never been populated.
  //
  // Only today's are shown: this card is "what are you working on today", and
  // yesterday's list reappearing under that heading is just wrong.
  const today = todayKey();
  firstTasks = (Array.isArray(d.todos) ? d.todos : [])
    .filter((t) => t && t.fromWelcome && t.date === today)
    .map((t) => t.text);
  renderFirstTasks();
  lockIfFull();

  paintCount();
  // Enables Check when a key was restored from storage, disables it otherwise.
  paintCheck();
  // The demo header is static content, not animation — paint it here rather
  // than inside the cycler, so it is correct whether or not the cycle ever runs
  // (reduced motion, or arriving at step 2 by a path that skips runDemo).
  paintSite(TITLES[0]);
  show(0, true);
  // Deliberately NOT focusing the textarea. The caret is already the obvious
  // next move, and a full focus ring on an empty box makes the page open on its
  // heaviest visual element — the field reads as filled-in before a word is
  // typed, and the heading loses the entrance. Clicking it is one motion.
})();
