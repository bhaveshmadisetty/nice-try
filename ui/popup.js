// popup.js — daily cockpit: checkbox to-dos, AI status, scoreboard, test lock.

const el = id => document.getElementById(id);

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
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

// ---------- dates ----------
// Every task is stamped with the day it was written for. Without that, the
// list was permanent and the "Today's focus" heading was simply untrue —
// last week's tasks sat there wearing today's label.
function keyOf(d) {
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
function dateOfKey(k) {
  const p = String(k || "").split("-");
  return new Date(+p[0], +p[1] - 1, +p[2]);
}
// Whole days between two keys. Built from local Date objects rather than
// millisecond arithmetic so a DST shift can't round a day to 0 or 2.
function daysBetween(aKey, bKey) {
  const a = dateOfKey(aKey), b = dateOfKey(bKey);
  return Math.round((b - a) / 86400000);
}
const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];
const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

// The day being looked at. Starts on the real today and is the ONLY thing the
// calendar changes — the wall and the classifier always read the real date.
let viewKey = todayKey();

// ---------- to-dos ----------
// A task may carry a link. That ONE page is exempt from scanning — not the
// site it lives on. A DSA video does not hand over the rest of YouTube. The
// exemption lives with the task: remove the task and it's gone.
let todos = [];   // [{text, done, date, doneDate?, url?, host?}]

// Fallback day for a finished, undated legacy task when nothing better can be
// worked out: yesterday. Finished, and not today — the least wrong claim
// available. Computed once per load, then persisted, so it can't drift forward.
const LEGACY_DONE_KEY = (function () {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return keyOf(d);
})();

// Best guess at when a legacy task was actually being worked on, recovered from
// the time log. A task carrying a link names a host, and the log already records
// which pages were visited on which day — so the EARLIEST day that host shows up
// is when this task was live. That beats guessing "yesterday" for something that
// has really been sitting there for a week.
//
// Only days at or before today count: a clock that was set wrong could have
// written a future day, and filing a finished task in the future would park it
// on the calendar ahead of you.
function guessLegacyDay(task, log) {
  if (!task || !task.host || !log) return "";
  const today = todayKey();
  let best = "";
  for (const day in log) {
    if (day > today) continue;
    if (best && day >= best) continue;      // already have an earlier one
    const sites = (log[day] && log[day].sites) || {};
    for (const label in sites) {
      const e = sites[label];
      const u = e && typeof e === "object" ? e.u : "";
      if (u && hostOfUrl(u) === task.host) { best = day; break; }
    }
  }
  return best;
}

// accepts legacy plain-string todos too
function normalizeTodos(raw, log) {
  return (raw || [])
    .map(t => (typeof t === "string" ? { text: t, done: false } : t))
    .filter(t => t && t.text)
    // Tasks written before dates existed get one, so they land somewhere real.
    //
    // An OPEN one is adopted into today — otherwise upgrading the extension
    // would silently empty a list someone was relying on. A DONE one must NOT
    // be, or work finished last week reappears as today's only task and, being
    // re-stamped on every load, never leaves. It's already closed, so it goes
    // to the archive: dated, out of today's view, still in the record.
    .map(t => {
      if (t.date) return repairMisdated(t, log);
      if (!t.done) return Object.assign({}, t, { date: todayKey() });
      const stamp = guessLegacyDay(t, log) || LEGACY_DONE_KEY;
      return Object.assign({}, t, { date: stamp, doneDate: stamp });
    })
    // Ranks: the manual priority order, added here because this is where the
    // list is repaired and written back. Array position is insertion order for
    // every task written before ranks existed, so reading it off is the whole
    // migration -- the list you had is the list you get, oldest first.
    //
    // The board writes ranks too; this only fills in the ones that have none.
    // Spaced by RANK_GAP so a task can be dropped between two others there
    // without renumbering anything else.
    .map((t, i) => (typeof t.rank === "number" && isFinite(t.rank))
      ? t
      : Object.assign({}, t, { rank: (i + 1) * RANK_GAP }));
}

// Matches the board's constant. Wide enough that repeatedly dropping a row
// between the same two neighbours stays whole-numbered far longer than any real
// list needs, and nowhere near a float limit.
const RANK_GAP = 1024;

// An earlier build stamped EVERY undated task with today, including finished
// ones. Those tasks now carry a date, so the migration above rightly leaves
// them alone — and a task finished last week is stuck on today permanently.
//
// This repairs that specific mistake and nothing else. It only touches a task
// that is done, dated today, and whose link was last actually used on an
// earlier day. A task genuinely finished today has no earlier evidence in the
// log, so it stays exactly where it is.
// Runs ONCE, guarded by a flag in storage. guessLegacyDay returns the earliest
// day a host was ever used, which is the right answer for a task of unknown age
// and the wrong one for a task genuinely finished today on a site visited for
// months. Repeating this pass would keep dragging fresh work into the past, so
// it fires only while repairDone is unset.
let needsRepair = false;
function repairMisdated(t, log) {
  if (!needsRepair) return t;
  if (!t.done || t.date !== todayKey()) return t;
  if (t.doneDate && t.doneDate !== todayKey()) return t;   // already filed properly
  const real = guessLegacyDay(t, log);
  if (!real || real === todayKey()) return t;
  return Object.assign({}, t, { date: real, doneDate: real });
}

// A rank of 0 is a real position (dragged to the very top), so it cannot be
// tested for truthiness -- `rank || 0` would read it as "unranked" and, worse,
// would read a genuinely unranked task as sitting at the top. Anything without
// a usable number sorts to the END, behind everything deliberately placed.
function rankOf(t) {
  return (typeof t.rank === "number" && isFinite(t.rank)) ? t.rank : Infinity;
}

// Which tasks belong on the day being viewed.
//
// Unfinished work carries forward: a task written on the 12th and still open
// shows up every day after it until it's ticked. So "today" means every open
// task dated today or earlier — and the row says how long it's been dragging.
// A finished task stops travelling and stays on the day it was completed, so
// scrolling back shows what that day actually held.
function tasksFor(key) {
  const out = [];
  todos.forEach((t, i) => {
    const item = { t, i, overdue: 0 };
    if (t.done) {
      // doneDate is missing on tasks ticked before this build — fall back to
      // the day they were written for.
      if ((t.doneDate || t.date) === key) out.push(item);
    } else if (t.date === key) {
      out.push(item);
    } else if (t.date < key && key === todayKey()) {
      // Overdue work lands on TODAY and nowhere else. It is not yet owed on a
      // future day — that day hasn't happened, and showing it there would put
      // the same task on every remaining square of the calendar.
      item.overdue = daysBetween(t.date, key);
      out.push(item);
    }
  });
  // Done sinks -- ticking something drops it to the bottom. Above that line the
  // order is the one SET on the board: rank ascending, first added first read.
  //
  // Age used to rule here, floating the oldest debt to the top. That is a good
  // default and a bad law, so it is now only the tiebreaker: it still separates
  // two tasks nothing has ever been said about (they carry their insertion
  // ranks, which is the same answer for a list nobody has reordered), and stops
  // arguing the moment one is moved by hand. The board is the surface that
  // moves them; this is the same list, so it must read the same order.
  return out.sort((a, b) =>
    (a.t.done ? 1 : 0) - (b.t.done ? 1 : 0) ||
    rankOf(a.t) - rankOf(b.t) ||
    b.overdue - a.overdue);
}

// ---------- motion ----------
// One reveal/conceal for every panel that comes and goes. Toggling `hidden`
// directly snaps the popup to a new height and everything below it jumps.
// This animates height, padding, gap and opacity together on the critically
// damped spring, so the panels below slide as the one above them grows.
//
// Interruptible on purpose: a panel closed halfway through opening reverses
// from where it IS, not from where it was going — the current animated values
// are read off computed style before the running animation is cancelled.
//
// Springs, not keyframes, because the durations are tied to the curve: the
// linear() easing in the CSS tokens is only shaped right at its own settle
// time, so both are read from the stylesheet rather than restated here.
const show = (() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  let booted = false;
  let curve = null;
  const running = new WeakMap();
  function tokens() {
    if (curve) return curve;
    const cs = getComputedStyle(document.documentElement);
    const t = (n, d) => (parseFloat(cs.getPropertyValue(n)) || d) * 1000;
    curve = {
      spring: cs.getPropertyValue("--spring").trim() || "ease-out",
      springT: t("--spring-t", .6),
      ease: cs.getPropertyValue("--ease").trim() || "ease-out",
      easeT: t("--dur-mid", .28)
    };
    return curve;
  }
  // The animated (or resting) box, in px.
  function box(el) {
    const cs = getComputedStyle(el);
    return {
      h: el.getBoundingClientRect().height,
      pt: parseFloat(cs.paddingTop) || 0, pb: parseFloat(cs.paddingBottom) || 0,
      mb: parseFloat(cs.marginBottom) || 0, o: parseFloat(cs.opacity)
    };
  }
  // A collapsed panel must also swallow the flex gap its parent would leave
  // around it, or a zero-height card still holds a gap's worth of space.
  function gapOf(el) {
    const p = el.parentElement;
    return p ? (parseFloat(getComputedStyle(p).rowGap) || 0) : 0;
  }
  function settle(el) {
    const r = running.get(el);
    if (r) { running.delete(el); r.cancel(); }
    el.style.overflow = "";
    el.style.pointerEvents = "";
    delete el.dataset.leaving;
  }
  function run(el, a, b, out) {
    const c = tokens();
    el.style.overflow = "hidden";
    const lift = "translateY(-6px) scale(.985)";
    const anim = el.animate([
      { height: a.h + "px", paddingTop: a.pt + "px", paddingBottom: a.pb + "px",
        marginBottom: a.mb + "px", opacity: a.o, transform: (out || a.h > 0.5) ? "none" : lift },
      { height: b.h + "px", paddingTop: b.pt + "px", paddingBottom: b.pb + "px",
        marginBottom: b.mb + "px", opacity: b.o, transform: out ? lift : "none" }
    ], { duration: out ? c.easeT : c.springT, easing: out ? c.ease : c.spring, fill: "both" });
    running.set(el, anim);
    return anim.finished.then(() => {
      if (running.get(el) !== anim) return false;   // superseded
      if (out) el.hidden = true;
      settle(el);
      return true;
    }, () => false);
  }
  // show(el, on): resolves true once the panel is at rest in that state, false
  // if another call took over first.
  function show(el, on) {
    if (!el) return Promise.resolve(false);
    on = !!on;
    const leaving = el.dataset.leaving === "1";
    const visible = !el.hidden && !leaving;
    if (on === visible) return Promise.resolve(true);
    if (!booted || reduce.matches) { settle(el); el.hidden = !on; return Promise.resolve(true); }
    const from = el.hidden ? null : box(el);   // read BEFORE cancelling
    settle(el);
    const gap = gapOf(el);
    const closed = { h: 0, pt: 0, pb: 0, mb: -gap, o: 0 };
    if (on) {
      el.hidden = false;
      const nat = box(el);
      return run(el, from || closed, nat, false);
    }
    el.dataset.leaving = "1";
    el.style.pointerEvents = "none";
    return run(el, from || box(el), closed, true);
  }
  // Nothing animates until the first paint has settled: the popup opening on a
  // dozen panels sliding into place would be the thing this exists to prevent.
  show.boot = () => { booted = true; document.body.classList.add("booted"); };
  return show;
})();

async function saveTodos() {
  await chrome.storage.local.set({ todos });
  // Checklist first: the "add a task" step tracks the real list, and the empty
  // task card reads setupVisible to decide how much to explain. Rendering the
  // list first would paint it against the previous state.
  await refreshSetup();
  renderTodos();
}

// pull the first http(s) URL out of typed text, so "revise DP https://…" works
function extractUrl(s) {
  const m = String(s || "").match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : "";
}
function hostOfUrl(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch (e) { return ""; }
}
// A hostname someone could actually have typed: labels of letters, digits and
// hyphens, at least one dot, nothing percent-encoded. `localhost` is allowed
// for anyone building the thing they are trying to focus on.
function looksLikeHost(h) {
  return h === "localhost" || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(h || "");
}

// Human name for the day in the header: relative while it's close enough to
// mean something, absolute once "in 9 days" stops being a useful anchor.
function dayLabel(key) {
  const n = daysBetween(todayKey(), key);
  if (n === 0) return "Today's focus";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  const d = dateOfKey(key);
  const base = DOW[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()].slice(0, 3);
  // Beyond a week the weekday alone is ambiguous, so the date carries it.
  return Math.abs(n) < 7 ? base : base + " " + d.getFullYear();
}

function renderTodos() {
  const list = el("todoList");
  const rows = tasksFor(viewKey);
  const done = rows.filter(r => r.t.done).length;
  el("todoCount").textContent = rows.length ? done + " / " + rows.length + " done" : "";
  el("dayLabel").textContent = dayLabel(viewKey);
  // The single choke point every task/day change already runs through, so the
  // prompt can never be left showing next to a list that now has something in
  // it. Called before the list is written, because the empty-state copy below
  // checks whether this bar is already making the same ask.
  refreshDayPrompt();
  // Only offer the way back when there's somewhere to come back from.
  el("todayBtn").hidden = viewKey === todayKey();

  // No tasks: let the box shrink to its message instead of holding four empty
  // rows open. The fixed height exists to stop the popup jumping as tasks are
  // added or removed, which is not a concern when there are none.
  list.classList.toggle("is-empty", !rows.length);

  if (!rows.length) {
    // This branch returns before the syncListFade() at the end of the function,
    // so the scroll flag is cleared here — otherwise an at-end left over from
    // the previous render survives into a state that has nothing to scroll.
    // Harmless today only because is-empty also drops the mask; two classes
    // making opposite claims, kept safe by a CSS rule elsewhere, is how the
    // next edit to that rule turns into a bug.
    list.classList.remove("at-end");
    const n = daysBetween(todayKey(), viewKey);
    if (n < 0) {
      list.innerHTML = '<p class="empty">Nothing was set for this day.</p>';
    } else if (n > 0) {
      list.innerHTML = '<p class="empty">Nothing planned yet for ' + esc(dayLabel(viewKey).toLowerCase()) +
        '. Anything you add here waits until that day arrives.</p>';
    } else {
      // Three different cards can be asking for a task at once — the setup
      // checklist, the daily prompt bar directly above this list, and this
      // empty state. Whichever of the other two is showing has already made
      // the ask, so this drops to the one thing neither of them says: what a
      // link in a task actually does.
      const askedAbove = setupVisible || !el("dayPrompt").hidden;
      list.innerHTML = askedAbove
        ? '<p class="empty">Paste a link into a task and that exact page won\'t be scanned. The rest of the site still is.</p>'
        : '<p class="empty">Nothing set yet. Add what you actually need to do today — the lock screen shows these when you drift.<br><br>Paste a link into a task and that exact page won\'t be scanned. The rest of the site still is.</p>';
    }
    return;
  }
  list.innerHTML = rows.map(({ t, i, overdue }) => {
    // A real anchor, so it can be opened, focused and middle-clicked like any
    // link. Naming the page rather than the host, because "youtube.com" would
    // read as if the whole site were exempt — which is what this doesn't do.
    // Whether this link is actually exempting anything right now. The worker
    // grants the exemption only for a task that is live: not ticked off, and
    // not dated in the future (see taskLinkIdentities in background.js —
    // these two conditions must stay in step with it). Until this said so,
    // a link planned for Saturday looked identical to one working today and
    // hit the wall with no explanation, which read as the tool being flaky.
    const dormant = t.done || (t.date && t.date > todayKey());
    const note = t.done
      ? "· done, so it's walled again"
      : (t.date && t.date > todayKey())
        ? "· opens on " + esc(dayLabel(t.date).toLowerCase())
        // A task written from a countdown says so. The link works identically
        // either way — it exempts this page while the task is open — but which
        // half of the list was planned and which was reconstructed on the way
        // to a wall is worth being able to see at a glance.
        : (t.late ? "· added from a block" : "· open, nothing else");
    const sub = t.host
      ? '<a class="todo-sub' + (dormant ? " is-dormant" : "") + '" href="' + esc(t.url || "") + '" data-act="open" ' +
        'title="' + esc(t.url || "") + '" rel="noreferrer noopener">' +
          '<span class="lk-ico" aria-hidden="true">' + (dormant ? "⊘" : "↗") + '</span>' +
          '<span class="lk-tx">' + esc(t.host) + '</span>' +
          '<span class="lk-note">' + note + '</span>' +
        '</a>'
      // `from` is the older shape: tasks captured by the removed post-wall
      // screen recorded where they came from WITHOUT exempting it, so they are
      // still rendered as plain text rather than a link. Kept so those tasks
      // keep reading correctly; nothing writes `from` any more.
      : (t.from
          ? '<span class="todo-sub is-note" title="' + esc(t.from) + '">' +
              '<span class="lk-ico" aria-hidden="true">✎</span>' +
              '<span class="lk-tx">' + (t.late ? "added late, from " : "noted while leaving ") +
                esc(hostOfUrl(t.from) || "a site") + '</span>' +
            '</span>'
          : "");
    // Say how long it's been dragging. A task you keep pushing should get
    // harder to look at, not blend in with work you set this morning — that
    // number is the whole point of carrying it forward instead of hiding it.
    // Short enough to be a pill. The long second-person sentence was written
    // when this was a full line of body copy; at that length it wrapped to two
    // lines and pushed the task it describes out of view. The sting is in the
    // number, and the number survives — the title carries the full sentence
    // for anyone who wants it.
    const age = overdue
      ? '<span class="age' + (overdue >= 3 ? " hot" : "") + '" title="' +
        (overdue === 1 ? "Moved once, from yesterday"
                       : "You've moved this " + overdue + " days running") +
        ". Written for " +
        esc(dateOfKey(t.date).getDate() + " " + MONTHS[dateOfKey(t.date).getMonth()]) + '">' +
        (overdue === 1 ? "moved once" : "moved " + overdue + "×") +
        '</span>'
      : "";
    // The row being edited swaps its text and link for two fields. The box is
    // kept for alignment but carries no action: ticking mid-edit would
    // re-render the row and throw the typing away.
    if (i === editIndex) {
      return '<div class="todo is-editing' + (t.done ? " done" : "") + '" data-i="' + i + '">' +
        '<span class="box" aria-hidden="true"></span>' +
        '<span class="body">' +
          '<input class="ed-text" type="text" maxlength="300" value="' + esc(t.text) + '" ' +
            'aria-label="Task text" placeholder="What needs doing">' +
          '<input class="ed-url" type="text" value="' + esc(t.url || "") + '" ' +
            'aria-label="Link" spellcheck="false" ' +
            'placeholder="Link — that page won\'t be walled while this is open">' +
          '<span class="ed-acts">' +
            '<button class="ed-save" data-act="save" type="button">Save</button>' +
            '<button class="ed-cancel" data-act="cancel" type="button">Cancel</button>' +
          '</span>' +
        '</span>' +
      '</div>';
    }
    return '<div class="todo' + (t.done ? " done" : "") + '" data-i="' + i + '">' +
      '<span class="box" data-act="toggle"></span>' +
      '<span class="body">' +
        // The row clamps to two lines, so a long task is unreadable here by
        // design. Clicking the text opens it on the full board rather than
        // ticking it — the checkbox is right there for that, and "I clicked to
        // read it and it marked itself done" is the worse of the two mistakes.
        '<span class="txt" data-act="detail" title="' + esc(t.text) + '">' +
          esc(t.text) + '</span>' + age + sub +
      '</span>' +
      '<button class="edit" data-act="edit" title="Edit task or link">✎</button>' +
      '<button class="del" data-act="del" title="Remove">×</button>' +
    '</div>';
  }).join("");
  if (newTodoIndex >= 0) {
    const fresh = list.querySelector('.todo[data-i="' + newTodoIndex + '"]');
    if (fresh) fresh.classList.add("is-new");
    newTodoIndex = -1;
  }
  // The edit fields exist only after this paint, so focus lands here. Caret
  // at the end: the common edit is appending, not retyping.
  const ed = list.querySelector(".todo.is-editing .ed-text");
  if (ed) {
    ed.focus({ preventScroll: true });
    try { ed.setSelectionRange(ed.value.length, ed.value.length); } catch (e) {}
    ed.closest(".todo").scrollIntoView({ block: "nearest" });
  }
  // After the rows exist, not before — it measures them.
  syncListFade();
}

// ---------- inline edit ----------
// The row is the record, so the row is where it gets corrected: a typo, a
// task that grew, a link pasted wrong. The board's sheet does this too; the
// popup should not need a new tab for a one-word change.
let editIndex = -1;

// Reads the two fields back into the task. Returns false and marks the field
// when the input cannot be saved, so the row stays open for another go rather
// than quietly dropping what was typed.
function saveEdit(i) {
  const row = el("todoList").querySelector('.todo.is-editing[data-i="' + i + '"]');
  const t = todos[i];
  if (!row || !t) { editIndex = -1; renderTodos(); return false; }
  const textEl = row.querySelector(".ed-text");
  const urlEl = row.querySelector(".ed-url");
  let text = (textEl.value || "").trim();
  let url = (urlEl.value || "").trim();
  textEl.classList.remove("bad"); urlEl.classList.remove("bad");

  // A link pasted into the text field is lifted out into the link field, the
  // same way the add row does it — editing must not be a way to end up with a
  // task the wall reads differently from one typed in the first place. Only
  // when the link field is empty: a link deliberately put there wins.
  const inText = extractUrl(text);
  if (inText && !url) {
    url = inText;
    text = text.replace(inText, "").trim().replace(/[-–—:]\s*$/, "").trim();
  }
  // "leetcode.com/problems/x" is a link to anyone reading it; the scheme is
  // the one part nobody types.
  if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
  const host = url ? hostOfUrl(url) : "";
  // hostOfUrl alone is not the test: Chrome's URL parser lets "https://not a
  // link" through with the spaces percent-encoded into the host, so a
  // sentence typed into the field would be saved as a link to nowhere. A
  // host has to look like one.
  if (url && (!looksLikeHost(host) || !/^https?:/i.test(url))) {
    urlEl.classList.add("bad"); urlEl.focus();
    return false;
  }
  // An empty task is not saved and not deleted: the × next to the row is the
  // delete, and Enter on a field you just cleared should not be a second one.
  if (!text && !host) { textEl.classList.add("bad"); textEl.focus(); return false; }

  t.text = text || host;
  if (host) {
    if (t.url !== url) {
      t.url = url; t.host = host;
      // Same message the add row sends: the worker clears its streak so a tab
      // already sitting on the newly linked page stops being walled.
      chrome.runtime.sendMessage({ type: "taskLinkAdded" });
    }
  } else {
    // Clearing the field removes the exemption with it — the exemption is
    // derived from the list, so this is the whole change.
    delete t.url; delete t.host;
  }
  editIndex = -1;
  saveTodos();
  return true;
}

function cancelEdit() {
  if (editIndex < 0) return;
  editIndex = -1;
  renderTodos();
}

// Enter saves, Escape cancels — from either field. Delegated, because the
// fields are rebuilt on every render.
el("todoList").addEventListener("keydown", (e) => {
  const row = e.target.closest && e.target.closest(".todo.is-editing");
  if (!row) return;
  if (e.key === "Enter") { e.preventDefault(); saveEdit(+row.dataset.i); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
});

// The bottom fade means "there is more below", so it has to stop meaning it at
// the bottom, where it would just be dimming the last task for no reason.
// Also clears itself when the list is short enough not to scroll at all.
function syncListFade() {
  const list = el("todoList");
  if (!list) return;
  const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight <= 4;
  list.classList.toggle("at-end", atEnd);
}
el("todoList").addEventListener("scroll", syncListFade, { passive: true });

// one delegated listener for the whole list
el("todoList").addEventListener("click", (e) => {
  // Open the link in a tab ourselves. A plain anchor inside a popup navigates
  // the popup itself, which just closes it — the link would appear broken.
  const link = e.target.closest && e.target.closest('[data-act="open"]');
  if (link) {
    e.preventDefault();
    const url = link.getAttribute("href");
    if (url) chrome.tabs.create({ url });
    window.close();
    return;
  }
  const act = e.target.dataset.act;
  if (!act) return;
  const i = +e.target.closest(".todo").dataset.i;
  if (act === "edit") {
    // One row at a time. Opening a second discards the first's typing, which
    // is the same thing Cancel does, so there is nothing to ask about.
    editIndex = i;
    renderTodos();
    return;
  }
  if (act === "save") { saveEdit(i); return; }
  if (act === "cancel") { cancelEdit(); return; }
  if (act === "detail") {
    // The board opens on the day this row belongs to, not the day being viewed:
    // carried-over work is shown on today while still being dated to the day it
    // was written for, and it has to be findable where it actually lives.
    const t = todos[i];
    openTaskBoard((t && (t.done ? (t.doneDate || t.date) : t.date)) || viewKey);
    return;
  }
  if (act === "toggle") {
    todos[i].done = !todos[i].done;
    // Completing a task pins it to the day it was actually finished, so it
    // stops travelling and the record of that day stays true. Un-ticking
    // releases it again.
    if (todos[i].done) todos[i].doneDate = viewKey;
    else delete todos[i].doneDate;
  } else if (act === "del") {
    // Deleting the task removes its exemption with it — the exemption is
    // derived from this list, so nothing else needs cleaning up.
    // The row folds shut first; the list is rewritten only once it has gone,
    // so the rows below slide up to fill the space rather than jumping.
    const row = e.target.closest(".todo");
    show(row, false).then(() => {
      todos.splice(i, 1);
      saveTodos();
    });
    return;
  }
  saveTodos();
});

// A new task goes to the BOTTOM of the day it was written for: first in, first
// up. Ranked past what is already on that day rather than past all of storage,
// so days stay independent and a busy Monday can't push Tuesday's first task
// into the hundreds.
function nextRank(key) {
  let max = 0;
  todos.forEach(t => {
    const on = t.done ? (t.doneDate || t.date) : t.date;
    if (on === key && typeof t.rank === "number" && t.rank > max) max = t.rank;
  });
  return max + RANK_GAP;
}

function addTodo() {
  const raw = el("todoInput").value.trim();
  if (!raw) return;
  const url = extractUrl(raw);
  const host = hostOfUrl(url);
  // keep the link out of the visible task text — it's shown on its own line
  const text = url ? raw.replace(url, "").trim().replace(/[-–—:]\s*$/, "").trim() : raw;
  // Stamped with the day being viewed, so planning tomorrow puts the task on
  // tomorrow rather than dumping it into today's list.
  const item = { text: text || host || raw, done: false, date: viewKey,
                 rank: nextRank(viewKey) };
  if (url && host) {
    item.url = url; item.host = host;
    chrome.runtime.sendMessage({ type: "taskLinkAdded" });
  }
  todos.push(item);
  newTodoIndex = todos.length - 1;
  el("todoInput").value = "";
  saveTodos();
}
// Index of the task added a moment ago, so renderTodos can settle just that
// row in rather than the whole list. Cleared on the render that consumes it.
let newTodoIndex = -1;
el("addBtn").addEventListener("click", addTodo);
el("todoInput").addEventListener("keydown", e => { if (e.key === "Enter") addTodo(); });

// ---------- this tab ----------
// The page the popup was opened over, offered as a task in one press. The
// popup only reads the tab to DECIDE WHETHER TO SHOW the chip and what host to
// print on it; the write goes through the worker (taskFromTab), which reads
// the tab again itself and prices the task by what it was doing to that page
// — free if nothing, the countdown's charge if the strip was already up,
// refused if the wall is. The popup never gets to say a link was free.
let chipTab = null;
function loadTabChip() {
  const chip = el("tabChip");
  if (!chip) return;
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs && tabs[0];
      const url = tab && tab.url;
      if (chrome.runtime.lastError || !url || !/^https?:/i.test(url)) { show(chip, false); return; }
      chipTab = { url, title: tab.title || "" };
      renderTabChip();
    });
  } catch (e) { show(chip, false); }
}
function renderTabChip() {
  const chip = el("tabChip");
  if (!chip || !chipTab) return;
  const host = hostOfUrl(chipTab.url);
  if (!host) { show(chip, false); return; }
  // Already linked to a live task: say so instead of offering it again. The
  // worker matches on page identity (so &t= does not fool it); this is only
  // the label, and an exact match is enough to catch the common case.
  const t0 = todayKey();
  const linked = todos.find(t => t && !t.done && t.url === chipTab.url && (!t.date || t.date <= t0));
  chip.querySelector(".tc-tx").textContent = linked ? "This tab is on your list" : "Add this tab";
  el("tabChipHost").textContent = "· " + host;
  chip.title = linked ? (linked.text || "") : (chipTab.title || chipTab.url);
  chip.disabled = !!linked;
  show(chip, true);
}
function tabMsg(text, bad) {
  const m = el("tabMsg");
  if (!m) return;
  m.textContent = text || "";
  m.classList.toggle("bad", !!bad);
  show(m, !!text);
}
el("tabChip").addEventListener("click", () => {
  const chip = el("tabChip");
  if (chip.disabled) return;
  chip.disabled = true;
  tabMsg("");
  // Filed on the day being viewed, like a typed task. A page for Saturday is
  // exempt from Saturday; the worker says so if it was under a countdown now.
  chrome.runtime.sendMessage({ type: "taskFromTab", date: viewKey }, async resp => {
    chip.disabled = false;
    if (chrome.runtime.lastError || !resp) { tabMsg("Couldn't reach the worker — reload and retry.", true); return; }
    if (!resp.ok) {
      if (resp.reason === "walled") tabMsg("This page is walled. The wall has its own door for this.", true);
      else if (resp.reason === "exists") tabMsg("Already on your list: " + (resp.text || "this page") + ".");
      else if (resp.reason === "nopage") { show(chip, false); }
      else tabMsg("Couldn't add it.", true);
      return;
    }
    // The worker wrote the list; read it back rather than guessing at the
    // shape it chose, then settle just the new row in.
    const d = await readState(["todos", "log"]);
    todos = normalizeTodos(d.todos, d.log);
    newTodoIndex = Number.isInteger(resp.index) ? resp.index : -1;
    await refreshSetup();
    renderTodos();
    renderTabChip();
    if (resp.charge && resp.charge.price) {
      const c = resp.charge;
      tabMsg("Added, " + c.price + " coin" + (c.price === 1 ? "" : "s") +
        " — you were already being warned on this page." +
        (c.debt ? " Couldn't cover " + c.debt + "." : "") +
        (resp.reprieved ? "" : " It stays walled until " + dayLabel(resp.date).toLowerCase() + "."));
      loadWallet();
    } else if (resp.date && resp.date !== todayKey()) {
      tabMsg("Added for " + dayLabel(resp.date).toLowerCase() + ". The page is exempt from then.");
    } else {
      tabMsg("Added. This page won't be walled while the task is open.");
    }
  });
});

// ---------- calendar ----------
// A month grid in the iOS shape: weekday header, days starting on the correct
// column, the selected day filled and today ringed. It's collapsed by default —
// the popup's job is still today, and the calendar is for when you need to look
// away from it.
let calMonth = null;   // Date pinned to the 1st of the displayed month

function openCal(on) {
  const wrap = el("calWrap");
  const open = on === undefined ? (wrap.hidden || wrap.dataset.leaving === "1") : on;
  show(wrap, open);
  el("calBtn").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    const v = dateOfKey(viewKey);
    calMonth = new Date(v.getFullYear(), v.getMonth(), 1);
    renderCal();
  }
}

// How many open tasks were WRITTEN for a given day — drives the dot under each
// date, so the month shows where you planned work without opening every day.
// Deliberately not tasksFor(): carried-over debt is shown on today's row with
// its age, and counting it here would mark today for work that belongs to the
// day it was actually set.
function countFor(key) {
  return todos.filter(t => !t.done && t.date === key).length;
}

function renderCal() {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  el("calTitle").textContent = MONTHS[m] + " " + y;

  const first = new Date(y, m, 1).getDay();          // 0=Sun, matches DOW
  const days = new Date(y, m + 1, 0).getDate();      // day 0 of next month
  const tKey = todayKey();

  let cells = "";
  // Leading blanks so the 1st sits under its real weekday.
  for (let i = 0; i < first; i++) cells += '<span class="cal-pad"></span>';
  for (let d = 1; d <= days; d++) {
    const key = keyOf(new Date(y, m, d));
    const n = countFor(key);
    const cls = ["cal-day"];
    if (key === viewKey) cls.push("sel");
    if (key === tKey) cls.push("today");
    if (key > tKey) cls.push("future");
    cells += '<button type="button" class="' + cls.join(" ") + '" data-key="' + key + '"' +
      (key === viewKey ? ' aria-current="date"' : '') +
      ' aria-label="' + d + " " + MONTHS[m] + " " + y + (n ? ", " + n + " open" : "") + '">' +
      d + (n ? '<i class="pip' + (n > 2 ? " many" : "") + '"></i>' : "") +
      '</button>';
  }
  el("calGrid").innerHTML = cells;
}

function shiftMonth(n) {
  calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + n, 1);
  renderCal();
}

el("calBtn").addEventListener("click", () => openCal());
el("calPrev").addEventListener("click", () => shiftMonth(-1));
el("calNext").addEventListener("click", () => shiftMonth(1));

el("calGrid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-key]");
  if (!b) return;
  viewKey = b.dataset.key;
  renderTodos();
  renderCal();
});

// Jump back to the real today from anywhere, and close the calendar with it —
// the point of the button is to end the detour, not to leave you mid-browse.
el("todayBtn").addEventListener("click", () => {
  viewKey = todayKey();
  renderTodos();
  openCal(false);
});

// Escape closes the calendar rather than the whole popup.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("calWrap").hidden) { e.preventDefault(); openCal(false); }
});

// ---------- AI status ----------
// Working infrastructure should be SILENT. "AI active via Groq" is true, and
// it is also a permanent full-width row telling you that nothing is wrong —
// which is the least useful thing a small popup can spend a slot on. It said
// the same sentence every day forever, so people stopped reading the row, and
// then it couldn't warn them either.
//
// So: shown only when something is actually broken or missing, with the action
// that fixes it. When the AI is healthy this renders nothing at all. Checking
// on it deliberately is what the button in Settings is for.
function renderAi(resp) {
  const box = el("aiStatus"), msg = el("aiMsg");
  box.className = "ai";
  const noKey = !resp || resp.state === "nokey";

  if (resp && resp.state === "ok") { box.hidden = true; return; }

  // No key is not a fault — the tool still works on keywords — so it is only
  // worth a row once setup is finished and this is genuinely the last thing
  // left to turn on.
  box.hidden = setupVisible && noKey;
  // A real <button>, not a <span> — it must be reachable and activatable by
  // keyboard, which a span with a click handler never is.
  if (noKey) {
    msg.textContent = "Keyword matching only — add a key for smart judging.";
    box.insertAdjacentHTML("beforeend", '<button type="button" class="fix" id="aiFix">Add key</button>');
    el("aiFix").addEventListener("click", openSettings);
  } else {
    box.classList.add("err");
    msg.textContent = "AI failed: " + (resp.err || "unknown");
    box.insertAdjacentHTML("beforeend", '<button type="button" class="fix" id="aiFix">Fix</button>');
    el("aiFix").addEventListener("click", openSettings);
  }
}

function checkAi() {
  chrome.runtime.sendMessage({ type: "aiStatus" }, resp => {
    if (chrome.runtime.lastError) { renderAi({ state:"error", err:"worker asleep — reload" }); return; }
    renderAi(resp);
  });
}

// ---------- scoreboard ----------
function renderScore(log) {
  const day = log[todayKey()] || { productive:0, junk:0, neutral:0 };
  const total = day.productive + day.junk + day.neutral || 1;
  el("barP").style.width = (day.productive / total * 100) + "%";
  el("barJ").style.width = (day.junk / total * 100) + "%";
  el("barN").style.width = (day.neutral / total * 100) + "%";
  el("pMin").textContent = fmt(day.productive);
  el("jMin").textContent = fmt(day.junk);

  const active = day.productive + day.junk;
  el("scorePct").textContent = active > 30 ? Math.round(day.productive / active * 100) + "% focused" : "";

  const v = el("verdict");
  const w = Math.round(day.productive/60), x = Math.round(day.junk/60);
  v.className = "verdict";
  if (active < 60) v.textContent = "Barely any tracked time yet. Keep going.";
  else if (day.junk > day.productive) { v.classList.add("bad"); v.textContent = "Wasted more than you worked — " + x + "m vs " + w + "m. That's the honest number."; }
  else { v.classList.add("good"); v.textContent = w + "m focused vs " + x + "m wasted. You're ahead. Don't cave tonight."; }

  // Saved minutes are credited per walk-away, so they are already minutes and
  // must not go through fmt(), which expects seconds.
  const savedLine = el("savedLine");
  const savedMin = day.saved || 0;
  // Feed the header, so the top line reports a result rather than a status.
  savedTodayMins = savedMin;
  if (el("enabled").checked) setStatus(true);
  if (savedMin) {
    const n = day.blocks || 0;
    const hrs = savedMin >= 60
      ? Math.floor(savedMin / 60) + "h " + (savedMin % 60) + "m"
      : savedMin + "m";
    savedLine.innerHTML = "Saved <b>" + hrs + "</b> by walking away " + n +
      (n === 1 ? " time." : " times.");
    savedLine.hidden = false;
  } else {
    savedLine.hidden = true;
  }

  const sites = day.sites || {};
  // entries are {s,u,c} now; older days stored a bare seconds number
  const secsOf = v => (typeof v === "number" ? v : (v && v.s) || 0);
  // Which side a row falls on. logTime already splits every row's seconds by
  // category — the list used to discard that and print one undifferentiated
  // grey column, so a lecture and a MrBeast video looked identical and the
  // breakdown answered "where did it go" without ever answering "was that ok".
  // A row is called by its majority: pages do move between categories in a day,
  // and the honest summary of a row that was 90% work is "work".
  const sideOf = v => {
    const c = (v && typeof v === "object" && v.c) || null;
    if (!c) return "";                       // legacy row — no claim to make
    const p = c.productive || 0, j = c.junk || 0;
    if (!p && !j) return "";                 // all neutral: idle, tabs, search
    return j > p ? "junk" : "prod";
  };
  // The browser's own furniture. These are logged like any other title, so on a
  // scattered day "New tab" wins the list outright — 13 minutes of blank tab
  // beating the work and the distractions both. It is real, and it is reported
  // below as one honest line, but it must not take one of five slots that could
  // have named something you actually did.
  const CHROME_CHROME = ["new tab", "extensions", "settings", "about:blank", "unknown"];
  const isChrome = n => CHROME_CHROME.includes(String(n).trim().toLowerCase()) ||
                        /^chrome:\/\//i.test(String(n).trim());
  const all = Object.keys(sites).map(n => ({ n, s: secsOf(sites[n]), side: sideOf(sites[n]) }));
  const blankSec = all.filter(r => isChrome(r.n)).reduce((a, r) => a + r.s, 0);
  const rows = all.filter(r => !isChrome(r.n))
    .filter(r => r.s >= 60).sort((a,b) => b.s - a.s).slice(0, 5);
  const box = el("sites");
  if (!rows.length) { box.style.display = "none"; return; }
  box.style.display = "block";
  // No "biggest leak" headline here. It was tried, and it restated a row that
  // sits three lines below it — the same 40-character title printed twice in
  // one card, in red, wrapping to two lines and shouting down the verdict
  // above it. The red rule on the row already says which one it is.
  // Time on a blank new tab is not a site you visited, it is the gap between
  // two decisions. Reported as its own footnote so the number stays honest
  // without pretending it belongs in a ranking of pages.
  const blank = blankSec >= 300
    ? '<p class="sites-blank">Plus ' + fmt(blankSec) +
      ' on a blank tab — that\'s usually deciding what to do next.</p>'
    : "";
  box.innerHTML = '<div class="lbl" style="margin-bottom:8px">Where your time went</div>' +
    rows.map(r => '<div class="site' + (r.side ? " is-" + r.side : "") + '">' +
      '<span class="n">' + esc(r.n) + '</span>' +
      '<span class="t">' + fmt(r.s) + '</span></div>').join("") + blank;
}

// ---------- setup checklist ----------
// Shown until all three are done, then gone permanently. A fresh install
// otherwise opens on an empty task list, an empty scoreboard and a warning —
// nothing that says what to actually do. Ticking the first box for them (the
// extension is already on) is deliberate: a list with progress on it gets
// finished far more often than an empty one gets explored.
// Whether the checklist is currently on screen. Other parts of the popup defer
// to it while it is — three cards explaining the same gap is noise.
let setupVisible = false;

function renderSetup(state) {
  const card = el("setupCard");
  // One-time setup only. "Add today's first task" used to live here, which was
  // a category error: the other three are done once and never again, but tasks
  // reset every midnight — so the whole setup card would reappear every morning
  // to nag about one item, long after setup was actually finished. The daily
  // task prompt is its own thing now (see renderDayPrompt).
  const steps = [
    ["stepAccess",  state.hasAccess],
    ["stepMission", state.hasMission],
    ["stepKey",     state.hasKey]
  ];
  const left = steps.filter(([, done]) => !done).length;
  setupVisible = left > 0;
  // The "no API key" pill says what the key step already says, one card apart.
  // Suppressed while the checklist is up; it comes back the moment setup is
  // finished, where it becomes real status rather than a repeated instruction.
  show(el("aiStatus"), !(setupVisible && !state.hasKey));
  if (!left) { show(card, false); return; }
  show(card, true);
  for (const [id, done] of steps) {
    el(id).dataset.done = done ? "1" : "0";
  }
  const n = steps.length - left;
  // Missing access is not "almost there" — it is the tool not running. That
  // state gets its own heading rather than being counted as one item of four.
  if (!state.hasAccess) {
    el("setupTitle").textContent = "Nice Try isn't running yet";
    el("setupLede").textContent =
      "It can't see your tabs, so nothing is being blocked or tracked. " +
      "One tap fixes it.";
  } else {
    el("setupTitle").textContent = n ? "Almost there — " + left + " left" : "Finish setting up";
    // Once the key is in, the tool is fully armed; the remaining copy shouldn't
    // keep warning about a limitation that no longer applies.
    el("setupLede").textContent = state.hasKey
      ? "Nice Try is judging your tabs properly now. These sharpen it further."
      : "Until these are done, Nice Try can only block the obvious sites — not judge what you're actually doing.";
  }
}

// Not async, and nothing awaited before the request: Chrome only honours
// permissions.request() inside a live user gesture, and an await beforehand
// ends it — the call then rejects regardless of how the promise is chained.
//
// Chrome closes the popup to show the permission prompt, so the callback often
// never runs in this document. That is fine: the worker listens for
// permissions.onAdded and re-checks itself, and the next popup open re-reads
// the real state. Nothing here depends on the callback firing.
// ---------- the daily task prompt ----------
// Separate from the setup checklist on purpose: setup is finished once, this
// question comes back every morning. Shown when today has no open tasks, gone
// the instant one is added, and dismissable for the day — a prompt you cannot
// silence is one you learn to look past.
//
// Deliberately does NOT appear while setup is still unfinished: two cards both
// telling you to do something, on a popup this size, is how a first run reads
// as a chore list. Setup first, then this.
let dayPromptOff = false;      // dismissed for today — loaded once, in load()

// Synchronous on purpose. renderTodos() reads the bar's visibility to decide
// how much the empty list should explain, so this cannot be a promise that
// resolves after the list has already painted. The one async part — reading
// the dismissal — is done once in load() and cached in dayPromptOff.
function refreshDayPrompt() {
  const bar = el("dayPrompt");
  const hasTask = todos.some(t => !t.done && (!t.date || t.date <= todayKey()));
  // viewKey is the day the list is currently showing. Asking "what's today for"
  // while the user is reading next Tuesday would be answering a question they
  // did not ask.
  const onToday = viewKey === todayKey();
  show(bar, !(hasTask || dayPromptOff || setupVisible || !onToday));
}

el("dpDismiss").addEventListener("click", () => {
  dayPromptOff = true;
  show(el("dayPrompt"), false);
  // Also silences the worker's once-a-day notification, which reads the same
  // key — dismissing the question in one place should not leave it to be asked
  // again from the other.
  chrome.storage.local.set({ dayPromptDismissed: todayKey() });
  // The empty-list copy changes when this bar goes away: it drops back to the
  // full version, since nothing else is making the ask now.
  renderTodos();
});

el("stepAccess").addEventListener("click", () => {
  try {
    chrome.permissions.request({ origins: ["<all_urls>"] }, (granted) => {
      if (chrome.runtime.lastError) return;
      if (granted) {
        try { chrome.runtime.sendMessage({ type: "hostAccessChanged" }); } catch (e) {}
      }
      refreshSetup();
    });
  } catch (e) {}
});
el("stepMission").addEventListener("click", openSettings);
el("stepKey").addEventListener("click", openSettings);
// Clicking the daily prompt puts the caret where the answer goes. The task
// step used to live in the setup checklist and did the same thing; it moved out
// to the prompt bar because setup finishes once and this question doesn't.
el("dayPrompt").addEventListener("click", (e) => {
  if (e.target.closest("#dpDismiss")) return;   // the ✕ has its own job
  viewKey = todayKey();
  renderTodos();
  el("todoInput").focus();
});

// ---------- misc ----------
// What today's walk-aways bought back, for the header. Set by renderScore so
// the header states a result instead of "watching your tabs" — a phrase that
// was true every single day and therefore told you nothing.
let savedTodayMins = 0;

function setStatus(on) {
  // A live pause owns the header, and this must not talk over it. renderScore()
  // calls setStatus(true) whenever the saved-minutes line changes — which the
  // wallet poll triggers on a timer — so without this guard the header flipped
  // back to "on watch" mid-pause while the switch and the banner still read
  // paused. That is the same three-way contradiction the paused state was added
  // to remove, just on a delay. renderPause() is the only writer while the
  // class is set, and it clears the class itself when the pause ends.
  if (document.body.classList.contains("is-paused")) return;
  // "paused" was the wrong word for the switch: a pause ends by itself and
  // this does not. Saying OFF, in the same words the greyed toolbar icon and
  // its tooltip use, is what makes the three agree.
  el("statusTag").textContent = on
    // "saved" is a word a bank uses. These minutes were taken back off
    // something that was going to have them, and the line should say so.
    ? (savedTodayMins ? savedTodayMins + " min won back today" : "on watch")
    : "OFF — nothing is blocked";
  el("statusDot").className = on ? "dot" : "dot off";
}
function openSettings() {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL("ui/options.html"));
}
el("openSettings").addEventListener("click", openSettings);

el("openAccess").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("ui/access.html") });
});

el("openStats").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("ui/stats.html") });
});

// The full board, opened on whatever day is being looked at here — arriving on
// today after deliberately scrolling to Thursday would throw away the only
// thing the click was about.
function openTaskBoard(key) {
  chrome.tabs.create({
    url: chrome.runtime.getURL("ui/tasks.html") + "?d=" + encodeURIComponent(key || viewKey)
  });
  window.close();
}
el("openTasks").addEventListener("click", () => openTaskBoard(viewKey));

// ---------- the off-switch intercept ----------
// Most "off" moments are really "not right now". Off has no end and a pause
// does, so converting one into the other is the single biggest thing that
// keeps this extension installed.
//
// It reframes; it never traps. The switch is put BACK to on while the sheet is
// open, so nothing has been decided yet — and "Turn it off anyway" is always
// visible and always works. A tool that won't let you leave gets uninstalled,
// which is a permanent off.
function openOffSheet() {
  const w = lastWallet;
  const streak = (w && w.streak) || 0;
  const sheet = el("offSheet");
  el("sheetN").innerHTML = streak +
    "<small>" + (streak === 1 ? "day streak" : "day streak") + "</small>";
  el("sheetWarn").innerHTML = (w && w.earnedToday
    ? "Leave it off and tomorrow takes <b>" + days(streak) + " to 0</b>."
    : "Switch off now and <b>" + days(streak) + " go to 0</b>.") +
    // Off time counts against the same budget as pauses. Said here because
    // this sheet is the moment the number can still change the decision.
    (lastDown && lastDown.today && lastDown.today.total >= 60
      ? " Already stood down <b>" + fmtDownMin(lastDown.today.total).trim() + "</b> today" +
        (lastDown.today.total >= (lastDown.budgetMin || 60) * 60 ? " — over budget." : ".")
      : "");
  sheet.hidden = false;
  // A forced layout, not just a frame: the card has to be measured at its
  // below-the-edge start before the class moves it, or the spring has no
  // distance to travel and the sheet simply appears.
  void sheet.offsetHeight;
  requestAnimationFrame(() => sheet.classList.add("in"));
}
function closeOffSheet() {
  const sheet = el("offSheet");
  sheet.classList.remove("in");
  // Matches --dur-mid, the card's exit transition.
  setTimeout(() => { if (!sheet.classList.contains("in")) sheet.hidden = true; }, 300);
}

// Take the break instead. Pausing leaves the tool ENABLED, so the streak and
// today's progress survive — which is exactly the trade being offered.
document.querySelectorAll(".sheet-opt").forEach(b => {
  b.addEventListener("click", () => {
    pauseFor(Number(b.dataset.mins) || 15, "chose a break over switching off");
    closeOffSheet();
  });
});

// The escape hatch, honoured without argument.
el("sheetOff").addEventListener("click", async () => {
  closeOffSheet();
  el("enabled").checked = false;
  await chrome.storage.local.set({ enabled: false });
  setStatus(false);
  setTimeout(checkOffState, 150);
});

// Clicking the backdrop is a cancel: nothing changes, the tool stays on.
el("offSheet").addEventListener("click", e => {
  if (e.target === el("offSheet")) closeOffSheet();
});

el("enabled").addEventListener("change", async () => {
  const on = el("enabled").checked;

  // Turning OFF with something to lose: ask before it takes effect. The switch
  // goes visually back to on, because at this point nothing has been decided —
  // leaving it mid-flip would be the UI lying about the state.
  if (!on && lastWallet && (lastWallet.streak || 0) > 0) {
    el("enabled").checked = true;
    openOffSheet();
    return;
  }

  await chrome.storage.local.set({ enabled: on });
  setStatus(on);
  // Say what switching off actually forfeits, at the moment it's switched off.
  // Not a confirmation dialog — the switch stays instant, and a tool that
  // argues when you turn it off is a tool you uninstall instead. This just
  // makes the cost visible, once, and only when there is a streak to lose.
  if (!on) {
    chrome.runtime.sendMessage({ type: "wallet" }, w => {
      if (chrome.runtime.lastError || !w) return;
      if (w.streak > 1) {
        el("coinSub").textContent =
          "Off — your " + w.streak + "-day streak breaks if you leave it off.";
      } else {
        el("coinSub").textContent = "Off — not earning.";
      }
      el("coinProg").style.width = "0";
    });
  } else {
    loadWallet();
  }
  // Re-derive the banner either way. Turning the switch ON is exactly when a
  // missing host permission needs to speak up — that is the case where the
  // icon stays grey and nothing else explains why.
  setTimeout(checkOffState, 150);
});

// ---------- "it isn't running" banner ----------
// The markup for this has always existed but nothing ever showed it, so the
// one state the popup could not report was the one that matters: the tool
// switched on but unable to act. Turning the switch back on with no host
// permission changes nothing visible — the icon stays grey — and without a
// reason on screen that reads as a broken button.
function renderOffBar(info) {
  const bar = el("offBar");
  if (!bar) return;
  const reason = info && info.reason;
  if (!reason) {
    show(bar, false);
    // Genuinely running — restore the header, which an earlier fault state may
    // have overwritten. Without this the popup kept saying "no site access"
    // after the permission had been granted.
    setStatus(true);
    return;
  }

  const head = el("obHead"), sub = el("obSub"), fix = el("obFix");
  // How long it has been this way, when we know. Turns "it's off" into
  // "it has been off since Tuesday", which is the fact that actually stings.
  let since = "";
  if (info.since) {
    const mins = Math.round((Date.now() - info.since) / 60000);
    if (mins >= 1440)   since = " for " + Math.floor(mins / 1440) + " day" + (mins >= 2880 ? "s" : "");
    else if (mins >= 60) since = " for " + Math.floor(mins / 60) + "h";
    else if (mins >= 2)  since = " for " + mins + " min";
  }

  // The header must never claim to be watching while the banner says it
  // cannot. Those two lines sat inches apart contradicting each other — the
  // switch said ON, the icon was grey, and only one of them was right.
  // A live pause owns the header: both this and renderPause() write the same
  // two elements from independent async replies, so whichever landed last used
  // to win. A pause is the more specific state and the one with a countdown
  // attached, so it is claimed here rather than left to arrival order.
  const tag = el("statusTag"), dot = el("statusDot");
  const paused = document.body.classList.contains("is-paused");
  if (tag && dot && !paused && reason !== "schedule") {
    tag.textContent = reason === "noaccess" ? "on, but blind — no site access" : "OFF — nothing is blocked";
    dot.className = "dot off";
  }

  if (reason === "noaccess") {
    head.textContent = "Nice Try can't see your tabs";
    sub.textContent = "It's switched on, but site access was never granted. Nothing is being blocked" + since + ".";
    fix.textContent = "Grant site access";
    fix.dataset.act = "grant";
  } else if (reason === "schedule") {
    // Not a fault — say so, and offer no fix. A banner that nags about the
    // schedule you set is the tool arguing with your own decision.
    head.textContent = "Outside your scheduled hours";
    sub.textContent = "Nice Try is standing down until your next window.";
    fix.textContent = "Change schedule";
    fix.dataset.act = "settings";
  } else {
    head.textContent = "Nice Try isn't running";
    sub.textContent = "Switched off — nothing is being blocked or tracked" + since + ".";
    fix.textContent = "Turn it back on";
    fix.dataset.act = "enable";
  }
  show(bar, true);
}

function checkOffState() {
  chrome.runtime.sendMessage({ type: "offState" }, info => {
    if (chrome.runtime.lastError) return;
    renderOffBar(info);
  });
}

el("obFix").addEventListener("click", () => {
  const act = el("obFix").dataset.act;
  if (act === "settings") { openSettings(); return; }
  if (act === "enable") {
    el("enabled").checked = true;
    // Fire the same path the switch does, so the worker repaints and the
    // banner re-derives rather than being hidden on an assumption.
    chrome.storage.local.set({ enabled: true }, () => {
      setStatus(true);
      loadWallet();
      setTimeout(checkOffState, 150);
    });
    return;
  }
  // Grant. chrome.permissions.request must be called synchronously inside the
  // user gesture — an await first and Chrome silently refuses to show the
  // prompt, which is exactly how this permission ends up never granted.
  chrome.permissions.request({ origins: ["<all_urls>"] }, granted => {
    if (chrome.runtime.lastError || !granted) return;
    try { chrome.runtime.sendMessage({ type: "hostAccessChanged" }); } catch (e) {}
    setTimeout(checkOffState, 150);
  });
});

// ---------- streak ----------
// The retention mechanic, and the reason the popup opens on this rather than
// on a balance. Two facts do the work:
//   · a number you built and could lose (loss aversion beats reward-seeking)
//   · an unclosed ring for today (an incomplete thing pulls harder than a
//     finished one — the ten minutes are visibly unfinished until they aren't)
// Everything else here is deliberately calm. A popup that is fun to visit is
// a distraction, and this product exists to remove those.
const RING_C = 94.25;          // 2πr for r=15, matches the SVG dasharray

// "1 days die tonight" was showing on day one — the single most-read line in
// the product, ungrammatical on the exact day a new user first sees it, which
// makes the tool read as sloppy at the one moment it is asking to be trusted.
// Every place that prints a day count goes through here so it cannot recur.
function days(n) { return n + (n === 1 ? " day" : " days"); }

// Mirrors MILESTONES in src/coins.js. Duplicated rather than imported because
// coins.js is worker-only (importScripts), and the popup needs just the one
// question: which milestone did the current run start from? The worker stays
// the authority on which milestone is NEXT — that arrives as w.nextMilestone —
// so a drift here changes only how full the ring looks, never what it counts.
const MILESTONES = [3, 7, 14, 30, 60, 100, 200, 365];
function prevMilestone(goal) {
  let prev = 0;
  for (const m of MILESTONES) { if (m >= goal) break; prev = m; }
  return prev;
}

// Kept for the off-switch intercept, which has to know what is at stake
// before the switch is allowed to settle.
let lastWallet = null;

function renderStreak(w) {
  lastWallet = w;
  const card = el("streakCard");
  if (!card) return;
  const streak = w.streak || 0;
  const pct = Math.max(0, Math.min(100, w.partialPct || 0));
  const done = !!w.earnedToday;
  const risk = !!w.atRisk;
  // Read off the body class rather than asking the worker, because renderPause
  // already owns it and repaints every second — so this cannot disagree with
  // the header sitting directly above the card, and it corrects itself the
  // moment the pause ends without a second round-trip.
  const paused = document.body.classList.contains("is-paused");

  card.classList.toggle("cold", streak < 1);
  card.classList.toggle("risk", risk);

  el("streakN").innerHTML = streak +
    "<small>" + (streak === 1 ? "day" : "days") + "</small>";

  // The ring has two jobs and shows exactly one of them.
  //
  // Not banked: today's ten minutes, as a ring you can see is unclosed.
  // Banked: today's ten minutes are no longer a question, so the ring switches
  // to the next milestone and reports how many days are left to it. A tick used
  // to sit here — a progress ring pinned at 100% saying the same thing the
  // subline already said, which is the one piece of this card that did no work.
  const ring = el("streakRing");
  // Declared here rather than beside the subline below, because the ring and
  // the subline now quote the SAME number and must not be able to drift into
  // quoting two. One expression, read twice.
  const minsLeft = Math.max(1, Math.ceil((100 - pct) / 10));
  const goal = w.nextMilestone || 0;
  // Past the final milestone there is nothing left to count toward, so the day
  // itself is the achievement and the tick is finally the truthful answer.
  const maxed = done && !goal;
  const inGoal = done && goal > 0;

  ring.classList.toggle("done", done && !inGoal);
  ring.classList.toggle("goal", inGoal);
  ring.classList.toggle("maxed", maxed);

  if (inGoal) {
    const left = Math.max(0, goal - streak);
    // How far into the CURRENT gap between milestones, not the raw streak over
    // the target — after 7, a 12-day run is 5 of the 7 days to 14, which is the
    // stretch actually being served. Measuring from zero would show 12/14 and
    // make every later milestone look nearly done from the moment it began.
    const from = prevMilestone(goal);
    const span = Math.max(1, goal - from);
    const filled = Math.max(0, Math.min(100, ((streak - from) / span) * 100));
    el("ringVal").style.strokeDashoffset = String(RING_C - (RING_C * filled / 100));
    // "2d", not "2". The disc is only wide enough for one line, and a bare
    // numeral inside a ring reads as a percentage — which is exactly what this
    // slot showed a moment ago, so the unit has to be on it.
    el("ringTx").textContent = left + "d";
    ring.setAttribute("aria-label",
      left + (left === 1 ? " day" : " days") + " to a " + goal + "-day streak");
  } else {
    const shown = done ? 100 : pct;
    el("ringVal").style.strokeDashoffset = String(RING_C - (RING_C * shown / 100));
    // Minutes, never a percentage. "15%" is a true statement about progress
    // toward the next COIN and a useless one on a card about the STREAK: it
    // names a currency this card never mentions, and a ratio is not a thing
    // you can act on. The same fact in minutes IS the decision — "9m" is a
    // stretch you either sit down and serve or you don't. The banked branch
    // above already speaks in "2d" for exactly this reason, so this gives the
    // ring one unit rule across both its states: always the distance left to
    // the next thing at stake, never a share of something already done.
    el("ringTx").textContent = done ? "✓" : minsLeft + "m";
    ring.setAttribute("aria-label", done
      ? "Today's focus is banked"
      : minsLeft + (minsLeft === 1 ? " minute" : " minutes") + " to bank today");
  }

  // The subline is the only copy in the popup with a job to do, so every state
  // names WHAT IS AT STAKE rather than what has been achieved.
  //
  // "Banked today ✓ · 1 more to 3 days" was the bug: it declares the day won,
  // and a day already won is a reason to switch off for the rest of it. The
  // banked state now points at the thing still in front of you — tomorrow —
  // because that is the only fact that keeps the tool on tonight.
  const sub = el("streakSub");
  if (streak < 1) {
    sub.textContent = w.bestStreak
      ? "10 min puts you back on. You've done " + w.bestStreak + "."
      : "10 focused minutes and day one is yours.";
  } else if (risk && paused) {
    // Paused, and the day is not yet banked. The threat is still TRUE — the
    // streak really does die tonight — but naming a number of minutes here is
    // not: the pause returns out of doTick() above earnFromArmedTime(), so no
    // armed seconds are being counted and those minutes cannot be served until
    // the pause ends. Demanding ten minutes from a tool that has switched off
    // its own ability to count them is the popup arguing with itself, inches
    // below a header that says "paused".
    //
    // So the stake is kept and the clock is dropped. It reads as the one thing
    // the user can still act on — the pause is the only thing in the way, and
    // ending it early is a button already on this screen.
    sub.textContent = days(streak) + " ride on tonight. Clock’s paused.";
  } else if (risk) {
    // The sharpest line in the product, and the one people act on. No verb to
    // hide behind: the clock, then the cost. Kept to one line at 22rem —
    // this is scanned in half a second, and a wrap blunts it.
    sub.textContent = minsLeft + " min, or " + days(streak) + " die tonight.";
  } else {
    // Banked. Never open on a word that grants permission to stop — "safe"
    // and "done" both do. Open on tomorrow, because tomorrow is the only
    // thing that keeps the tool switched on tonight.
    //
    // "Skip tomorrow, lose all 9" was the right idea delivered as a threat on
    // the one day you'd actually won. Naming the next number instead does the
    // same anti-complacency work by pull rather than by fear: it is the only
    // state in this card where the day has genuinely gone well, and it should
    // not be the one that reads harshest.
    //
    // The ring beside this now counts down to the milestone, so the line names
    // what that number is FOR. Saying "13 needs tomorrow" next to a ring
    // reading "2 days" was two different countdowns to two different things,
    // an arm's length apart.
    const left = goal ? Math.max(0, goal - streak) : 0;
    sub.textContent = goal
      ? (left === 1
          // At one day out the milestone lands tomorrow, which is a stronger
          // reason to come back than any count of days remaining.
          ? "Day " + streak + " banked. Tomorrow makes " + goal + "."
          : "Day " + streak + " banked. " + left + " more to " + goal + ".")
      // Past the last milestone the run itself is the only thing left to
      // protect, so the line goes back to naming tomorrow.
      : "Day " + streak + " banked. " + (streak + 1) + " needs tomorrow.";
  }
}

// ---------- celebrations ----------
// Claimed from the worker, which hands each one over exactly once. Doing the
// read-and-clear there rather than here means reopening the popup cannot
// replay a milestone, and two open surfaces cannot both claim it.
function checkCelebration() {
  chrome.runtime.sendMessage({ type: "claimCelebration" }, c => {
    if (chrome.runtime.lastError || !c) return;
    if (c.milestone) showCheer("milestone", c.milestone);
    else if (c.brokeFrom) showCheer("loss", c.brokeFrom);
  });
}

function showCheer(kind, n) {
  const box = el("cheer");
  if (!box) return;
  box.classList.toggle("loss", kind === "loss");
  if (kind === "milestone") {
    el("cheerIco").textContent = n >= 100 ? "🏆" : n >= 30 ? "⭐" : "🔥";
    el("cheerHead").textContent = n + " days";
    // Short, and pointed forward rather than at the day just banked. Never
    // claims a personal best — hitting 7 again after a 30 wouldn't be one, and
    // a congratulation that isn't true is worse than none.
    el("cheerSub").textContent = "Don't be the reason it ends.";
  } else {
    // A broken streak is acknowledged, not scolded. The number that matters
    // now is the one still available to beat.
    el("cheerIco").textContent = "🌱";
    el("cheerHead").textContent = "Streak reset";
    el("cheerSub").textContent = "You had " + n + " days. Today starts the next one.";
  }
  show(box, true);
}
el("cheerX").addEventListener("click", () => { show(el("cheer"), false); });

// ---------- coins ----------
// The balance is read from the worker rather than storage directly, so the
// streak-is-stale rule lives in exactly one place. A popup that decided for
// itself whether a streak was alive would eventually disagree with the
// scoreboard, and a currency two screens disagree about is worthless.
let coinStore = [];
let coinBalance = 0;

function renderWallet(w) {
  if (!w) return;
  coinBalance = w.balance || 0;
  coinStore = w.store || [];
  el("coinBal").textContent = coinBalance;
  el("coinProg").style.width = (w.partialPct || 0) + "%";

  const streak = w.streak || 0;
  renderStreak(w);

  // The subline has to explain the progress bar sitting under it. An empty
  // balance beside a half-full bar and a static sentence reads as broken —
  // the bar looks like it is measuring something the number contradicts.
  // Saying how many minutes are left turns the same two elements into one
  // coherent statement.
  const sub = el("coinSub");
  const pct = w.partialPct || 0;
  const minsLeft = Math.max(1, Math.ceil((100 - pct) / 10));   // 10 min per coin
  if (!w.earned && coinBalance === 0) {
    // First coin never earned. Say exactly what is happening, because this is
    // the state that otherwise looks like nothing is happening at all.
    sub.textContent = pct > 0
      ? "First coin in about " + minsLeft + " min of focus."
      : "Earned while Nice Try is on and you're here.";
  } else if (w.multiplier > 1 && streak > 1) {
    sub.textContent = "×" + w.multiplier.toFixed(2) + " while the streak holds. Switching off breaks it.";
  } else if (pct > 0) {
    sub.textContent = "Next coin in about " + minsLeft + " min.";
  } else {
    sub.textContent = "Keep it on to keep earning.";
  }
  renderShop();
}

// Why the prices are what they are today. Written into the shop header so
// the surcharge is read BEFORE the button, not discovered on the ledger — a
// price you learn about afterwards is a penalty, and a penalty changes
// nothing about the next decision.
function renderPricing(p) {
  const h = document.querySelector(".shop-h");
  if (!h) return;
  if (!p || !(p.mult > 1)) {
    h.textContent = "Spend on time off. Costs more than it pays — that's the point.";
    return;
  }
  const n = p.pausesToday || 0;
  const parts = [];
  if (n) parts.push(n + (n === 1 ? " pause" : " pauses") + " already today");
  if (p.overBudget) parts.push("over today's budget");
  h.textContent = parts.join(", ") + " — prices ×" +
    (Number.isInteger(p.mult) ? p.mult : p.mult.toFixed(1)) + ".";
}

function renderShop() {
  const row = el("shopRow");
  row.textContent = "";
  for (const item of coinStore) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "shop-btn";
    b.disabled = coinBalance < item.price;
    // Built from nodes, not innerHTML — the labels are ours today, but this is
    // a surface that renders data from storage and it should stay unable to
    // execute it.
    b.appendChild(document.createTextNode(item.minutes + " min"));
    const s = document.createElement("small");
    s.textContent = item.price + " coins";
    b.appendChild(s);
    b.title = b.disabled
      ? "Need " + (item.price - coinBalance) + " more"
      : "Pause blocking for " + item.minutes + " minutes" +
        (item.base && item.price > item.base ? " (list price " + item.base + ")" : "");
    b.addEventListener("click", () => buyPause(item.id));
    row.appendChild(b);
  }
}

// ---------- downtime ----------
// The budget bar under the streak card, and the state the free row and the
// off-switch sheet read. Fetched with the wallet so it moves at the same rate.
let lastDown = null;
function fmtDownMin(sec) {
  const m = Math.round((sec || 0) / 60);
  return m >= 60 ? Math.floor(m / 60) + "h " + (m % 60 ? (m % 60) + "m" : "") : m + " min";
}
function renderDowntime(d) {
  lastDown = d;
  const row = el("downRow");
  if (!row || !d || !d.today) return;
  const used = d.today.total || 0;
  const budget = (d.budgetMin || 60) * 60;
  // Nothing to say until a whole minute has been spent — live or not. A pause
  // that started ten seconds ago used to put "0 / 60 min" on screen: a full
  // empty bar on a clean day, which reads as a target already being failed.
  if (used < 60) { row.hidden = true; return; }
  row.hidden = false;
  const over = used >= budget;
  row.classList.toggle("over", over);
  row.classList.toggle("live", !!d.open);
  el("downFill").style.width = Math.min(100, used / budget * 100) + "%";
  el("downV").textContent = over
    ? fmtDownMin(used).trim() + " · " + Math.round((used - budget) / 60) + " over"
    : Math.round(used / 60) + " / " + d.budgetMin + " min";
  // Plain words for what is being measured. "Stood down" was the worker's
  // name for it, and it meant nothing on the popup.
  el("downK").textContent = d.open === "off" ? "Off now, today" : "Off or paused today";
  showPauseRow();
}
function loadDowntime() {
  chrome.runtime.sendMessage({ type: "downtime" }, d => {
    if (chrome.runtime.lastError || !d) return;
    renderDowntime(d);
  });
}

function loadWallet() {
  chrome.runtime.sendMessage({ type: "wallet" }, w => {
    if (chrome.runtime.lastError || !w) return;
    renderWallet(w);
    renderPricing(w.pricing);
  });
  loadDowntime();
}

// The wallet was fetched once on open, so the progress bar was a still image:
// you could sit watching it and it would never move, which makes the whole
// panel look inert. The worker ticks every 3s; refreshing on the same order of
// magnitude keeps the bar honest while the popup is actually being looked at.
// The interval dies with the popup, so this costs nothing when it is closed.
let walletTimer = null;
function startWalletPolling() {
  if (walletTimer) return;
  walletTimer = setInterval(loadWallet, 5000);
}
window.addEventListener("unload", () => {
  if (walletTimer) clearInterval(walletTimer);
});

function buyPause(itemId) {
  const msg = el("shopMsg");
  msg.className = "shop-msg";
  chrome.runtime.sendMessage({ type: "buyPause", itemId }, resp => {
    if (chrome.runtime.lastError || !resp) {
      msg.className = "shop-msg bad";
      msg.textContent = "Couldn't buy — reload and retry.";
      return;
    }
    if (!resp.ok) {
      msg.className = "shop-msg bad";
      msg.textContent = resp.reason === "session"
        ? "Not during a focus session."
        : resp.reason === "poor"
          ? "Need " + (resp.need - resp.balance) + " more coins."
          : "Couldn't buy that.";
      loadWallet();
      return;
    }
    msg.className = "shop-msg good";
    msg.textContent = "Bought " + resp.minutes + " minutes. Spend them well.";
    renderPause(resp.pausedUntil, "bought");
    loadWallet();
  });
}

el("coinBar").addEventListener("click", () => {
  const shop = el("shop");
  const open = shop.hidden || shop.dataset.leaving === "1";
  show(shop, open);
  el("coinBar").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) { el("shopMsg").textContent = ""; loadWallet(); }
});

// ---------- timed pause ----------
// Stand the tool down for a fixed stretch. Distinct from the on/off switch on
// purpose: that one has no end, so it turns one bad afternoon into an extension
// that never runs again. This comes back by itself.
// `source` is "row" for the popup's own free buttons, which the worker
// rations; the off-switch sheet sends nothing and is never refused.
function pauseFor(minutes, reason, source) {
  chrome.runtime.sendMessage({ type: "pauseFor", minutes, reason: reason || "", source: source || "" }, resp => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      el("testMsg").textContent = resp && resp.reason === "session"
        ? "Can't pause during a focus session."
        : resp && resp.reason === "budget"
          ? (resp.over ? "Today's budget is spent. Pauses cost coins now."
                       : "Free pause used today. The rest cost coins.")
          : "Couldn't pause — reload and retry.";
      closePauseWhy();
      loadDowntime();
      return;
    }
    closePauseWhy();
    renderPause(resp.pausedUntil, "free");
  });
}

// ---------- pause reason ----------
// An unattributed pause teaches nothing. One question, asked once, turns a
// fortnight of pauses into a ranked list of what actually breaks your focus —
// which is more useful than any individual block. Skippable on purpose: a
// reason invented to dismiss a dialog is noise in the data.
let pendingPauseMins = 0;

// Testing convenience. The 30 min / 1 hour row stands the tool down for
// nothing, which is a hole in an economy where every other stand-down has a
// price. Kept while the tool is being exercised, but never silently: the
// worker records every use (a ledger row at zero, "free" in the pause log,
// "· free" in the header above, the free count on the scoreboard) so the hole
// is at least visible. Flip this to false to remove the row. The off-switch
// sheet shares pauseFor and is deliberately NOT gated — a break offered
// instead of switching off has to stay free, because switching off is.
const FREE_PAUSE_ROW = true;
// TESTING ONLY — set back to false before shipping, together with
// FREE_PAUSE_UNLIMITED in src/coins.js. The popup does not load coins.js, so
// the flag is duplicated here; the worker's copy is the one that actually
// enforces, and this one only decides whether the buttons are drawn. If they
// ever disagree the worker wins and the row's buttons lie, so move both.
const FREE_PAUSE_UNLIMITED = true;
// One free pause a day, and none once the budget is spent — the worker
// enforces the same rule. Past that the row stays, with its buttons gone and
// the label saying why, so the rule is visible rather than the row just
// missing.
function showPauseRow() {
  const row = el("pauseRow");
  if (!FREE_PAUSE_ROW) { show(row, false); return; }
  show(row, true);
  const t = lastDown && lastDown.today;
  const budget = lastDown ? (lastDown.budgetMin || 60) * 60 : 0;
  // While testing, the ration never marks the row spent — but the day's usage
  // is still shown in the label, so an unlimited pause is never a silent one.
  const spent = !FREE_PAUSE_UNLIMITED && !!t && (t.frees >= 1 || t.total >= budget);
  row.querySelectorAll(".pause-btn").forEach(b => { b.hidden = spent; });
  const lbl = row.querySelector(".pl");
  if (lbl) lbl.textContent = spent
    ? (t.total >= budget ? "Budget spent — pauses cost coins now" : "Free pause used — the rest cost coins")
    // Kept to one line. "Pause blocking · testing (2 free today)" wrapped onto
    // two lines in the real popup, which pushed the row taller than the ones
    // around it and read as a warning rather than a label. The count is the
    // part worth keeping — it is what stops an unlimited pause being a silent
    // one — so the word "testing" goes and the number stays.
    : (FREE_PAUSE_UNLIMITED && t && t.frees
        ? "Pause blocking · " + t.frees + " free today"
        : "Pause blocking");
}
showPauseRow();

function openPauseWhy(mins) {
  pendingPauseMins = mins;
  el("pwLbl").textContent = "Pausing " + (mins === 60 ? "1 hour" : mins + " min");
  el("pauseReason").value = "";
  document.querySelectorAll(".pw-chip").forEach(c => c.classList.remove("is-on"));
  show(el("pauseRow"), false);
  show(el("pauseWhy"), true);
  el("pauseReason").focus({ preventScroll: true });
}
function closePauseWhy() {
  show(el("pauseWhy"), false);
  // The row comes back only when nothing is standing the tool down — during a
  // pause or a session the controls are hidden by their own renderers.
  showPauseRow();
  pendingPauseMins = 0;
}

el("pause30").addEventListener("click", () => openPauseWhy(30));
el("pause60").addEventListener("click", () => openPauseWhy(60));
el("pwCancel").addEventListener("click", closePauseWhy);
el("pwSkip").addEventListener("click", () => pauseFor(pendingPauseMins, "", "row"));
el("pwGo").addEventListener("click", () => pauseFor(pendingPauseMins, el("pauseReason").value.trim(), "row"));

// A chip is a one-tap answer: it fills the field and commits immediately.
// Making you tap a chip and then a button would be two actions for something
// that is already a detour from what you were doing.
el("pwChips").addEventListener("click", (e) => {
  const c = e.target.closest("[data-r]");
  if (!c) return;
  pauseFor(pendingPauseMins, c.dataset.r);
});
el("pauseReason").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); pauseFor(pendingPauseMins, el("pauseReason").value.trim()); }
});

// ---------- press feedback ----------
// Highlight on pointerdown, not on click. Waiting for the release makes the UI
// feel a frame behind the finger; this commits the visual immediately and
// releases it on pointerup/cancel — including when the pointer is dragged off
// the control, which cancels the activation too.
(function pressFeedback() {
  const SEL = ".btn, .icon-btn, #addBtn";
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
  // dragging off the control should visually un-press it
  document.addEventListener("pointermove", (e) => {
    if (pressed && e.target.closest && e.target.closest(SEL) !== pressed) release();
  });
  window.addEventListener("blur", release);
})();

// ---------- paused banner ----------
// While the extension is standing down, say so and count it down here rather
// than only on the toolbar badge — the popup is where you look to find out
// what the tool is currently doing.
let pauseTimer = null;
// The deadline the per-second timer counts toward. Held OUTSIDE the interval's
// closure on purpose: the timer used to be created as
// setInterval(() => renderPause(until)) with the `until` of whichever call
// started it, and it was never restarted while a pause was on foot. So
// extending a pause — "30 min" pressed forty minutes into an hour, or minutes
// bought at the store — painted the new time for one frame and then snapped
// back to the OLD countdown a second later, while the toolbar badge (which
// reads the worker) showed the new one. Two clocks, one pause.
let pauseUntilAt = 0;
// The kind of pause on foot, from the worker. Held here because the per-second
// repaint only carries the deadline.
let pauseKind = "";
const PAUSE_KIND_TAG = {
  free: " · free",
  bought: " · bought",
  grant: " · talked past the wall"
};

function renderPause(until, kind) {
  if (kind !== undefined) pauseKind = kind || "";
  pauseUntilAt = until || 0;
  const bar = el("pausedBar");
  const left = Math.max(0, (until || 0) - Date.now());
  if (left <= 0) {
    show(bar, false);
    if (pauseTimer) { clearInterval(pauseTimer); pauseTimer = null; }
    // Coming out of a pause has to hand the header and the switch back, or
    // they keep wearing the paused amber after blocking has resumed. The class
    // is dropped BEFORE setStatus, which now no-ops while it is set.
    const wasPaused = document.body.classList.contains("is-paused");
    document.body.classList.remove("is-paused");
    if (wasPaused) {
      // Both arms matter. If the switch is on, the header goes back to "on
      // watch" here. If it is OFF, setStatus(false) alone would be wrong —
      // the reason could be no-access or a schedule window, and only the
      // worker knows which — so the banner re-derives it. Without this the
      // header kept the stale "paused — back in 0s" after an off-switch pause
      // expired, which is the same stale-state bug in a new place.
      if (el("enabled").checked) setStatus(true);
      else checkOffState();
      // The streak card is holding "Clock's paused" — true a second ago, and
      // now a lie in the opposite direction. It has to go back to naming the
      // minutes, and the class it reads has just been dropped above.
      try { loadWallet(); } catch (e) {}
    }
    return;
  }
  show(bar, true);
  // The header and the banner sat inches apart saying opposite things: a green
  // dot and "on watch" above, "Nice Try is off" below. checkOffState already
  // solves this for the switch being off; a pause is the same lie and needs
  // the same answer. Not the OFF wording though — a pause ends by itself, and
  // borrowing the permanent-off copy would misreport a state that is about to
  // fix itself.
  const s = Math.ceil(left / 1000);
  const mmss = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  const tag = el("statusTag"), dot = el("statusDot");
  if (tag && dot) {
    // Names how the pause was got, not just when it ends. A free pause and a
    // bought one look the same from here and are not the same thing.
    tag.textContent = "paused — back in " + (s >= 60 ? Math.ceil(s / 60) + " min" : s + "s") +
      (PAUSE_KIND_TAG[pauseKind] || "");
    dot.className = "dot paused";
  }
  const wasPausedAlready = document.body.classList.contains("is-paused");
  document.body.classList.add("is-paused");
  el("pausedLeft").textContent = mmss;
  // The streak card reads this class, and both are painted from independent
  // round-trips fired in the same loop in load() — with loadWallet dispatched
  // FIRST. So on a cold worker the card could paint "2 min, or 10 days die
  // tonight" before the pause was known, then hold that line until the 5s
  // wallet poll happened to correct it. Repainting it the moment the class
  // goes on closes that window; guarded on the transition so the 1s pause
  // timer isn't re-rendering the card every second for no reason.
  if (!wasPausedAlready) { try { loadWallet(); } catch (e) {} }
  // Reads the module-level deadline each second, not the argument this call
  // was made with — see pauseUntilAt.
  if (!pauseTimer) pauseTimer = setInterval(() => renderPause(pauseUntilAt), 1000);
}

el("endPause").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "endPause" }, () => {
    renderPause(0);
    checkPause();
  });
});

function checkPause() {
  chrome.runtime.sendMessage({ type: "pauseState" }, resp => {
    if (chrome.runtime.lastError || !resp) return;
    renderPause(resp.pausedUntil, resp.pauseKind);
  });
}

// ---------- focus session ----------
// The pre-commitment mode. Everything else in this popup is negotiable — this
// is the one thing you set up while thinking clearly so that the version of you
// who wants to open YouTube in twenty minutes has nothing to argue with.
let sessionTimer = null;
let pickedMins = 25;

function renderSession(st) {
  const bar = el("sessionBar");
  const startRow = el("startRow");
  const pauseRow = document.querySelector(".pause-row");

  if (!st || !st.active || st.leftMs <= 0) {
    show(bar, false);
    show(startRow, true);
    // The pause controls come back only when no session is running.
    if (pauseRow) showPauseRow();
    if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null; }
    return;
  }

  show(bar, true);
  show(startRow, false);
  show(el("starterCard"), false);
  // Hidden rather than disabled: a greyed-out "30 min" during a session is an
  // offer being dangled. The enforcement is in the worker either way.
  if (pauseRow) show(pauseRow, false);

  const s = Math.ceil(st.leftMs / 1000);
  el("sClock").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  el("sTask").textContent = st.task || "";
  const total = st.totalMs || 1;
  el("sFill").style.width = (100 * (1 - st.leftMs / total)).toFixed(1) + "%";

  // Re-derived from the deadline each tick rather than decremented, so the
  // display can't drift if the popup is throttled in a background window.
  if (!sessionTimer) {
    const until = Date.now() + st.leftMs;
    sessionTimer = setInterval(() => {
      const leftMs = Math.max(0, until - Date.now());
      if (leftMs <= 0) { checkSession(); return; }
      renderSession({ active: true, leftMs, task: st.task, totalMs: total });
    }, 1000);
  }
}

function checkSession() {
  chrome.runtime.sendMessage({ type: "sessionState" }, resp => {
    if (chrome.runtime.lastError || !resp) return;
    if (sessionTimer && (!resp.active || resp.leftMs <= 0)) {
      clearInterval(sessionTimer); sessionTimer = null;
    }
    renderSession(resp);
  });
}

// Fills the task picker from today's open tasks. Naming the task is what makes
// a session a commitment to something rather than just a timer — the strict
// wall shows it back to you when you drift.
//
// With no open tasks the picker holds nothing but its own placeholder, which
// reads as a dead control rather than an empty one. In that case the text field
// takes its place, so the question is always answerable.
function fillSessionTasks() {
  const sel = el("sessionTask");
  const txt = el("sessionTaskText");
  const swap = el("sessionTaskSwap");
  const open = todos.filter(t => !t.done && (!t.date || t.date <= todayKey()));

  if (!open.length) {
    sel.hidden = true;
    txt.hidden = false;
    swap.hidden = true;
    txt.value = "";
    return;
  }

  sel.hidden = false;
  txt.hidden = true;
  swap.hidden = false;
  sel.innerHTML =
    '<option value="">— pick one —</option>' +
    open.map(t => '<option value="' + esc(t.text) + '">' + esc(t.text) + '</option>').join("");
}

// "Type something else" — swaps the picker for a free-text field. One way only:
// once you've chosen to type, the list isn't what you wanted.
el("sessionTaskSwap").addEventListener("click", () => {
  el("sessionTask").hidden = true;
  el("sessionTaskSwap").hidden = true;
  const txt = el("sessionTaskText");
  txt.hidden = false;
  txt.value = "";
  txt.focus();
});

// Whichever control is currently visible is the one that holds the answer.
function sessionTaskValue() {
  const txt = el("sessionTaskText");
  if (!txt.hidden) return txt.value.trim();
  return el("sessionTask").value || "";
}

// The button becomes the card: the row collapses as the card grows, on the
// same spring, so the "Start" you pressed reads as having opened rather than
// as one thing vanishing and an unrelated one appearing in its place.
el("startSession").addEventListener("click", () => {
  fillSessionTasks();
  show(el("startRow"), false);
  show(el("starterCard"), true);
});
el("starterCancel").addEventListener("click", () => {
  show(el("starterCard"), false);
  show(el("startRow"), true);
});
el("stMins").addEventListener("click", (e) => {
  const b = e.target.closest("[data-m]");
  if (!b) return;
  pickedMins = Number(b.dataset.m) || 25;
  document.querySelectorAll(".st-min").forEach(x => x.classList.toggle("is-on", x === b));
});
el("starterGo").addEventListener("click", () => {
  const task = sessionTaskValue();
  chrome.runtime.sendMessage({ type: "startSession", minutes: pickedMins, task }, resp => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      el("testMsg").textContent = "Couldn't start — reload and retry.";
      return;
    }
    show(el("starterCard"), false);
    checkSession();
  });
});
el("sEnd").addEventListener("click", (e) => {
  const b = e.currentTarget;
  // Two-step. Not friction for its own sake: ending a session is the one action
  // here that undoes a decision the user made deliberately, and a single
  // mis-click on a small button should not be able to do that.
  if (b.dataset.armed !== "1") {
    b.dataset.armed = "1";
    b.textContent = "Click again to end it";
    setTimeout(() => {
      if (b.isConnected && b.dataset.armed === "1") {
        b.dataset.armed = ""; b.textContent = "End early";
      }
    }, 4000);
    return;
  }
  b.dataset.armed = ""; b.textContent = "End early";
  chrome.runtime.sendMessage({ type: "endSession" }, () => {
    if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null; }
    checkSession();
    checkPause();
  });
});

// Recomputed rather than stored, so it reflects the real state at all times —
// deleting your only task correctly brings the step back.
async function refreshSetup() {
  const d = await chrome.storage.local.get(["mission", "apiKey"]);
  renderSetup({
    hasAccess: await hostGranted(),
    hasMission: !!(d.mission || "").trim(),
    hasKey: !!(d.apiKey || "").trim(),
    hasTask: todos.some(t => !t.done)
  });
}

// Whether the extension can actually see pages. Read directly rather than
// asked of the worker — this is a synchronous-ish local check, and the popup
// must be able to paint the answer even if the worker is asleep.
async function hostGranted() {
  try {
    return await chrome.permissions.contains({ origins: ["<all_urls>"] });
  } catch (e) {
    return false;
  }
}

// storage.local.get rejects if the extension context is torn down mid-read —
// which happens on a reload, an update, or when the popup is opened during a
// service-worker restart. Retried once after a beat, because that restart is
// usually over in well under a second, and only then given up on. Falling back
// to an empty object means a failed read costs you today's data on screen, not
// the popup itself.
async function readState(keys) {
  try {
    return await chrome.storage.local.get(keys);
  } catch (e) {
    await new Promise(r => setTimeout(r, 120));
    try {
      return await chrome.storage.local.get(keys);
    } catch (e2) {
      console.error("[popup] storage unavailable", e2);
      throw e2;
    }
  }
}

async function load() {
  const d = await readState([
    "todos","enabled","log","repairDone","dayPromptDismissed"
  ]);
  // Read once here so refreshDayPrompt() can stay synchronous — renderTodos()
  // depends on the bar's state being settled before it paints.
  dayPromptOff = d.dayPromptDismissed === todayKey();
  // One-time repair of tasks an earlier build stamped with the wrong day.
  needsRepair = !d.repairDone;
  todos = normalizeTodos(d.todos, d.log);
  // Write the migration back once. Normalizing only in memory would re-stamp
  // undated tasks against a fresh todayKey() on every open, so a legacy done
  // task would keep resurfacing as today's work no matter what it's given.
  if (JSON.stringify(todos) !== JSON.stringify(d.todos || [])) {
    await chrome.storage.local.set({ todos });
  }
  // Mark the repair spent whether or not it changed anything, so it can never
  // reach back and re-date work finished later on a long-used site.
  if (needsRepair) {
    await chrome.storage.local.set({ repairDone: true });
    needsRepair = false;
  }
  // Setup state is resolved BEFORE the first render: the empty task card checks
  // setupVisible to decide how much to explain, so painting it first would use
  // a stale value and show the long copy for one frame.
  //
  // Guarded, because this is the one awaited call between reading storage and
  // painting: it asks the permissions API and storage again, and either can
  // reject while the service worker is asleep or restarting. Unguarded, that
  // rejection aborted load() before renderTodos() and the popup opened blank —
  // the "sometimes clicking the icon does nothing" report. A missing setup
  // card is a far smaller failure than a missing popup.
  try {
    await refreshSetup();
  } catch (e) {
    console.error("[popup] setup check failed, painting anyway", e);
  }
  renderTodos();
  const on = d.enabled !== false;
  el("enabled").checked = on;
  setStatus(on);
  renderScore(d.log || {});
  // Each of these talks to the service worker, which may be asleep. They are
  // independent enhancements to an already-painted popup, so one failing must
  // not take the rest of them — or the paint above — down with it.
  for (const step of [loadWallet, startWalletPolling, checkCelebration,
                      checkOffState, checkAi, checkPause, checkSession, loadTabChip]) {
    try { step(); } catch (e) { console.error("[popup] " + step.name + " failed", e); }
  }
  // The worker's answers above land over the next few hundred ms and paint
  // panels into place. Those are first paints, not changes, and must snap; the
  // popup's motion turns on only once they have had time to arrive.
  setTimeout(show.boot, 400);
}

// The whole popup is painted inside load(). A bare load() call left every
// failure above as an unhandled rejection that stopped the paint dead and
// showed an empty panel with no hint why. Now the reason is logged, and the
// user is told the popup is the thing that broke rather than being left to
// conclude the extension is dead.
load().catch(e => {
  console.error("[popup] load failed", e);
  const app = document.querySelector(".app");
  if (!app) return;
  const warn = document.createElement("div");
  warn.className = "card";
  warn.style.cssText = "color:var(--soft);font-size:0.813rem;line-height:1.45";
  warn.innerHTML = '<b style="color:var(--ink)">Couldn\'t load your day.</b><br>' +
    'Nice Try is still running — this panel just failed to open. ' +
    'Close and reopen it, and if it keeps happening, reload the extension.';
  app.prepend(warn);
});
