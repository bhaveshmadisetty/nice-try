// stats.js — the full scoreboard. The popup shows today's top five; this shows
// every site and every day the log has kept.

const el = id => document.getElementById(id);
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

let log = {};
let range = "today";

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

        // The bar is split by category, scaled against the longest row so the
        // lengths stay comparable between rows. A page that changed category
        // during the day shows both segments rather than being forced into one.
        const c = r.c || { productive: 0, junk: 0, neutral: 0 };
        const known = c.productive + c.junk + c.neutral;
        const seg = (secs, cls) => secs > 0
          ? '<i class="' + cls + '" style="width:' + (secs / max * 100) + '%"></i>' : '';
        const bar = known
          ? seg(c.productive, "p") + seg(c.junk, "j") + seg(c.neutral, "n")
          // days logged before categories were kept: neutral grey, not a
          // colour that would assert something we don't know
          : '<i class="u" style="width:' + (r.s / max * 100) + '%"></i>';

        // Label the row by where most of its time went.
        let tagCls = "", tagTxt = "";
        if (known) {
          if (c.junk >= c.productive && c.junk >= c.neutral)            { tagCls = "junk";       tagTxt = "Wasted"; }
          else if (c.productive >= c.junk && c.productive >= c.neutral) { tagCls = "productive"; tagTxt = "Focused"; }
          else                                                          { tagCls = "neutral";    tagTxt = "Neutral"; }
        }
        const tag = tagTxt ? '<span class="tag ' + tagCls + '">' + tagTxt + '</span>' : '';

        const inner =
          '<span class="site-wrap">' +
            '<span class="n" title="' + esc(r.n) + '">' +
              '<span class="ttl">' + esc(r.n) + '</span>' + mark + tag +
            '</span>' +
            '<span class="site-bar">' + bar + '</span>' +
          '</span>' +
          '<span class="t">' + fmt(r.s) + '</span>';
        if (!href) return '<div class="site">' + inner + '</div>';
        return '<a class="site is-link' + (exact ? '' : ' is-guess') + '" href="' + esc(href) + '" ' +
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

async function load() {
  const d = await chrome.storage.local.get("log");
  log = d.log || {};
  render();
  moveIndicator();
  requestAnimationFrame(() => {
    const t = document.querySelector(".tabs");
    if (t) t.classList.remove("no-anim");
  });
}
load();
