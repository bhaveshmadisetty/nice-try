// stats.js — the full scoreboard. The popup shows today's top five; this shows
// every site and every day the log has kept.

const el = id => document.getElementById(id);
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

let log = {};
let range = "today";
let todos = [];   // [{text, done}] — open ones are shown on the second-thoughts sheet

// accepts legacy plain-string todos, same as the popup
function normalizeTodos(raw) {
  return (raw || [])
    .map(t => (typeof t === "string" ? { text: t, done: false } : t))
    .filter(t => t && t.text);
}

function todayKey() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
function fmt(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return "0m";
  if (m < 60) return m + "m";
  return Math.floor(m/60) + "h " + (m%60) + "m";
}
// "2026-08-11" -> "Mon 11 Aug", parsed as local rather than UTC so the label
// can't land on the wrong day for anyone east or west of the meridian.
function dayLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (key === todayKey()) return "Today";
  return dt.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

// Entries logged before URLs were recorded have no link. Most tab titles end
// in the site name — "… - YouTube", "… | Apple Developer Documentation" — so a
// search on that site is a better fallback than a dead row. It's a guess, and
// it's labelled as one in the UI rather than pretending to be the real page.
// Matched against the END of the title. Titles are stored truncated to 60
// characters with an ellipsis, so the site name is often cut off — the ellipsis
// itself is treated as "site unknown" and those rows stay plain rather than
// searching the wrong place.
const SITE_HINTS = [
  ["youtube",                       "https://www.youtube.com/results?search_query="],
  ["google search",                 "https://www.google.com/search?q="],
  ["leetcode",                      "https://leetcode.com/problemset/?search="],
  ["geeksforgeeks",                 "https://www.geeksforgeeks.org/search/?gq="],
  ["stack overflow",                "https://stackoverflow.com/search?q="],
  ["apple developer documentation", "https://developer.apple.com/search/?q="],
  ["wikipedia",                     "https://en.wikipedia.org/w/index.php?search="],
  ["github",                        "https://github.com/search?q="],
  ["mdn web docs",                  "https://developer.mozilla.org/en-US/search?q="]
];
function guessSearch(title) {
  const t = String(title || "").trim();
  if (!t || t.endsWith("…")) return "";     // truncated: site name was cut off
  const low = t.toLowerCase();
  for (const [name, base] of SITE_HINTS) {
    if (!low.endsWith(name)) continue;
    // Drop the site name AND the separator before it, so the query is the
    // page's subject rather than "Two Sum -".
    let q = t.slice(0, t.length - name.length).replace(/[\s\-–—|·:]+$/, "").trim();
    if (!q) return "";                      // title was only the site name
    return base + encodeURIComponent(q);
  }
  return "";
}

// Day keys the log holds, newest first.
function dayKeys() {
  return Object.keys(log).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().reverse();
}

// Days included in the current range.
function keysInRange() {
  const all = dayKeys();
  if (range === "today") return all.filter(k => k === todayKey());
  if (range === "7") return all.slice(0, 7);
  return all;
}

// Sum the selected days into one shape, merging the per-site totals.
function totals(keys) {
  const out = { productive: 0, junk: 0, neutral: 0, sites: {} };
  for (const k of keys) {
    const d = log[k];
    if (!d) continue;
    out.productive += d.productive || 0;
    out.junk       += d.junk || 0;
    out.neutral    += d.neutral || 0;
    // Entries are {s,u}; days written before the URL was recorded hold a bare
    // seconds number. Merge to {s,u} either way, keeping the first URL found —
    // days are walked newest-first, so that's the most recent one seen.
    const s = d.sites || {};
    for (const name in s) {
      const v = s[name];
      const secs = typeof v === "number" ? v : (v && v.s) || 0;
      const url  = typeof v === "object" && v ? (v.u || "") : "";
      const cat  = (typeof v === "object" && v && v.c) || null;
      const cur = out.sites[name] || { s: 0, u: "", c: { productive: 0, junk: 0, neutral: 0 } };
      out.sites[name] = {
        s: cur.s + secs,
        u: cur.u || url,
        c: {
          productive: cur.c.productive + ((cat && cat.productive) || 0),
          junk:       cur.c.junk       + ((cat && cat.junk) || 0),
          neutral:    cur.c.neutral    + ((cat && cat.neutral) || 0)
        }
      };
    }
  }
  return out;
}

function render() {
  const keys = keysInRange();
  const t = totals(keys);
  const active = t.productive + t.junk;
  const tracked = active + t.neutral;
  const box = el("body");

  if (!tracked) {
    box.innerHTML = '<div class="empty">Nothing tracked in this range yet.<br>' +
      'Time is only counted while Chrome is focused and you are actually at the machine.</div>';
    return;
  }

  const pct = active ? Math.round(t.productive / active * 100) : 0;
  const total = tracked || 1;

  // headline numbers
  let html = '<div class="cards">' +
    '<div class="card good"><div class="k">Focused</div><div class="v">' + fmt(t.productive) + '</div></div>' +
    '<div class="card bad"><div class="k">Wasted</div><div class="v">' + fmt(t.junk) + '</div></div>' +
    '<div class="card"><div class="k">Focus rate</div><div class="v">' + (active ? pct + "%" : "—") + '</div></div>' +
    (keys.length > 1
      ? '<div class="card"><div class="k">Days tracked</div><div class="v">' + keys.length + '</div></div>'
      : '') +
  '</div>';

  // split bar
  html += '<div class="panel">' +
    '<h2>The split</h2>' +
    '<div class="bar">' +
      '<div class="p" style="width:' + (t.productive / total * 100) + '%"></div>' +
      '<div class="j" style="width:' + (t.junk / total * 100) + '%"></div>' +
      '<div class="n" style="width:' + (t.neutral / total * 100) + '%"></div>' +
    '</div>' +
    '<div class="legend">' +
      '<span><i class="sw" style="background:var(--green)"></i>Focused <b>' + fmt(t.productive) + '</b></span>' +
      '<span><i class="sw" style="background:var(--red)"></i>Wasted <b>' + fmt(t.junk) + '</b></span>' +
      '<span><i class="sw" style="background:var(--line)"></i>Neutral <b>' + fmt(t.neutral) + '</b></span>' +
    '</div>' +
    '<p class="note">Neutral is time on tools that are neither work nor a distraction — mail, calendar, search.</p>' +
  '</div>';

  // Every site, not just the top five. Built here but appended last, after the
  // day-by-day block.
  let siteHtml = "";
  const rows = Object.keys(t.sites).map(n => ({ n, s: t.sites[n].s, u: t.sites[n].u, c: t.sites[n].c }))
    .filter(r => r.s >= 30).sort((a, b) => b.s - a.s);
  if (rows.length) {
    const max = rows[0].s || 1;
    let guessed = 0;
    siteHtml = '<div class="panel"><h2>Every page, by time</h2>' +
      rows.map(r => {
        // Exact URL if we have one. Otherwise fall back to a search on the site
        // the title names — marked with a different glyph so it's clearly not
        // the same thing as opening the page itself.
        const exact = r.u;
        const href = exact || guessSearch(r.n);
        if (!exact && href) guessed++;
        const mark = exact
          ? '<span class="go" aria-hidden="true">↗</span>'
          : (href ? '<span class="go guess" aria-hidden="true">⌕</span>' : '');

        // Bar length is proportional to total time (comparable between rows),
        // but the COLOURS divide that length by the category split rather than
        // by absolute seconds. Entries part-written before categories existed
        // have only a few seconds attributed; scaling colour by absolute
        // seconds drew those rows almost entirely empty, which read as "no
        // data" for pages that plainly had some.
        const c = r.c || { productive: 0, junk: 0, neutral: 0 };
        const known = c.productive + c.junk + c.neutral;
        const rowW = r.s / max * 100;              // this row's share of the widest
        const seg = (secs, cls) => secs > 0
          ? '<i class="' + cls + '" style="width:' + (secs / known * rowW) + '%"></i>' : '';
        const bar = known
          ? seg(c.productive, "p") + seg(c.junk, "j") + seg(c.neutral, "n")
          // nothing attributed at all: grey, asserting nothing
          : '<i class="u" style="width:' + rowW + '%"></i>';

        // Label the row by where most of its KNOWN time went. Marked as partial
        // when the attributed slice is a small part of the total, so a verdict
        // drawn from three seconds out of six minutes says so.
        let tagCls = "", tagTxt = "";
        if (known) {
          if (c.junk >= c.productive && c.junk >= c.neutral)            { tagCls = "junk";       tagTxt = "Wasted"; }
          else if (c.productive >= c.junk && c.productive >= c.neutral) { tagCls = "productive"; tagTxt = "Focused"; }
          else                                                          { tagCls = "neutral";    tagTxt = "Neutral"; }
        }
        const partial = known > 0 && known < r.s * 0.5;
        const tag = tagTxt
          ? '<span class="tag ' + tagCls + (partial ? ' partial' : '') + '"' +
            (partial ? ' title="Only ' + fmt(known) + ' of this page\'s time was categorised — the rest predates this."' : '') +
            '>' + tagTxt + (partial ? '?' : '') + '</span>'
          : '';

        const inner =
          '<span class="site-wrap">' +
            '<span class="n" title="' + esc(r.n) + '">' +
              '<span class="ttl">' + esc(r.n) + '</span>' + mark + tag +
            '</span>' +
            '<span class="site-bar">' + bar + '</span>' +
          '</span>' +
          '<span class="t">' + fmt(r.s) + '</span>';
        if (!href) return '<div class="site">' + inner + '</div>';
        // Rows the log already called junk get intercepted on click — reopening
        // the thing you just lost time to deserves one deliberate beat.
        const junk = tagCls === "junk";
        return '<a class="site is-link' + (exact ? '' : ' is-guess') + (junk ? ' is-junk' : '') + '" ' +
          (junk ? 'data-junk="1" data-mins="' + fmt(r.s) + '" ' : '') +
          'href="' + esc(href) + '" ' +
          'target="_blank" rel="noreferrer noopener" ' +
          'title="' + esc(exact ? r.u : "Search for this on the site — the exact page wasn't recorded") + '">' +
          inner + '</a>';
      }).join("") +
      '<p class="note">Anything under 30 seconds is left out.' +
        (guessed ? ' Rows marked ⌕ were tracked before links were recorded — they search the site instead of opening the page.' : '') +
      '</p>' +
    '</div>';
  }

  // Day-by-day goes ABOVE the page list. The trend is the thing worth reading
  // first, and the page list runs long enough to bury anything after it.
  if (keys.length > 1) {
    html += '<div class="panel"><h2>Day by day</h2>' +
      keys.map(k => {
        const d = log[k] || {};
        const p = d.productive || 0, j = d.junk || 0, n = d.neutral || 0;
        const tot = p + j + n || 1;
        const a = p + j;
        const dp = a ? Math.round(p / a * 100) : 0;
        return '<div class="day">' +
          '<span class="d">' + esc(dayLabel(k)) + '</span>' +
          '<span class="b">' +
            '<i class="p" style="background:var(--green);width:' + (p / tot * 100) + '%"></i>' +
            '<i class="j" style="background:var(--red);width:' + (j / tot * 100) + '%"></i>' +
            '<i class="n" style="background:var(--line);width:' + (n / tot * 100) + '%"></i>' +
          '</span>' +
          '<span class="pct" style="color:' + (a ? (dp >= 50 ? "var(--green)" : "var(--red)") : "var(--soft)") + '">' +
            (a ? dp + "%" : "—") + '</span>' +
        '</div>';
      }).join("") +
    '</div>';
  }

  html += siteHtml;
  box.innerHTML = html;
}

// ---------- segmented control ----------
function moveIndicator() {
  const tabs = document.querySelector(".tabs");
  const sel = document.querySelector('.tab[aria-selected="true"]');
  if (!tabs || !sel) return;
  const a = tabs.getBoundingClientRect(), b = sel.getBoundingClientRect();
  tabs.style.setProperty("--ind-x", (b.left - a.left) + "px");
  tabs.style.setProperty("--ind-w", b.width + "px");
}

document.querySelectorAll(".tab").forEach(t => {
  t.addEventListener("click", () => {
    range = t.dataset.r;
    document.querySelectorAll(".tab").forEach(x => x.setAttribute("aria-selected", String(x === t)));
    moveIndicator();
    render();
  });
});

window.addEventListener("resize", moveIndicator);
if (window.ResizeObserver) {
  const ro = new ResizeObserver(moveIndicator);
  const tabsEl = document.querySelector(".tabs");
  if (tabsEl) ro.observe(tabsEl);
}

// press feedback on pointerdown, matching the other surfaces
(function pressFeedback() {
  let pressed = null;
  const release = () => { if (pressed) { pressed.classList.remove("is-press"); pressed = null; } };
  document.addEventListener("pointerdown", (e) => {
    const t = e.target.closest && e.target.closest(".tab");
    if (!t) return;
    pressed = t.closest(".tabs");
    pressed.classList.add("is-press");
  });
  document.addEventListener("pointerup", release);
  document.addEventListener("pointercancel", release);
  window.addEventListener("blur", release);
})();

// ---------- back to top ----------
// Appears once you're a screen down, which is roughly where the page list
// starts, and returns you to the range tabs.
(function backToTop() {
  const btn = el("toTop");
  if (!btn) return;
  const sync = () => btn.classList.toggle("show", window.scrollY > 400);
  window.addEventListener("scroll", sync, { passive: true });
  sync();
  btn.addEventListener("click", () => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  });
})();

// ---------- second thoughts ----------
// Clicking a row the log already called "Wasted" reopens the exact thing that
// cost you the time this page is complaining about. The link still works — but
// it costs one deliberate click, with the receipt and today's open tasks in
// view. Rows tagged Focused or Neutral open straight through: the friction is
// aimed at the loop, not at every link.
const SECOND_THOUGHTS = [
  "You already lost {t} here. Going back for seconds?",
  "This page is on the wasted list. You're looking at the bill and reaching for the tab.",
  "{t} gone to this one. What did you actually get for it?",
  "You opened the scoreboard to feel bad, not to relapse on the same page.",
  "The tab that cost you {t} is not the tab that gets you placed.",
  "You came here to review the damage. This is how the damage happens.",
  "{t} of your life went into this. Fund it again, or fund the work?",
  "Reading your own stats and clicking the red row anyway. Be honest about that.",
  "This is the loop asking for a second serving. You don't have to say yes.",
  "You labelled this wasted yourself. Nothing has changed since.",
  "There's a task list one click away that isn't this.",
  "{t} spent. Future-you is watching what you do in the next three seconds."
];

(function secondThoughts() {
  let openTimer = null;

  function pick(mins) {
    const line = SECOND_THOUGHTS[Math.floor(Math.random() * SECOND_THOUGHTS.length)];
    return line.replace("{t}", mins || "time");
  }

  // Open tasks only — a finished task is no longer an argument for anything.
  function taskList() {
    const open = todos.filter(t => !t.done).map(t => t.text).filter(Boolean);
    if (!open.length) {
      return '<p class="st-none">You haven\'t set a single task today. ' +
        'That\'s the actual problem — not this link.</p>';
    }
    const shown = open.slice(0, 5);
    const more = open.length - shown.length;
    return '<div class="st-tasks">' +
      '<div class="st-tasks-h">What you said you\'d be doing</div>' +
      shown.map(t => '<div class="st-task"><span aria-hidden="true">•</span><span>' + esc(t) + '</span></div>').join("") +
      (more > 0 ? '<div class="st-more">and ' + more + ' more</div>' : '') +
    '</div>';
  }

  function close(sheet, returnTo) {
    if (openTimer) { clearInterval(openTimer); openTimer = null; }
    sheet.classList.remove("show");
    const done = () => { sheet.remove(); if (returnTo && returnTo.isConnected) returnTo.focus(); };
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) done(); else setTimeout(done, 200);
  }

  function ask(href, title, mins, returnTo) {
    const sheet = document.createElement("div");
    sheet.className = "st-back";
    sheet.innerHTML =
      '<div class="st" role="alertdialog" aria-modal="true" aria-labelledby="st-line">' +
        '<div class="st-eyebrow">Hold on</div>' +
        '<h2 class="st-line" id="st-line">' + esc(pick(mins)) + '</h2>' +
        '<p class="st-page" title="' + esc(title) + '">' + esc(title) + '</p>' +
        taskList() +
        '<div class="st-acts">' +
          '<button class="st-stay" type="button">Stay here</button>' +
          '<button class="st-go" type="button" aria-disabled="true">Open anyway</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(sheet);

    const stay = sheet.querySelector(".st-stay");
    const go   = sheet.querySelector(".st-go");

    // "Open anyway" stays dead for a beat. Not to trap you — to make sure the
    // choice is a choice rather than the second half of the click that got you
    // here. The label counts down so the wait is explained, not mysterious.
    let left = 3;
    go.textContent = "Open anyway (" + left + ")";
    openTimer = setInterval(() => {
      left--;
      if (left > 0) { go.textContent = "Open anyway (" + left + ")"; return; }
      clearInterval(openTimer); openTimer = null;
      go.textContent = "Open anyway";
      go.setAttribute("aria-disabled", "false");
      go.classList.add("armed");
    }, 1000);

    requestAnimationFrame(() => sheet.classList.add("show"));
    stay.focus();

    stay.addEventListener("click", () => close(sheet, returnTo));
    go.addEventListener("click", () => {
      if (go.getAttribute("aria-disabled") === "true") return;
      window.open(href, "_blank", "noopener,noreferrer");
      close(sheet, returnTo);
    });
    // Clicking the backdrop is a decision to not go. Same as Stay.
    sheet.addEventListener("click", e => { if (e.target === sheet) close(sheet, returnTo); });
    sheet.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); close(sheet, returnTo); return; }
      if (e.key !== "Tab") return;
      // Two buttons, so the trap is just a wrap between them.
      const f = [stay, go];
      const i = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
    });
  }

  document.addEventListener("click", e => {
    const a = e.target.closest && e.target.closest("a.site.is-junk");
    if (!a) return;
    // Let modified clicks through untouched — a middle-click or ⌘/Ctrl-click is
    // an explicit "background tab", and hijacking those breaks the browser.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    const title = a.querySelector(".ttl");
    ask(a.getAttribute("href"), title ? title.textContent : "this page", a.dataset.mins, a);
  });
})();

async function load() {
  const d = await chrome.storage.local.get(["log", "todos"]);
  log = d.log || {};
  todos = normalizeTodos(d.todos);
  render();
  moveIndicator();
  requestAnimationFrame(() => {
    const t = document.querySelector(".tabs");
    if (t) t.classList.remove("no-anim");
  });
}
load();
