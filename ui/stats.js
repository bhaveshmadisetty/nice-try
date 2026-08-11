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
    const s = d.sites || {};
    for (const name in s) out.sites[name] = (out.sites[name] || 0) + s[name];
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
  const rows = Object.keys(t.sites).map(n => ({ n, s: t.sites[n] }))
    .filter(r => r.s >= 30).sort((a, b) => b.s - a.s);
  if (rows.length) {
    const max = rows[0].s || 1;
    siteHtml = '<div class="panel"><h2>Every page, by time</h2>' +
      rows.map(r =>
        '<div class="site">' +
          '<div class="site-wrap">' +
            '<div class="n" title="' + esc(r.n) + '">' + esc(r.n) + '</div>' +
            '<div class="site-bar"><i style="width:' + (r.s / max * 100) + '%"></i></div>' +
          '</div>' +
          '<span class="t">' + fmt(r.s) + '</span>' +
        '</div>').join("") +
      '<p class="note">Anything under 30 seconds is left out.</p>' +
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
