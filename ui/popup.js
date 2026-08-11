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

// ---------- to-dos ----------
// A task may carry a link. That ONE page is exempt from scanning — not the
// site it lives on. A DSA video does not hand over the rest of YouTube. The
// exemption lives with the task: remove the task and it's gone.
let todos = [];   // [{text, done, url?, host?}]

// accepts legacy plain-string todos too
function normalizeTodos(raw) {
  return (raw || [])
    .map(t => (typeof t === "string" ? { text: t, done: false } : t))
    .filter(t => t && t.text);
}

async function saveTodos() {
  await chrome.storage.local.set({ todos });
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

function renderTodos() {
  const list = el("todoList");
  const done = todos.filter(t => t.done).length;
  el("todoCount").textContent = todos.length ? done + " / " + todos.length + " done" : "";

  if (!todos.length) {
    list.innerHTML = '<p class="empty">Nothing set yet. Add what you actually need to do today — the lock screen shows these when you drift.<br><br>Paste a link in a task and that site stays open while the task is.</p>';
    return;
  }
  list.innerHTML = todos.map((t, i) => {
    // A real anchor, so it can be opened, focused and middle-clicked like any
    // link. Naming the page rather than the host, because "youtube.com" would
    // read as if the whole site were exempt — which is what this doesn't do.
    const sub = t.host
      ? '<a class="todo-sub" href="' + esc(t.url || "") + '" data-act="open" ' +
        'title="' + esc(t.url || "") + '" rel="noreferrer noopener">' +
          '<span class="lk-ico" aria-hidden="true">↗</span>' +
          '<span class="lk-tx">' + esc(t.host) + '</span>' +
          '<span class="lk-note">· this page only</span>' +
        '</a>'
      : "";
    return '<div class="todo' + (t.done ? " done" : "") + '" data-i="' + i + '">' +
      '<span class="box" data-act="toggle"></span>' +
      '<span class="body">' +
        '<span class="txt" data-act="toggle">' + esc(t.text) + '</span>' + sub +
      '</span>' +
      '<button class="del" data-act="del" title="Remove">×</button>' +
    '</div>';
  }).join("");
}

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
  if (act === "toggle") {
    todos[i].done = !todos[i].done;
  } else if (act === "del") {
    // Deleting the task removes its exemption with it — the exemption is
    // derived from this list, so nothing else needs cleaning up.
    todos.splice(i, 1);
  }
  saveTodos();
});

function addTodo() {
  const raw = el("todoInput").value.trim();
  if (!raw) return;
  const url = extractUrl(raw);
  const host = hostOfUrl(url);
  // keep the link out of the visible task text — it's shown on its own line
  const text = url ? raw.replace(url, "").trim().replace(/[-–—:]\s*$/, "").trim() : raw;
  const item = { text: text || host || raw, done: false };
  if (url && host) {
    item.url = url; item.host = host;
    chrome.runtime.sendMessage({ type: "taskLinkAdded" });
  }
  todos.push(item);
  el("todoInput").value = "";
  saveTodos();
}
el("addBtn").addEventListener("click", addTodo);
el("todoInput").addEventListener("keydown", e => { if (e.key === "Enter") addTodo(); });

// ---------- AI status ----------
function renderAi(resp) {
  const box = el("aiStatus"), msg = el("aiMsg");
  box.className = "ai";
  // A real <button>, not a <span> — it must be reachable and activatable by
  // keyboard, which a span with a click handler never is.
  if (!resp || resp.state === "nokey") {
    msg.textContent = "No API key — using keyword matching only.";
    box.insertAdjacentHTML("beforeend", '<button type="button" class="fix" id="aiFix">Add key</button>');
    el("aiFix").addEventListener("click", openSettings);
  } else if (resp.state === "ok") {
    box.classList.add("ok");
    msg.textContent = "AI active via " + (resp.provider === "groq" ? "Groq" : "OpenRouter") + ".";
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

  const sites = day.sites || {};
  const rows = Object.keys(sites).map(n => ({ n, s: sites[n] }))
    .filter(r => r.s >= 60).sort((a,b) => b.s - a.s).slice(0, 5);
  const box = el("sites");
  if (!rows.length) { box.style.display = "none"; return; }
  box.style.display = "block";
  box.innerHTML = '<div class="lbl" style="margin-bottom:8px">Where your time went</div>' +
    rows.map(r => '<div class="site"><span class="n">' + esc(r.n) + '</span><span class="t">' + fmt(r.s) + '</span></div>').join("");
}

// ---------- misc ----------
function setStatus(on) {
  el("statusTag").textContent = on ? "watching your tabs" : "paused";
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

el("enabled").addEventListener("change", async () => {
  const on = el("enabled").checked;
  await chrome.storage.local.set({ enabled: on });
  setStatus(on);
});

el("testLock").addEventListener("click", () => {
  el("testMsg").textContent = "sending…";
  chrome.runtime.sendMessage({ type: "testLock" }, resp => {
    if (chrome.runtime.lastError) { el("testMsg").textContent = "err: " + chrome.runtime.lastError.message; return; }
    if (resp && resp.ok) { window.close(); }
    else el("testMsg").textContent = "Couldn't lock: " + (resp ? resp.err : "no response");
  });
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

async function load() {
  const d = await chrome.storage.local.get(["todos","enabled","log"]);
  todos = normalizeTodos(d.todos);
  renderTodos();
  const on = d.enabled !== false;
  el("enabled").checked = on;
  setStatus(on);
  renderScore(d.log || {});
  checkAi();
}
load();
