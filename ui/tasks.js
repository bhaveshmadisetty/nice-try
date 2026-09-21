// tasks.js — the full-page task board. Same store, same rules as the popup's
// list: this is a bigger window onto `todos`, not a second copy of it.
//
// Two things the popup cannot do, which are the whole reason this page exists:
//   1. The month and the day are visible at once, so planning ahead doesn't
//      mean collapsing the list you were reading.
//   2. A task opens. The popup clamps a row to two lines because it lives in an
//      11rem box, so a long task is unreadable there by design.

const el = id => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
}

// ---------- dates ----------
// Copied deliberately rather than shared: these are the popup's semantics, and
// if either surface changes its mind about what a day means they must be
// changed together on purpose, not silently by one importing the other.
function keyOf(d) {
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
function todayKey() { return keyOf(new Date()); }
function dateOfKey(k) {
  const p = String(k || "").split("-");
  return new Date(+p[0], +p[1] - 1, +p[2]);
}
// Built from local Date objects rather than millisecond arithmetic, so a DST
// shift can't round a day to 0 or 2.
function daysBetween(aKey, bKey) {
  return Math.round((dateOfKey(bKey) - dateOfKey(aKey)) / 86400000);
}
function shiftKey(key, n) {
  const d = dateOfKey(key);
  d.setDate(d.getDate() + n);
  return keyOf(d);
}
const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];
const DOW = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

// The heading. Relative while that still means something, absolute once
// "in 9 days" stops being an anchor you can place.
function dayLabel(key) {
  const n = daysBetween(todayKey(), key);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  const d = dateOfKey(key);
  const base = DOW[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()];
  return Math.abs(n) < 7 ? base : base + " " + d.getFullYear();
}
// The same name in a sentence, where "Today" would read as a proper noun.
function dayLabelLower(key) {
  const n = daysBetween(todayKey(), key);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return dayLabel(key);
}

// ---------- state ----------
let todos = [];
let viewKey = todayKey();
let calMonth = null;      // pinned to the 1st of the displayed month
let openIndex = -1;       // task index the detail sheet is showing, -1 = closed
let pendingDate = "";     // date chosen in the sheet, applied on Save
let query = "";           // search text; non-empty swaps the day view for results
let filter = "all";       // all | open | done, within the viewed day

// Move the view to a day and bring the month grid with it — landing on a date
// the calendar isn't showing is how the selection ends up invisible.
function goToDay(key) {
  viewKey = key;
  const d = dateOfKey(key);
  calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  // A day and a search cannot both be on screen; going to a day ends the search.
  if (query) { query = ""; el("search").value = ""; }
  render();
}

function hostOfUrl(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch (e) { return ""; }
}
function extractUrl(s) {
  const m = String(s || "").match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : "";
}
// A hostname someone could actually have typed: labels of letters, digits and
// hyphens, at least one dot, nothing percent-encoded. Same rule as the popup.
function looksLikeHost(h) {
  return h === "localhost" || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(h || "");
}

// Accepts the legacy plain-string shape. Unlike the popup this does NOT rewrite
// storage: the popup owns that migration (it has the time log needed to date a
// finished legacy task properly). Adopting an undated open task into today here
// too would be a second writer racing the first for the same repair.
function normalize(raw) {
  return (raw || [])
    .map(t => (typeof t === "string" ? { text: t, done: false } : t))
    .filter(t => t && t.text)
    // Give every task a rank from where it already sits. Array position IS
    // insertion order for everything written before ranks existed, so reading
    // it back is the whole migration -- no guessing, and the list you had is
    // the list you get. Nothing is written to storage from here: this page is
    // not the migration writer (see the note above), and sorting only needs
    // the number in memory. Spaced by RANK_GAP so a row can be dropped between
    // two others without renumbering everything below it.
    .map((t, i) => (typeof t.rank === "number" && isFinite(t.rank))
      ? t
      : Object.assign({}, t, { rank: (i + 1) * RANK_GAP }));
}

// Wide enough that dropping a row between two neighbours stays whole-numbered
// for far longer than any real list will need, and nowhere near a float limit.
const RANK_GAP = 1024;

// The one ordering rule, used by every list on this page.
//
// Done sinks -- a ticked task climbing back over live work is noise. Above
// that line the order is YOURS: rank ascending, so the first thing added is
// the first thing read, and dragging a row is the last word on where it sits.
//
// Age is now the tiebreaker, not the ruler. Before ranks existed the oldest
// debt was forced to the top, which is a good default and a bad law -- there
// was no way to say "I know it is eight days old, it still goes third". The
// age now only separates two tasks you have never said anything about, and
// stops arguing the moment you move one.
function byOrder(a, b) {
  return (a.t.done ? 1 : 0) - (b.t.done ? 1 : 0) ||
         rankOf(a.t) - rankOf(b.t) ||
         b.overdue - a.overdue;
}

// A rank of 0 is a real position -- dragged to the very top -- so it cannot be
// tested for truthiness. Anything with no usable number sorts to the END,
// behind every task that has been deliberately placed. normalize() means this
// should not happen on this page; it matters because storage is written by
// three surfaces and only one of them is this one.
function rankOf(t) {
  return (typeof t.rank === "number" && isFinite(t.rank)) ? t.rank : Infinity;
}

// Which tasks belong on a given day. Open work carries forward onto today and
// nowhere else; a finished task stops travelling and stays on the day it was
// actually ticked, so scrolling back shows what that day really held.
function tasksFor(key) {
  const out = [];
  todos.forEach((t, i) => {
    const item = { t, i, overdue: 0 };
    if (t.done) {
      if ((t.doneDate || t.date) === key) out.push(item);
    } else if (!t.date || t.date === key) {
      // An undated task is treated as today's, matching what the popup's
      // migration will stamp it as the next time it runs.
      if (t.date || key === todayKey()) out.push(item);
    } else if (t.date < key && key === todayKey()) {
      item.overdue = daysBetween(t.date, key);
      out.push(item);
    }
  });
  return out.sort(byOrder);
}

async function save() {
  await chrome.storage.local.set({ todos });
  render();
}

// ---------- motion ----------
// Durations and curves are read from the stylesheet rather than restated here:
// the linear() springs in :root are only shaped correctly at their own settle
// time, so a number copied into JS goes wrong the moment the token is tuned.
const motion = (() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  let curve = null;
  function tokens() {
    if (curve) return curve;
    const cs = getComputedStyle(document.documentElement);
    const ms = (n, d) => (parseFloat(cs.getPropertyValue(n)) || d) * 1000;
    curve = {
      ease: cs.getPropertyValue("--ease").trim() || "ease-out",
      spring: cs.getPropertyValue("--spring").trim() || "ease-out",
      fast: ms("--dur-fast", .16),
      mid: ms("--dur-mid", .28),
      springT: ms("--spring-t", .6)
    };
    return curve;
  }
  return { tokens, get off() { return reduce.matches; } };
})();

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Every rendered row, keyed by the task index it is showing. The index is the
// position in `todos`, which survives a re-render -- the element does not, so
// this is the only honest way to say "the row that was here is now there".
function rowsByIndex() {
  const map = new Map();
  document.querySelectorAll("#taskList .task, #searchList .task")
    .forEach(n => map.set(+n.dataset.i, n));
  return map;
}

// FLIP: measure where every row is, let the render move them, then start each
// one from where it used to be and let it travel to where it now is. Without
// this a ticked task is simply gone from under the cursor and present at the
// bottom, which is the thing that reads as random -- the eye never saw it move,
// so it has nothing to connect the two positions with.
function travel(before) {
  if (motion.off) return;
  const c = motion.tokens();
  const after = rowsByIndex();
  after.forEach((node, i) => {
    const was = before.get(i);
    if (!was) return;                       // newly rendered row: nothing to move from
    const now = node.getBoundingClientRect();
    const dy = was.top - now.top;
    if (Math.abs(dy) < 1) return;           // stayed put
    node.animate(
      [{ transform: "translateY(" + dy + "px)" }, { transform: "none" }],
      { duration: c.springT, easing: c.spring }
    );
  });
}

// Geometry of the rows on screen right now, to be handed to travel() after the
// list has been repainted.
function measureRows() {
  const map = new Map();
  rowsByIndex().forEach((n, i) => map.set(i, n.getBoundingClientRect()));
  return map;
}

// Ticking a task off, as something you watch happen: the line is drawn through
// the words, and only then does the row set off for its new place. Saving is
// what re-renders, so it is held back until the strike has played -- the row
// has to still exist to be struck through.
//
// The state is flipped in `todos` immediately either way. Only the paint waits,
// so a second click, a storage event, or the page being closed mid-animation
// all land on data that is already correct.
let striking = null;      // the row mid-animation, so a second click can cut it short
async function strikeThenSave(row, done) {
  if (striking) {         // an earlier strike is still playing; let it go
    striking.classList.remove("is-striking", "is-unstriking");
    striking = null;
  }
  if (motion.off || !row) { await save(); return; }

  const c = motion.tokens();
  // The class drives the line; `done` is already true in the data, so adding
  // .done here is what makes the checkbox fill and the text fade at the same
  // moment the line starts being drawn.
  row.classList.toggle("done", done);
  row.classList.add(done ? "is-striking" : "is-unstriking");
  striking = row;

  await wait(done ? c.mid : c.fast);

  // The row may have been re-rendered out from under us by a storage event
  // arriving from the popup. If so the animation is over anyway.
  if (striking === row) {
    row.classList.remove("is-striking", "is-unstriking");
    striking = null;
  }

  const before = measureRows();
  await save();
  travel(before);
}

// ---------- day list ----------
function render() {
  if (query) renderSearch(); else renderDay();
  // A keyboard move re-renders the row out from under the focus that asked for
  // it; this puts the focus back on the task, wherever it just went.
  if (!query) restoreFocus();
  el("searchView").hidden = !query;
  el("dayView").hidden = !!query;
  renderCal();
  renderBacklog();
  renderMonthStats();
}

// One row, used by the day list and by search alike. A result you can tick in
// the search view but not in the day view (or vice versa) would be two
// different things wearing the same clothes.
// `mark` is the substring to highlight; `showDay` adds the date chip that only
// makes sense where rows come from more than one day.
function rowHTML({ t, i, overdue }, mark, showDay) {
  // Whether the link is exempting anything right now. The worker grants the
  // exemption only for a task that is open and whose day has arrived — see
  // taskLinkIdentities in background.js; these conditions must stay in step.
  const dormant = t.done || (t.date && t.date > todayKey());
  const note = t.done
    ? "· done, so it's walled again"
    : (t.date && t.date > todayKey())
      ? "· opens on " + esc(dayLabelLower(t.date))
      : (t.late ? "· added from a block" : "· open, nothing else");
  const sub = t.host
    ? '<a class="task-sub' + (dormant ? " is-dormant" : "") + '" href="' + esc(t.url || "") + '" ' +
      'data-act="open" title="' + esc(t.url || "") + '" rel="noreferrer noopener">' +
        '<span class="lk-ico" aria-hidden="true">' + (dormant ? "⊘" : "↗") + '</span>' +
        '<span class="lk-tx">' + esc(t.host) + '</span>' +
        '<span class="lk-note">' + note + '</span>' +
      '</a>'
    // `from` is the older shape — a note captured on the way out of a wall.
    // It grants no exemption, so it must not wear the accent colour.
    : (t.from
        ? '<span class="task-sub is-note" title="' + esc(t.from) + '">' +
            '<span class="lk-ico" aria-hidden="true">✎</span>' +
            '<span class="lk-tx">' + (t.late ? "added late, from " : "noted while leaving ") +
              esc(hostOfUrl(t.from) || "a site") + '</span>' +
          '</span>'
        : "");
  const age = overdue
    ? '<span class="age' + (overdue >= 3 ? " hot" : "") + '" title="' +
      (overdue === 1 ? "Moved once, from yesterday"
                     : "You've moved this " + overdue + " days running") + '">' +
      (overdue === 1 ? "moved once" : "moved " + overdue + "×") + '</span>'
    : "";
  // The chip is a button so the result can be followed back to its day.
  const chip = showDay
    ? '<button class="res-day" type="button" data-act="goday" ' +
      'data-key="' + esc(t.done ? (t.doneDate || t.date) : t.date) + '" ' +
      'title="Go to this day">' + esc(dayLabel(t.date)) + '</button>'
    : "";
  // The grip is the drag surface AND the keyboard's handle on the row: it is a
  // real button, so Tab reaches it and Alt+Arrow has something focused to move.
  // Search results get none -- they span days, so there is no position above or
  // below that could be written down.
  const grip = showDay ? "" :
    '<button class="grip" type="button" tabindex="0" ' +
      'aria-label="Reorder: hold to drag, or Alt with the up and down arrows" ' +
      'title="Drag to reorder — or focus this and press Alt+↑ / Alt+↓">' +
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      '<circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/>' +
      '<circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/>' +
      '<circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/>' +
      '</svg></button>';
  return '<div class="task' + (t.done ? " done" : "") + '" data-i="' + i + '"' +
      (showDay ? "" : ' draggable="true"') + '>' +
    grip +
    '<span class="box" data-act="toggle" role="button" tabindex="0" ' +
      'aria-label="' + (t.done ? "Mark not done" : "Mark done") + '"></span>' +
    '<span class="body">' +
      // The label sits in its own inline span so the strike-through line has
      // something text-shaped to be drawn across; the button itself is a
      // full-width block and a line on it would overshoot a short task.
      '<button class="txt" type="button" data-act="detail" ' +
        'title="Open this task"><span class="tx">' + hilite(t.text, mark) +
        '</span></button>' +
      chip + age + sub +
    '</span>' +
    '<span class="acts">' +
      '<button class="act" type="button" data-act="detail" title="Open">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M9 18l6-6-6-6"/></svg></button>' +
      '<button class="act del" type="button" data-act="del" title="Remove">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M18 6L6 18M6 6l12 12"/></svg></button>' +
    '</span>' +
  '</div>';
}

// Escape first, then wrap the match — building the <mark> before escaping would
// let a task containing "<" destroy the row it is rendered into.
function hilite(text, mark) {
  const safe = esc(text);
  if (!mark) return safe;
  const needle = esc(mark);
  const at = safe.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return safe;
  return safe.slice(0, at) + "<mark>" + safe.slice(at, at + needle.length) +
         "</mark>" + safe.slice(at + needle.length);
}

// What the day list is actually showing, in the order it is showing it. The
// drag code positions against this and renderDay paints from it -- one answer,
// so a dropped row cannot land somewhere the screen never offered. The filter
// is part of it deliberately: with "open" selected the done rows are not on
// screen, and a drop position that counts invisible rows would be off by
// however many of them are hiding.
function visibleRows() {
  const all = tasksFor(viewKey);
  if (!all.some(r => r.t.done)) return all;
  return filter === "open" ? all.filter(r => !r.t.done)
       : filter === "done" ? all.filter(r => r.t.done)
       : all;
}

function renderDay() {
  const all = tasksFor(viewKey);
  const done = all.filter(r => r.t.done).length;
  const n = daysBetween(todayKey(), viewKey);

  el("dayH").textContent = dayLabel(viewKey);
  el("dayCount").textContent = all.length ? done + " / " + all.length + " done" : "";
  el("todayBtn").hidden = viewKey === todayKey();

  const d = dateOfKey(viewKey);
  const stamp = DOW[d.getDay()] + ", " + d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
  el("daySub").textContent = n === 0
    ? stamp + " · open work from earlier days is carried here"
    : n > 0 ? stamp + " · planned ahead" : stamp;

  el("taskInput").placeholder = n === 0
    ? "Add a task for today"
    : "Add a task for " + dayLabelLower(viewKey);

  // Nothing ticked yet means all three filters produce the same list.
  el("filters").hidden = !done;
  const rows = visibleRows();

  const list = el("taskList");
  if (!rows.length) {
    list.innerHTML = '<p class="empty">' + (
      all.length ? (filter === "open"
          ? "Everything here is done. Nothing left on this day."
          : "Nothing ticked off on this day yet.")
        : n < 0 ? "Nothing was set for this day."
        : n > 0 ? "Nothing planned for " + esc(dayLabelLower(viewKey)) +
                  " yet. Anything you add waits until that day arrives."
        : "Nothing set for today. Add what you actually need to do — the wall shows these when you drift."
    ) + '</p>';
    return;
  }
  list.innerHTML = rows.map(r => rowHTML(r, "", false)).join("");
}

// ---------- search ----------
// Matches the task text and its host, so "leetcode" finds a task whose link is
// the only place that word appears.
function searchRows(q) {
  const needle = q.toLowerCase();
  const out = [];
  todos.forEach((t, i) => {
    const hay = (t.text || "") + " " + (t.host || "");
    if (hay.toLowerCase().includes(needle)) {
      const overdue = !t.done && t.date && t.date < todayKey()
        ? daysBetween(t.date, todayKey()) : 0;
      out.push({ t, i, overdue });
    }
  });
  // Open work first, then most recent — a search is nearly always a search for
  // something still to do.
  return out.sort((a, b) =>
    (a.t.done ? 1 : 0) - (b.t.done ? 1 : 0) ||
    String(b.t.date || "").localeCompare(String(a.t.date || "")));
}

function renderSearch() {
  const rows = searchRows(query);
  el("searchH").textContent = rows.length
    ? rows.length + (rows.length === 1 ? " match" : " matches")
    : "No matches";
  el("searchSub").textContent = rows.length
    ? 'Across every day, for "' + query + '". Click a date to go there.'
    : 'Nothing matches "' + query + '".';
  el("searchList").innerHTML = rows.length
    ? rows.map(r => rowHTML(r, query, true)).join("")
    : '<p class="empty">No task mentions that. Try a shorter word — the search ' +
      'looks at the task text and its link.</p>';
}

// ---------- backlog ----------
// Everything still open and dated before today, worst first. This is the only
// view that shows the whole pile at once; a day column structurally cannot.
function overdueRows() {
  const t0 = todayKey();
  const out = [];
  todos.forEach((t, i) => {
    if (!t.done && t.date && t.date < t0) {
      out.push({ t, i, overdue: daysBetween(t.date, t0) });
    }
  });
  return out.sort((a, b) => b.overdue - a.overdue);
}

const BACKLOG_SHOWN = 5;

function renderBacklog() {
  const rows = overdueRows();
  const card = el("backlogCard");
  // No overdue work means no card. An empty "you're behind" panel on a clear
  // week is a scold with nothing behind it.
  card.hidden = !rows.length;
  if (!rows.length) return;

  const worst = rows[0].overdue;
  el("backlogN").textContent = rows.length;
  el("backlogSub").textContent = rows.length === 1
    ? "One task you've carried past its day."
    : "Carried past their day. The oldest has moved " + worst + " days running.";

  el("backlogList").innerHTML = rows.slice(0, BACKLOG_SHOWN).map(({ t, i, overdue }) =>
    '<button class="bl-row" type="button" data-i="' + i + '" ' +
      'title="' + esc(t.text) + '">' +
      '<span class="bl-age' + (overdue >= 3 ? " hot" : "") + '">' + overdue + 'd</span>' +
      '<span class="bl-tx">' + esc(t.text) + '</span>' +
    '</button>').join("") +
    (rows.length > BACKLOG_SHOWN
      ? '<p class="bl-more">and ' + (rows.length - BACKLOG_SHOWN) + ' more</p>'
      : "");
}

// A backlog row is a pointer to where the task lives, so it opens the task on
// its own day rather than editing it out of context.
el("backlogList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-i]");
  if (!b) return;
  const i = +b.dataset.i;
  const t = todos[i];
  if (!t) return;
  goToDay(t.date || todayKey());
  openDetail(i);
});

// ---------- month stats ----------
// Counts the displayed month, not all time: a lifetime total stops moving and
// stops meaning anything, where a month you are inside of still can.
function renderMonthStats() {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const pre = y + "-" + String(m + 1).padStart(2, "0");
  let done = 0, open = 0;
  const days = new Set();
  todos.forEach(t => {
    const key = t.done ? (t.doneDate || t.date) : t.date;
    if (!key || key.slice(0, 7) !== pre) return;
    if (t.done) done++; else open++;
    days.add(key);
  });
  el("mDone").textContent = done;
  el("mOpen").textContent = open;
  el("mDays").textContent = days.size;
}

// ---------- reorder ----------
// Priority is a thing you SET, not a thing the list infers. The day view is
// therefore drag-sortable, and every move writes a rank -- an order the popup
// reads too, so the two surfaces cannot disagree about what comes first.
//
// Only the day view. Search results come from every day at once, so "above"
// there is not a position anything could be saved to; the drag handle is not
// rendered on those rows at all.

// Put `moved` where `before` currently is, and push `before` down. Ranks are
// rewritten only for the rows that actually shift, which is what keeps a drag
// from restamping the whole list.
//
// A null `before` means "past the last row" -- dropped at the end.
function rankBetween(prevRank, nextRank) {
  if (prevRank == null && nextRank == null) return RANK_GAP;
  if (prevRank == null) return nextRank - RANK_GAP;
  if (nextRank == null) return prevRank + RANK_GAP;
  return (prevRank + nextRank) / 2;
}

// Halving the gap forever eventually lands two neighbours on the same float,
// at which point the sort has nothing left to separate them. Rather than let
// that happen quietly, respace the whole day back onto clean multiples and try
// again -- rare, cheap, and invisible.
function needsRespace(prevRank, nextRank) {
  return prevRank != null && nextRank != null &&
         Math.abs(nextRank - prevRank) < 0.001;
}
function respace(rows) {
  rows.forEach((r, n) => { r.t.rank = (n + 1) * RANK_GAP; });
}

// Move the task at index `from` to sit where the row at index `to` sits, using
// the CURRENTLY RENDERED order as the truth about what is above and below.
// Working off the rendered rows rather than the todos array matters: the array
// is insertion order, the screen is rank order, and the user is pointing at
// the screen.
function moveTask(rows, fromPos, toPos) {
  if (fromPos === toPos || fromPos < 0 || toPos < 0) return false;
  if (fromPos >= rows.length || toPos >= rows.length) return false;

  // A task cannot be dragged across the done line. Above it the order is
  // yours; below it the rule is "this is finished", and letting a ticked task
  // be parked in the middle of live work would make that line meaningless.
  if (rows[fromPos].t.done !== rows[toPos].t.done) return false;

  const reordered = rows.slice();
  const [moved] = reordered.splice(fromPos, 1);
  reordered.splice(toPos, 0, moved);

  // Rank against its new neighbours WITHIN the same done-group, so a live task
  // dropped at the bottom does not have to out-rank the finished ones under it.
  const group = reordered.filter(r => r.t.done === moved.t.done);
  const at = group.indexOf(moved);
  const prev = at > 0 ? group[at - 1].t.rank : null;
  const next = at < group.length - 1 ? group[at + 1].t.rank : null;

  if (needsRespace(prev, next)) {
    respace(group);
  } else {
    moved.t.rank = rankBetween(prev, next);
  }
  return true;
}

// Which rendered rows a drag is allowed to move among. Recomputed at the start
// of every gesture rather than cached, because a storage change from the popup
// can rewrite the list between one drag and the next.
function currentRows() {
  return query ? [] : visibleRows();
}

let dragFrom = -1;   // rendered position the drag started at
let dragTo = -1;     // rendered position it is currently hovering

function clearDragMarks() {
  document.querySelectorAll("#taskList .task").forEach(n => {
    n.classList.remove("is-dragging", "drop-above", "drop-below");
  });
}

function positionOf(row) {
  return Array.prototype.indexOf.call(row.parentNode.children, row);
}

const dayList = el("taskList");

dayList.addEventListener("dragstart", (e) => {
  const row = e.target.closest && e.target.closest(".task");
  if (!row || query) return;
  dragFrom = positionOf(row);
  dragTo = dragFrom;
  row.classList.add("is-dragging");
  e.dataTransfer.effectAllowed = "move";
  // Firefox refuses to start a drag without payload; the index is the payload
  // everywhere else ignores.
  try { e.dataTransfer.setData("text/plain", String(dragFrom)); } catch (err) {}
});

dayList.addEventListener("dragover", (e) => {
  if (dragFrom < 0) return;
  const row = e.target.closest && e.target.closest(".task");
  if (!row) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  const pos = positionOf(row);
  if (pos === dragFrom) { dragTo = dragFrom; return; }

  // Which half of the row the pointer is in decides whether the task lands
  // above or below it -- the difference between "put it third" and "put it
  // fourth", which a row-level hit test cannot express.
  const box = row.getBoundingClientRect();
  const below = (e.clientY - box.top) > box.height / 2;
  dragTo = below ? pos + (pos < dragFrom ? 1 : 0) : pos - (pos > dragFrom ? 1 : 0);

  clearDropMarks();
  row.classList.add(below ? "drop-below" : "drop-above");
});

function clearDropMarks() {
  document.querySelectorAll("#taskList .task").forEach(n =>
    n.classList.remove("drop-above", "drop-below"));
}

dayList.addEventListener("dragend", () => {
  clearDragMarks();
  dragFrom = dragTo = -1;
});

dayList.addEventListener("drop", (e) => {
  if (dragFrom < 0) return;
  e.preventDefault();
  const rows = currentRows();
  const from = dragFrom, to = dragTo;
  clearDragMarks();
  dragFrom = dragTo = -1;
  if (moveTask(rows, from, to)) save();
});

// The keyboard route to the same thing. A drag is a mouse gesture and a list
// you can only reorder with a mouse is a list some people cannot reorder --
// Alt+Arrow moves the focused row one place, which is also just faster than
// dragging when you know exactly where the task belongs.
function nudge(dir) {
  const focused = document.activeElement &&
    document.activeElement.closest && document.activeElement.closest(".task");
  if (!focused || query) return false;
  const rows = currentRows();
  const from = positionOf(focused);
  if (!moveTask(rows, from, from + dir)) return false;
  // Remember what to re-focus: save() re-renders, so the element under the
  // keyboard right now is about to be replaced by a new one.
  refocusIndex = rows[from] ? rows[from].i : -1;
  save();
  return true;
}
let refocusIndex = -1;

// After a keyboard move the focus has to follow the task to its new row, or
// the next Alt+Arrow moves whatever happens to be sitting where you were.
function restoreFocus() {
  if (refocusIndex < 0) return;
  const row = dayList.querySelector('.task[data-i="' + refocusIndex + '"]');
  refocusIndex = -1;
  if (!row) return;
  const grip = row.querySelector(".grip");
  (grip || row).focus();
}

// Shared by the day list and the search results, so a row behaves the same
// wherever it is being read.
function onRowClick(e) {
  const link = e.target.closest && e.target.closest('[data-act="open"]');
  if (link) {
    e.preventDefault();
    const url = link.getAttribute("href");
    // Opened in a new tab rather than navigating this one — the page you came
    // here from should still be here when the link is done with.
    if (url) chrome.tabs.create({ url });
    return;
  }
  const hit = e.target.closest && e.target.closest("[data-act]");
  if (!hit) return;
  if (hit.dataset.act === "goday") { goToDay(hit.dataset.key); return; }
  const row = hit.closest(".task");
  if (!row) return;
  const i = +row.dataset.i;
  const act = hit.dataset.act;
  if (act === "toggle") {
    const t = todos[i];
    t.done = !t.done;
    // Completing pins the task to the day it was finished, so it stops
    // travelling and that day's record stays true. Un-ticking releases it.
    //
    // Deliberately NOT viewKey: in search, rows come from every day at once and
    // viewKey is whatever day happens to be selected behind the results, which
    // has nothing to do with the task being ticked. Today is the honest answer
    // for work finished now; a task dated ahead keeps its own day rather than
    // claiming to have been finished before it was set.
    if (t.done) {
      const t0 = todayKey();
      t.doneDate = (t.date && t.date > t0) ? t.date : t0;
    } else delete t.doneDate;
    // Not save() directly: the strike has to be drawn through this row before
    // the render replaces it, and the row's travel to its new place has to be
    // seen rather than inferred.
    strikeThenSave(row, t.done);
  } else if (act === "del") {
    todos.splice(i, 1);
    save();
  } else if (act === "detail") {
    openDetail(i);
  }
}

// The checkbox is a span carrying role="button", so it has to honour the keys a
// real button would.
function onRowKey(e) {
  if (e.key !== "Enter" && e.key !== " ") return;
  const box = e.target.closest && e.target.closest('[data-act="toggle"]');
  if (!box) return;
  e.preventDefault();
  box.click();
}

[el("taskList"), el("searchList")].forEach(n => {
  n.addEventListener("click", onRowClick);
  n.addEventListener("keydown", onRowKey);
});

// ---------- search wiring ----------
el("search").addEventListener("input", () => {
  query = el("search").value.trim();
  render();
});
// Escape clears the search before it does anything else — the field is where a
// keyboard user will be when they change their mind.
el("search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.stopPropagation(); clearSearch(); }
});
function clearSearch() {
  query = "";
  el("search").value = "";
  render();
  el("search").blur();
}
el("clearSearch").addEventListener("click", clearSearch);

el("filters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]");
  if (!b) return;
  filter = b.dataset.f;
  document.querySelectorAll("#filters .filt").forEach(x =>
    x.classList.toggle("is-on", x === b));
  renderDay();
});

// A new task goes to the BOTTOM of the day it was written for -- the thumb
// rule, stated as a number: first in, first up. Ranked past whatever is already
// there rather than past every task in storage, so days stay independent and a
// busy Monday cannot push Tuesday's first task into the hundreds.
function nextRank(key) {
  let max = 0;
  todos.forEach(t => {
    const on = t.done ? (t.doneDate || t.date) : t.date;
    if (on === key && typeof t.rank === "number" && t.rank > max) max = t.rank;
  });
  return max + RANK_GAP;
}

function addTask() {
  const raw = el("taskInput").value.trim();
  if (!raw) return;
  const url = extractUrl(raw);
  const host = hostOfUrl(url);
  // Keep the link out of the visible text — it gets its own line.
  const text = url ? raw.replace(url, "").trim().replace(/[-–—:]\s*$/, "").trim() : raw;
  const item = { text: text || host || raw, done: false, date: viewKey,
                 rank: nextRank(viewKey) };
  if (url && host) {
    item.url = url; item.host = host;
    chrome.runtime.sendMessage({ type: "taskLinkAdded" });
  }
  todos.push(item);
  el("taskInput").value = "";
  save();
}
el("addBtn").addEventListener("click", addTask);
el("taskInput").addEventListener("keydown", e => { if (e.key === "Enter") addTask(); });

// ---------- calendar ----------
// The dot counts what was WRITTEN for a day, not what tasksFor() shows there:
// carried-over debt appears on today's row with its age, and counting it here
// would mark today for work that belongs to the day it was actually set.
function countFor(key) {
  let open = 0, total = 0;
  todos.forEach(t => {
    if (t.done) { if ((t.doneDate || t.date) === key) total++; }
    else if (t.date === key) { open++; total++; }
  });
  return { open, total };
}

function renderCal() {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  el("calTitle").textContent = MONTHS[m] + " " + y;

  const first = new Date(y, m, 1).getDay();       // 0=Sun, matches the header
  const days = new Date(y, m + 1, 0).getDate();   // day 0 of next month
  const tKey = todayKey();

  let cells = "";
  for (let i = 0; i < first; i++) cells += '<span class="cal-pad"></span>';
  for (let d = 1; d <= days; d++) {
    const key = keyOf(new Date(y, m, d));
    const { open, total } = countFor(key);
    const cls = ["cal-day"];
    if (key === viewKey) cls.push("sel");
    if (key === tKey) cls.push("today");
    if (key > tKey) cls.push("future");
    // Green only when there WAS work and none of it is left. An empty day is
    // not an achievement, and painting it green would say it was.
    const pip = total
      ? '<i class="pip' + (open > 2 ? " many" : "") + (open === 0 ? " clear" : "") + '"></i>'
      : "";
    const label = d + " " + MONTHS[m] + " " + y +
      (total ? ", " + (open ? open + " open" : "all done") : "");
    cells += '<button type="button" class="' + cls.join(" ") + '" data-key="' + key + '"' +
      (key === viewKey ? ' aria-current="date"' : '') +
      ' aria-label="' + label + '">' + d + pip + '</button>';
  }
  el("calGrid").innerHTML = cells;
}

function shiftMonth(n) {
  calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + n, 1);
  renderCal();
  // The stats card counts the DISPLAYED month, so paging the grid has to
  // recount — otherwise it keeps reporting the month you just left.
  renderMonthStats();
}
el("calPrev").addEventListener("click", () => shiftMonth(-1));
el("calNext").addEventListener("click", () => shiftMonth(1));

el("calGrid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-key]");
  if (b) goToDay(b.dataset.key);
});

el("todayBtn").addEventListener("click", () => goToDay(todayKey()));

// ---------- detail ----------
function openDetail(i) {
  const t = todos[i];
  if (!t) return;
  openIndex = i;
  pendingDate = "";

  el("shText").value = t.text || "";
  el("shUrl").value = t.url || "";
  el("shUrl").classList.remove("bad");
  // The open affordance sits beside the field, so the field can stay a field.
  el("shOpen").hidden = !t.url;
  el("shOpen").href = t.url || "#";
  el("shToggle").textContent = t.done ? "Mark not done" : "Mark done";

  const written = t.date ? dayLabel(t.date) : "no date";
  const rows = [];
  rows.push(['Written for', esc(written)]);
  if (t.done) rows.push(['Finished', esc(dayLabel(t.doneDate || t.date))]);
  if (!t.done && t.date && t.date < todayKey()) {
    const n = daysBetween(t.date, todayKey());
    rows.push(['Carried', esc(n === 1 ? "moved once, from yesterday"
                                      : "moved " + n + " days running")]);
  }
  if (t.url) {
    const live = !t.done && (!t.date || t.date <= todayKey());
    // The link itself is in the field above; this row says what it is doing.
    rows.push(['Wall', live
      ? 'This page is exempt while the task is open.'
      : (t.done ? 'Task is done, so the page is walled again.'
                : 'Exempt from ' + esc(dayLabelLower(t.date)) + '.')]);
  }
  if (t.from) rows.push(['Captured on', esc(hostOfUrl(t.from) || t.from)]);

  el("shMeta").innerHTML = rows.map(([k, v]) =>
    '<div class="sh-line"><span class="sh-k">' + k + '</span><span class="sh-v">' + v + '</span></div>'
  ).join("");

  el("moveDate").value = t.date || todayKey();
  syncMoveButtons(t.date || todayKey());

  const scrim = el("detail");
  scrim.hidden = false;
  // A forced layout and then a frame, so the transition has a measured start
  // state to animate from rather than none.
  void scrim.offsetHeight;
  requestAnimationFrame(() => scrim.classList.add("in"));
  el("shText").focus();
}

function closeDetail() {
  const scrim = el("detail");
  scrim.classList.remove("in");
  openIndex = -1;
  // Wait out the fade before pulling it from the layout, or it vanishes
  // instantly and the transition is never seen.
  setTimeout(() => { if (!scrim.classList.contains("in")) scrim.hidden = true; }, 300);
}

// Which of the three shortcuts, if any, matches the date now selected.
function syncMoveButtons(key) {
  const map = {
    today: todayKey(),
    tomorrow: shiftKey(todayKey(), 1),
    week: shiftKey(todayKey(), 7)
  };
  document.querySelectorAll("#moveRow .move-btn").forEach(b => {
    b.classList.toggle("is-on", map[b.dataset.move] === key);
  });
}

el("moveRow").addEventListener("click", (e) => {
  const b = e.target.closest("[data-move]");
  if (!b) return;
  const map = {
    today: todayKey(),
    tomorrow: shiftKey(todayKey(), 1),
    week: shiftKey(todayKey(), 7)
  };
  pendingDate = map[b.dataset.move];
  el("moveDate").value = pendingDate;
  syncMoveButtons(pendingDate);
});

el("moveDate").addEventListener("change", () => {
  const v = el("moveDate").value;
  if (!v) return;
  pendingDate = v;
  syncMoveButtons(v);
});

el("shSave").addEventListener("click", () => {
  if (openIndex < 0) return;
  const t = todos[openIndex];
  let raw = el("shText").value.trim();
  let url = el("shUrl").value.trim();
  el("shUrl").classList.remove("bad");
  // An emptied task is a deleted task — saving a blank row would leave an
  // untouchable ghost in the list.
  if (!raw && !url) { todos.splice(openIndex, 1); closeDetail(); save(); return; }

  // A link pasted into the text here is picked up exactly as it is on the add
  // row, so editing is not a way to end up with a task the wall reads
  // differently from one typed in the first place. Only when the link field
  // is empty, though — a link put there on purpose is the one that counts.
  const inText = extractUrl(raw);
  if (inText && !url) {
    url = inText;
    raw = raw.replace(inText, "").trim().replace(/[-–—:]\s*$/, "").trim();
  }
  // "leetcode.com/problems/x" is a link to anyone reading it; the scheme is
  // the one part nobody types.
  if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
  const host = url ? hostOfUrl(url) : "";
  // hostOfUrl alone is not the test: Chrome's URL parser lets "https://not a
  // link" through with the spaces percent-encoded into the host. See
  // looksLikeHost.
  if (url && (!looksLikeHost(host) || !/^https?:/i.test(url))) {
    // Not saved, not lost: the field is marked and keeps what was typed.
    el("shUrl").classList.add("bad");
    el("shUrl").focus();
    return;
  }
  t.text = raw || host || t.text;
  if (host) {
    if (t.url !== url) {
      t.url = url; t.host = host;
      chrome.runtime.sendMessage({ type: "taskLinkAdded" });
    }
  } else {
    // A cleared field takes the exemption with it — it is derived from the
    // list, so removing the link here is the whole change.
    delete t.url; delete t.host;
  }

  if (pendingDate && pendingDate !== t.date) {
    t.date = pendingDate;
    // A finished task is filed on the day it was finished, so moving it has to
    // move that stamp too — otherwise it lands on the new day's list while
    // still claiming to have been completed on the old one.
    if (t.done) t.doneDate = pendingDate;
    // Follow the task to wherever it went, rather than leaving the user staring
    // at the day it just left. Set directly rather than via goToDay() because
    // save() renders a moment later anyway — and a move made from a search
    // result should leave the results up, not silently clear them.
    if (!query) {
      viewKey = pendingDate;
      const d = dateOfKey(pendingDate);
      calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    }
  }
  closeDetail();
  save();
});

el("shToggle").addEventListener("click", () => {
  if (openIndex < 0) return;
  const t = todos[openIndex];
  t.done = !t.done;
  // Same rule as the list: finished now means today, unless the task is dated
  // ahead, in which case it keeps its own day rather than claiming to have been
  // finished before it was set.
  if (t.done) {
    const t0 = todayKey();
    t.doneDate = (t.date && t.date > t0) ? t.date : t0;
  } else delete t.doneDate;
  closeDetail();
  // The sheet was covering the list, so there is no point drawing a line
  // through a row nobody was looking at -- but the travel still matters: the
  // sheet closes onto a list, and the task has to be seen going to its new
  // place in it rather than having moved while the sheet was up.
  const before = measureRows();
  save().then(() => travel(before));
});

el("shDelete").addEventListener("click", () => {
  if (openIndex < 0) return;
  todos.splice(openIndex, 1);
  closeDetail();
  save();
});

el("shClose").addEventListener("click", closeDetail);
el("detail").addEventListener("click", (e) => {
  // Clicking the backdrop closes; clicking inside the card must not.
  if (e.target === el("detail")) closeDetail();
  const link = e.target.closest && e.target.closest('[data-act="open"]');
  if (link) {
    e.preventDefault();
    const url = link.getAttribute("href");
    if (url) chrome.tabs.create({ url });
  }
});

// Whether a keypress belongs to something the user is typing into. A bare "n"
// must add a task from the page and insert an N inside a field — telling those
// apart is what makes single-key shortcuts safe to have at all.
function inField(t) {
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
               t.tagName === "SELECT" || t.isContentEditable);
}

document.addEventListener("keydown", (e) => {
  // The sheet is modal: while it is open it owns the keyboard, so the page-level
  // shortcuts below must not also fire.
  if (openIndex >= 0) {
    if (e.key === "Escape") { e.preventDefault(); closeDetail(); }
    // A bare Enter in the link field saves: it is a single-line input, so
    // there is no newline for Enter to mean.
    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && e.target === el("shUrl")) {
      e.preventDefault(); el("shSave").click(); return;
    }
    // Ctrl/Cmd+Enter saves from inside the textarea, where a bare Enter has to
    // keep inserting newlines.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); el("shSave").click(); }
    return;
  }
  // Alt+Arrow reorders the focused row. Checked before the modifier guard
  // below, which exists to keep browser and OS chords out of the single-key
  // shortcuts -- this is the one chord the page does claim.
  if (e.altKey && !e.metaKey && !e.ctrlKey &&
      (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    if (nudge(e.key === "ArrowUp" ? -1 : 1)) e.preventDefault();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === "Escape") {
    if (query) { e.preventDefault(); clearSearch(); }
    else if (inField(e.target)) e.target.blur();
    return;
  }
  if (inField(e.target)) return;

  const k = e.key.toLowerCase();
  if (e.key === "/") { e.preventDefault(); el("search").focus(); el("search").select(); }
  else if (k === "n") { e.preventDefault(); el("taskInput").focus(); }
  else if (k === "t") { e.preventDefault(); goToDay(todayKey()); }
  // Day-at-a-time paging. Meaningless while search results are up, since those
  // are not a day.
  else if (e.key === "ArrowLeft" && !query) { e.preventDefault(); goToDay(shiftKey(viewKey, -1)); }
  else if (e.key === "ArrowRight" && !query) { e.preventDefault(); goToDay(shiftKey(viewKey, 1)); }
});

// ---------- load ----------
// The popup writes the same key, so a change made there while this tab is open
// has to land here too — two views of one list that disagree is worse than one
// view. Skipped while the sheet is open, so a background write can't yank the
// task out from under an edit in progress.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.todos) return;
  todos = normalize(changes.todos.newValue);
  if (openIndex < 0) render();
});

(async function load() {
  const d = await chrome.storage.local.get("todos");
  todos = normalize(d.todos);
  const t = new Date();
  calMonth = new Date(t.getFullYear(), t.getMonth(), 1);
  // A day can be linked to directly (?d=YYYY-MM-DD) so the popup can hand this
  // page the day it was looking at rather than dropping you on today.
  const want = new URLSearchParams(location.search).get("d");
  if (want && /^\d{4}-\d{2}-\d{2}$/.test(want)) {
    viewKey = want;
    const w = dateOfKey(want);
    calMonth = new Date(w.getFullYear(), w.getMonth(), 1);
  }
  render();
})();
