// stats.js — the full scoreboard. The popup shows today's top five; this shows
// every site and every day the log has kept.

const el = id => document.getElementById(id);
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

let log = {};
let range = "today";
let todos = [];   // [{text, done}] — open ones are shown on the second-thoughts sheet
let pauseLog = []; // [{at, minutes, reason}] — why the tool was stood down
let wallet = null; // coin balance, streak and ledger — null until the worker answers

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
// Saved time is credited in whole minutes rather than measured in seconds, so
// it needs its own formatter — passing it through fmt() would divide by 60 a
// second time and report 7 minutes as "0m".
function fmtMins(m) {
  if (!m) return "0m";
  if (m < 60) return m + "m";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
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
  const out = { productive: 0, junk: 0, neutral: 0, saved: 0, blocks: 0, sites: {} };
  for (const k of keys) {
    const d = log[k];
    if (!d) continue;
    out.productive += d.productive || 0;
    out.junk       += d.junk || 0;
    out.neutral    += d.neutral || 0;
    // Minutes, not seconds — these are credited per walk-away, not measured.
    // Days logged before this existed simply have no field and contribute 0.
    out.saved      += d.saved || 0;
    out.blocks     += d.blocks || 0;
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

// ---------- week in review ----------
// A narrative, not another table. The other three tabs answer "what are the
// numbers"; this one answers "how did the week actually go", which is the
// question that makes someone open the extension on a Sunday. Everything here
// is derived from the same day log — no new tracking.

// The seven days ending today, oldest first, including days with no entry (a
// day you didn't open Chrome is part of the week's shape, not a gap to hide).
function lastNDays(n) {
  const out = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
    out.push(x.getFullYear() + "-" +
      String(x.getMonth() + 1).padStart(2, "0") + "-" +
      String(x.getDate()).padStart(2, "0"));
  }
  return out;
}

function renderReview() {
  const box = el("body");
  const days = lastNDays(7);
  const prev = lastNDays(14).slice(0, 7);      // the week before, for the trend
  const t = totals(days);
  const p = totals(prev);

  const active = t.productive + t.junk;
  const pActive = p.productive + p.junk;
  const rate  = active ? Math.round(t.productive / active * 100) : null;
  const pRate = pActive ? Math.round(p.productive / pActive * 100) : null;

  const sessions = days.reduce((a, k) => a + ((log[k] && log[k].sessions) || 0), 0);
  const sessionMins = days.reduce((a, k) => a + ((log[k] && log[k].sessionMins) || 0), 0);

  // Pauses count as something to review. A week where you tracked no time but
  // stood the tool down four times is not an empty week — it is the most
  // informative week there is, and "nothing to review" would hide exactly the
  // data worth seeing.
  const pausesThisWeek = pauseLog.filter(r => r && r.at >= Date.now() - 7 * 86400000).length;
  if (!active && !t.saved && !sessions && !pausesThisWeek) {
    box.innerHTML = '<div class="empty">Nothing to review yet.<br>' +
      'Come back after a few days of tracked time.</div>';
    return;
  }

  // Per-day focused seconds, for the strip and for finding the best day.
  const perDay = days.map(k => ({
    key: k,
    focused: (log[k] && log[k].productive) || 0,
    wasted:  (log[k] && log[k].junk) || 0
  }));
  const peak = Math.max(...perDay.map(d => d.focused), 1);
  const best = perDay.slice().sort((a, b) => b.focused - a.focused)[0];

  // The site that cost the most. Ranked by junk seconds specifically, not by
  // total time — the site you spend longest on may well be the one you work in.
  const worst = Object.entries(t.sites)
    .map(([n, v]) => ({ n, j: (v.c && v.c.junk) || 0 }))
    .filter(x => x.j > 0)
    .sort((a, b) => b.j - a.j)[0];

  // The headline. It states the one number that matters and how it moved,
  // because a rate with no direction is just a number.
  let trend = "";
  if (rate !== null && pRate !== null) {
    const delta = rate - pRate;
    if (Math.abs(delta) < 3) trend = "About the same as last week.";
    else if (delta > 0) trend = "Up " + delta + " points on last week.";
    else trend = "Down " + Math.abs(delta) + " points on last week.";
  }

  let html = '<div class="review">';

  html += '<div class="rv-head">' +
    '<div class="rv-rate">' + (rate === null ? "—" : rate + "%") + '</div>' +
    '<div class="rv-meta">' +
      '<div class="rv-t">of your tracked time was focused</div>' +
      (trend ? '<div class="rv-s">' + esc(trend) + '</div>' : '') +
    '</div>' +
  '</div>';

  // Seven bars. The shape of the week is the thing you can't get from a total —
  // four good days and three dead ones average out to the same rate as seven
  // mediocre ones, and they are not the same week.
  html += '<div class="panel"><h2>The week</h2><div class="rv-days">' +
    perDay.map(d => {
      const h = Math.round(d.focused / peak * 100);
      const [, , dd] = d.key.split("-");
      const dt = new Date(Number(d.key.slice(0, 4)), Number(d.key.slice(5, 7)) - 1, Number(dd));
      const lbl = dt.toLocaleDateString(undefined, { weekday: "narrow" });
      return '<div class="rv-day' + (d.key === todayKey() ? " is-today" : "") + '">' +
        '<div class="rv-bar-wrap"><div class="rv-bar" style="height:' + Math.max(h, 2) + '%" ' +
          'title="' + esc(dayLabel(d.key) + " · " + fmt(d.focused) + " focused") + '"></div></div>' +
        '<div class="rv-dl">' + esc(lbl) + '</div>' +
      '</div>';
    }).join("") +
  '</div></div>';

  // The four sentences worth reading. Each is a fact plus what it means, and
  // each is omitted entirely when there is nothing true to say — a review that
  // pads itself with "0 sessions" rows is one you stop opening.
  const lines = [];
  if (best && best.focused > 0) {
    lines.push(['Best day', dayLabel(best.key) + " — " + fmt(best.focused) + " focused"]);
  }
  if (t.saved) {
    lines.push(['Walked away', t.blocks + " " + (t.blocks === 1 ? "time" : "times") +
      ", worth " + fmtMins(t.saved)]);
  }
  if (sessions) {
    lines.push(['Focus sessions', sessions + " finished · " + fmtMins(sessionMins)]);
  }
  if (worst) {
    lines.push(['Cost you most', worst.n + " — " + fmt(worst.j) + " wasted"]);
  }
  if (t.junk) {
    lines.push(['Total wasted', fmt(t.junk)]);
  }

  if (lines.length) {
    html += '<div class="panel"><h2>What happened</h2><div class="rv-lines">' +
      lines.map(([k, v]) =>
        '<div class="rv-line"><span class="rv-k">' + esc(k) + '</span>' +
        '<span class="rv-v">' + esc(v) + '</span></div>').join("") +
    '</div></div>';
  }

  // Why you stood it down. This is the panel that turns a fortnight of pauses
  // into something you can act on — one pause is a moment, eleven "stuck" is a
  // problem with how you work, not with the extension.
  const cutoff = Date.now() - 7 * 86400000;
  const recent = pauseLog.filter(r => r && r.at >= cutoff);
  if (recent.length) {
    const counts = new Map();
    let skipped = 0;
    for (const r of recent) {
      if (!r.reason) { skipped++; continue; }
      counts.set(r.reason, (counts.get(r.reason) || 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const top = ranked.length ? ranked[0][1] : 1;

    html += '<div class="panel"><h2>Why you paused</h2>';
    if (ranked.length) {
      html += '<div class="why-list">' + ranked.map(([reason, n]) =>
        '<div class="why-row">' +
          '<span class="why-n">' + esc(reason) + '</span>' +
          '<span class="why-track"><span class="why-fill" style="width:' +
            Math.round(n / top * 100) + '%"></span></span>' +
          '<span class="why-c">' + n + '</span>' +
        '</div>').join("") + '</div>';
    }
    const total = recent.length;
    html += '<p class="why-foot">' + total + ' pause' + (total === 1 ? "" : "s") +
      ' this week' + (skipped ? ' · ' + skipped + ' with no reason given' : '') + '</p>';
    html += '</div>';
  }

  html += '</div>';
  box.innerHTML = html;
}

// Coins, with the ledger that justifies them. The balance alone is a number
// you either believe or don't; the ledger is what makes it checkable, which is
// the same standard the rest of this scoreboard holds itself to.
//
// Deliberately range-independent: the wallet is a running total, not a
// per-range measurement, and slicing it by "today" would invite the reading
// that the balance resets.
function coinsPanel() {
  if (!wallet || (!wallet.earned && !wallet.balance)) return "";
  const w = wallet;
  const kindLabel = {
    armed: "Kept it on",
    block: "Walked away",
    session: "Finished a session",
    spend: "Spent",
    // Named for what it actually was, not for the charge. Seeing "Wrote it down
    // late" three times in a row is the point of the fee — it is a record of
    // days that started without a list.
    latetask: "Wrote it down late"
  };
  const rows = (w.ledger || []).slice(0, 12).map(r => {
    const when = new Date(r.at).toLocaleDateString(undefined,
      { day: "numeric", month: "short" }) + " " +
      new Date(r.at).toLocaleTimeString(undefined,
      { hour: "numeric", minute: "2-digit" });
    const amt = (r.amount > 0 ? "+" : "") + r.amount;
    return '<div class="coin-row">' +
      '<span class="cr-k">' + esc(kindLabel[r.kind] || r.kind) +
        (r.note ? ' <em>' + esc(r.note) + '</em>' : '') + '</span>' +
      '<span class="cr-w">' + esc(when) + '</span>' +
      '<span class="cr-a' + (r.amount < 0 ? ' neg' : '') + '">' + esc(amt) + '</span>' +
    '</div>';
  }).join("");

  return '<div class="panel">' +
    '<h2>Coins</h2>' +
    '<div class="coin-top">' +
      '<div class="ct-box"><div class="k">Balance</div><div class="v gold">' + w.balance + '</div></div>' +
      '<div class="ct-box"><div class="k">Earned all time</div><div class="v">' + w.earned + '</div></div>' +
      '<div class="ct-box"><div class="k">Streak</div><div class="v">' +
        (w.streak ? w.streak + 'd' : '—') + '</div>' +
        (w.bestStreak ? '<div class="sub">best ' + w.bestStreak + 'd</div>' : '') +
      '</div>' +
      (w.multiplier > 1
        ? '<div class="ct-box"><div class="k">Earning rate</div><div class="v gold">×' +
          w.multiplier.toFixed(2) + '</div></div>'
        : '') +
    '</div>' +
    '<p class="note">One coin per 10 minutes with Nice Try on while you are actually at the machine. ' +
      '+5 for walking away from a wall, +10 for finishing a session. ' +
      'Talking your way past a wall pays nothing.</p>' +
    (rows ? '<div class="coin-ledger">' + rows + '</div>' : '') +
  '</div>';
}

function render() {
  if (range === "review") { renderReview(); return; }

  const keys = keysInRange();
  const t = totals(keys);
  const active = t.productive + t.junk;
  const tracked = active + t.neutral;
  const box = el("body");

  if (!tracked) {
    // Walking away from a wall costs no tracked time, so a range can hold
    // saved minutes and nothing else. Saying "nothing tracked" while the wall
    // has been turning you away would read as the counter losing your work.
    box.innerHTML = '<div class="empty">Nothing tracked in this range yet.<br>' +
      'Time is only counted while Chrome is focused and you are actually at the machine.' +
      (t.saved
        ? '<br><br><strong>' + t.saved + ' minutes saved</strong> — ' + t.blocks +
          ' ' + (t.blocks === 1 ? 'time you' : 'times you') + ' walked away.'
        : '') +
    '</div>';
    return;
  }

  const pct = active ? Math.round(t.productive / active * 100) : 0;
  const total = tracked || 1;

  // headline numbers
  let html = '<div class="cards">' +
    '<div class="card good"><div class="k">Focused</div><div class="v">' + fmt(t.productive) + '</div></div>' +
    '<div class="card bad"><div class="k">Wasted</div><div class="v">' + fmt(t.junk) + '</div></div>' +
    '<div class="card"><div class="k">Focus rate</div><div class="v">' + (active ? pct + "%" : "—") + '</div></div>' +
    // Only shown once it has happened. A "0m saved" card on day one reads as
    // a target you are already failing, when it just means no wall has come up.
    (t.saved
      ? '<div class="card saved"><div class="k">Saved by blocking</div><div class="v">' +
        fmtMins(t.saved) + '</div><div class="sub">' + t.blocks + ' ' +
        (t.blocks === 1 ? 'walk-away' : 'walk-aways') + '</div></div>'
      : '') +
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

  html += coinsPanel();

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
  "The tab that cost you {t} is not the tab that gets you where you're going.",
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
  // And only tasks that are live today: work you parked on Friday is not a
  // reason to close this tab on Tuesday, so it doesn't get to argue here.
  function taskList() {
    const today = todayKey();
    const open = todos
      .filter(t => !t.done && (!t.date || t.date <= today))
      .map(t => t.text).filter(Boolean);
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
  const d = await chrome.storage.local.get(["log", "todos", "pauseLog"]);
  log = d.log || {};
  todos = normalizeTodos(d.todos);
  pauseLog = Array.isArray(d.pauseLog) ? d.pauseLog : [];
  // Asked of the worker rather than read from storage, so the live-streak rule
  // is applied in one place. A failure here leaves wallet null and the panel
  // simply doesn't render — the rest of the scoreboard must not depend on it.
  wallet = await new Promise(res => {
    try {
      chrome.runtime.sendMessage({ type: "wallet" }, w =>
        res(chrome.runtime.lastError ? null : w));
    } catch (e) { res(null); }
  });
  render();
  moveIndicator();
  requestAnimationFrame(() => {
    const t = document.querySelector(".tabs");
    if (t) t.classList.remove("no-anim");
  });
}
load();
