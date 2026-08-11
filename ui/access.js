// access.js — the audit trail: which sites got past the wall, and how.
// Grouped by host (that's the unit you revoke), but each row keeps the
// individual titles so you can see WHAT got through, not just where.

const el = id => document.getElementById(id);
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

let entries = [];      // raw log rows, newest first
let allowSet = [];     // user's always-allowed domains
let activeSet = [];    // hosts with a live (unexpired) grant
let filter = "all";
const expanded = new Set();   // hosts whose full title list is open

// "3m ago" / "2h ago" / "Aug 11" — relative while it's fresh, absolute after a day
function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Collapse the flat log into one entry per host, preserving each pass.
function groupByHost(list) {
  const map = new Map();
  for (const e of list) {
    if (!map.has(e.host)) {
      map.set(e.host, { host: e.host, items: [], answers: 0, typing: 0, last: 0 });
    }
    const g = map.get(e.host);
    g.items.push(e);
    if (e.via === "typing") g.typing++; else g.answers++;
    if (e.at > g.last) g.last = e.at;
  }
  // most recently used first — that's what you're most likely reacting to
  return [...map.values()].sort((a, b) => b.last - a.last);
}

function matchesFilter(g) {
  if (filter === "typing")  return g.typing > 0;
  if (filter === "answers") return g.answers > 0;
  return true;
}

function isAllowed(host) {
  return allowSet.some(d => host === d || host.endsWith("." + d));
}

function render() {
  const groups = groupByHost(entries);

  el("nAll").textContent     = groups.length ? " " + groups.length : "";
  el("nTyping").textContent  = (() => { const n = groups.filter(g => g.typing > 0).length; return n ? " " + n : ""; })();
  el("nAnswers").textContent = (() => { const n = groups.filter(g => g.answers > 0).length; return n ? " " + n : ""; })();

  const shown = groups.filter(matchesFilter);
  const box = el("rows");

  if (!shown.length) {
    box.innerHTML = '<div class="empty">' + (entries.length
      ? "Nothing matches this filter."
      : "Nothing has made it past the wall yet.<br>When you justify your way onto a site, it shows up here.")
      + '</div>';
    return;
  }

  box.innerHTML = shown.map(g => {
    const open = expanded.has(g.host);
    // newest titles first; collapsed rows show 3, expanded shows everything
    const items = g.items.slice().sort((a, b) => b.at - a.at);
    const visible = open ? items : items.slice(0, 3);
    const hidden = items.length - visible.length;

    const badges =
      (activeSet.includes(g.host) ? '<span class="badge live">access now</span>' : "") +
      (isAllowed(g.host)          ? '<span class="badge allow">always allowed</span>' : "") +
      (g.typing  ? '<span class="badge typing">' + g.typing + ' forced</span>' : "") +
      (g.answers ? '<span class="badge answers">' + g.answers + ' justified</span>' : "");

    const titles = visible.map(i =>
      '<div class="t-item">' +
        '<span class="dot ' + i.via + '"></span>' +
        '<span class="tx">' + esc(i.title || "(untitled page)") + '</span>' +
        '<span class="tm">' + esc(ago(i.at)) + '</span>' +
      '</div>').join("");

    return '<div class="row">' +
      '<div class="row-head">' +
        '<span class="host">' + esc(g.host) + '</span>' +
        '<span class="badges">' + badges + '</span>' +
      '</div>' +
      '<div class="meta">' + items.length + ' pass' + (items.length === 1 ? "" : "es") +
        ' · last ' + esc(ago(g.last)) + '</div>' +
      '<div class="titles">' + titles + '</div>' +
      '<div class="row-actions">' +
        '<button class="revoke" type="button" data-revoke="' + esc(g.host) + '">Revoke &amp; block again</button>' +
        (hidden > 0 || open
          ? '<button class="more" type="button" data-more="' + esc(g.host) + '">' +
              (open ? "Show less" : "Show " + hidden + " more") + '</button>'
          : "") +
      '</div>' +
    '</div>';
  }).join("");
}

function flash(msg) {
  const m = el("liveMsg");
  m.textContent = msg;
  m.classList.add("show");
  setTimeout(() => m.classList.remove("show"), 2600);
}

// ---------- events ----------
el("rows").addEventListener("click", (e) => {
  const moreBtn = e.target.closest("[data-more]");
  if (moreBtn) {
    const h = moreBtn.dataset.more;
    if (expanded.has(h)) expanded.delete(h); else expanded.add(h);
    render();
    return;
  }
  const revokeBtn = e.target.closest("[data-revoke]");
  if (!revokeBtn) return;
  const host = revokeBtn.dataset.revoke;
  // Two-step, no browser confirm() — a modal dialog from an extension page is
  // easy to mis-click through, and confirm() blocks the whole page.
  if (revokeBtn.dataset.armed !== "1") {
    revokeBtn.dataset.armed = "1";
    revokeBtn.textContent = "Click again to confirm";
    setTimeout(() => {
      if (revokeBtn.isConnected && revokeBtn.dataset.armed === "1") {
        revokeBtn.dataset.armed = "";
        revokeBtn.textContent = "Revoke & block again";
      }
    }, 4000);
    return;
  }
  chrome.runtime.sendMessage({ type: "revokeHost", host }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) { flash("Couldn't revoke — reload and retry."); return; }
    entries = entries.filter(x => x.host !== host);
    allowSet = allowSet.filter(d => d !== host && !host.endsWith("." + d));
    activeSet = activeSet.filter(h => h !== host);
    expanded.delete(host);
    render();
    flash(host + " will face the wall again" + (resp.forgotten ? " · " + resp.forgotten + " remembered verdicts forgotten" : ""));
  });
});

el("clearAll").addEventListener("click", (e) => {
  const b = e.currentTarget;
  if (b.dataset.armed !== "1") {
    b.dataset.armed = "1";
    b.textContent = "Click again to clear everything";
    setTimeout(() => {
      if (b.dataset.armed === "1") { b.dataset.armed = ""; b.textContent = "Clear the whole log"; }
    }, 4000);
    return;
  }
  chrome.runtime.sendMessage({ type: "clearAccessLog" }, () => {
    b.dataset.armed = ""; b.textContent = "Clear the whole log";
    entries = []; expanded.clear(); render();
    // Clearing the history does NOT un-remember anything — say so plainly
    // rather than letting it look like a reset.
    flash("Log cleared. Remembered verdicts are untouched — revoke a site to undo those.");
  });
});

document.querySelectorAll(".tab").forEach(t => {
  t.addEventListener("click", () => {
    filter = t.dataset.f;
    document.querySelectorAll(".tab").forEach(x => x.setAttribute("aria-selected", String(x === t)));
    render();
  });
});

// press feedback on pointerdown, matching the other surfaces
(function pressFeedback() {
  const SEL = ".tab, .revoke, .more, .clear";
  let pressed = null;
  const release = () => { if (pressed) { pressed.classList.remove("is-press"); pressed = null; } };
  document.addEventListener("pointerdown", (e) => {
    const t = e.target.closest && e.target.closest(SEL);
    if (!t) return;
    pressed = t; t.classList.add("is-press");
  });
  document.addEventListener("pointerup", release);
  document.addEventListener("pointercancel", release);
  document.addEventListener("pointermove", (e) => {
    if (pressed && e.target.closest && e.target.closest(SEL) !== pressed) release();
  });
  window.addEventListener("blur", release);
})();

function load() {
  chrome.runtime.sendMessage({ type: "getAccessLog" }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      el("rows").innerHTML = '<div class="empty">Couldn\'t reach the extension worker.<br>Reload this page and try again.</div>';
      return;
    }
    entries = resp.entries || [];
    allowSet = resp.allowDomains || [];
    activeSet = resp.active || [];
    render();
  });
}
load();
