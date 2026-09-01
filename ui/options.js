// options.js — settings page: mission, API key, allowed sites, reset data.

const el = id => document.getElementById(id);

function todayKey() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}

// normalize a typed line into a bare hostname (strips https://, www., paths)
function cleanDomain(line) {
  let s = line.trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split("/")[0].split("?")[0];
  return s;
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

// ---------- schedule ----------
// The editable copy. Held here rather than read back out of the DOM on save,
// so a half-typed time can't silently become a window.
let windows = [];
const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES  = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function renderSchedule() {
  const box = el("schedList");
  box.innerHTML = windows.map((w, i) => {
    const days = DAY_LABELS.map((lb, d) =>
      '<button class="day' + (w.days.includes(d) ? " on" : "") + '" type="button" ' +
        'data-w="' + i + '" data-d="' + d + '" ' +
        'aria-pressed="' + (w.days.includes(d) ? "true" : "false") + '" ' +
        'aria-label="' + DAY_NAMES[d] + '">' + lb + '</button>').join("");
    // A window whose end time is before its start runs through midnight. That
    // is supported, but it is also what a typo looks like, so it is named.
    const overnight = w.from && w.to && w.from > w.to;
    return '<div class="win">' +
      '<div class="win-top">' +
        '<span class="win-times">' +
          '<input type="time" data-w="' + i + '" data-k="from" value="' + esc(w.from) + '">' +
          '<span class="win-to">to</span>' +
          '<input type="time" data-w="' + i + '" data-k="to" value="' + esc(w.to) + '">' +
        '</span>' +
        '<button class="win-x" type="button" data-del="' + i + '" aria-label="Remove these hours">✕</button>' +
      '</div>' +
      '<div class="win-days">' + days + '</div>' +
      '<p class="win-note"' + (overnight ? "" : " hidden") + '>Runs overnight into the next morning.</p>' +
    '</div>';
  }).join("");
}

el("addWindow").addEventListener("click", () => {
  // Weekdays, 9-5: the shape most people are about to type anyway, and a filled
  // row is far easier to correct than an empty one is to complete.
  windows.push({ days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" });
  renderSchedule();
});

el("schedList").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) { windows.splice(Number(del.dataset.del), 1); renderSchedule(); return; }
  const day = e.target.closest("[data-d]");
  if (!day) return;
  const w = windows[Number(day.dataset.w)];
  const d = Number(day.dataset.d);
  if (!w) return;
  const at = w.days.indexOf(d);
  if (at >= 0) w.days.splice(at, 1); else w.days.push(d);
  w.days.sort();
  renderSchedule();
});

el("schedList").addEventListener("change", (e) => {
  const inp = e.target.closest("input[type=time]");
  if (!inp) return;
  const w = windows[Number(inp.dataset.w)];
  if (!w) return;
  w[inp.dataset.k] = inp.value;
  renderSchedule();
});

async function load() {
  const d = await chrome.storage.local.get([
    "apiKey", "allowDomains", "blockDomains", "mission", "schedule"
  ]);
  el("apiKey").value = d.apiKey || "";
  el("mission").value = d.mission || "";
  el("allowDomains").value = (d.allowDomains || []).join("\n");
  el("blockDomains").value = (d.blockDomains || []).join("\n");
  windows = Array.isArray(d.schedule) ? d.schedule.map(w => ({
    days: Array.isArray(w.days) ? w.days.slice() : [],
    from: w.from || "09:00",
    to: w.to || "17:00"
  })) : [];
  renderSchedule();
}

el("toggleKey").addEventListener("click", () => {
  const inp = el("apiKey");
  const showing = inp.type === "text";
  inp.type = showing ? "password" : "text";
  const btn = el("toggleKey");
  btn.textContent = showing ? "Show" : "Hide";
  // announce the new state, not just the next action, to assistive tech
  btn.setAttribute("aria-pressed", showing ? "false" : "true");
  btn.setAttribute("aria-label", showing ? "Show API key" : "Hide API key");
});

// Test the key on demand. The popup no longer reports a healthy AI, so this is
// where you come to ask — and asking on purpose is the only time the answer is
// worth the API call it costs on a free tier.
//
// The key in the box is saved first: testing what is typed rather than what was
// last saved is the whole point of the button, and the worker reads the key
// from storage.
el("testKey").addEventListener("click", async () => {
  const btn = el("testKey"), msg = el("testKeyMsg");
  const typed = el("apiKey").value.trim();
  msg.className = "key-msg";
  if (!typed) {
    msg.classList.add("bad");
    msg.textContent = "Paste a key first.";
    return;
  }
  btn.disabled = true;
  msg.textContent = "Checking…";
  try {
    await chrome.storage.local.set({ apiKey: typed });
    // Force a real call rather than a cached verdict — a button that answers
    // from a five-minute-old cache isn't a test.
    chrome.runtime.sendMessage({ type: "aiStatus", fresh: true }, resp => {
      btn.disabled = false;
      msg.className = "key-msg";
      if (chrome.runtime.lastError || !resp) {
        msg.classList.add("bad");
        msg.textContent = "Couldn't reach the extension — reload and retry.";
        return;
      }
      if (resp.state === "ok") {
        msg.classList.add("ok");
        msg.textContent = "Working — " + (resp.provider === "groq" ? "Groq" : "OpenRouter") + " answered.";
      } else if (resp.state === "nokey") {
        msg.classList.add("bad");
        msg.textContent = "No key saved.";
      } else {
        msg.classList.add("bad");
        msg.textContent = resp.err || "Failed.";
      }
    });
  } catch (e) {
    btn.disabled = false;
    msg.classList.add("bad");
    msg.textContent = "Couldn't save the key.";
  }
});

el("save").addEventListener("click", async () => {
  const allowDomains = el("allowDomains").value.split("\n").map(cleanDomain).filter(Boolean);
  // Allow wins over block, as the field says. Resolved here, on the way in, so
  // the classifier never has to hold the tie-break rule — and so the user sees
  // the contradiction removed from the box rather than being told about it.
  const blockDomains = el("blockDomains").value.split("\n").map(cleanDomain)
    .filter(Boolean)
    .filter(d => !allowDomains.includes(d));

  // Only windows that are actually usable: at least one day, and two valid
  // times that aren't identical. A half-filled row is dropped rather than
  // saved as something that silently never matches.
  const schedule = windows.filter(w =>
    Array.isArray(w.days) && w.days.length &&
    /^\d{2}:\d{2}$/.test(w.from) && /^\d{2}:\d{2}$/.test(w.to) &&
    w.from !== w.to
  );

  await chrome.storage.local.set({
    apiKey: el("apiKey").value.trim(),
    mission: el("mission").value.trim(),
    allowDomains,
    blockDomains,
    schedule
  });
  // reflect the cleaned values back so the user sees what was stored
  el("allowDomains").value = allowDomains.join("\n");
  el("blockDomains").value = blockDomains.join("\n");
  windows = schedule;
  renderSchedule();
  // The worker remembers whether the AI was reachable, to avoid spending a call
  // every time the popup opens. Saving here is the one moment that answer is
  // worth discarding — the key may be new, or the same key may have just been
  // fixed at the provider's end.
  try { chrome.runtime.sendMessage({ type: "settingsSaved" }); } catch (e) {}
  // cross-fade the resting hint out and the confirmation in, in place
  const m = el("savedMsg"), bar = el("actionsBar");
  m.classList.add("show");
  bar.classList.add("is-saved");
  setTimeout(() => { m.classList.remove("show"); bar.classList.remove("is-saved"); }, 1800);
});

el("resetToday").addEventListener("click", async () => {
  const { log } = await chrome.storage.local.get("log");
  const l = log || {};
  delete l[todayKey()];
  await chrome.storage.local.set({ log: l });
  const d = el("resetDone");
  d.classList.add("show");
  setTimeout(() => d.classList.remove("show"), 2000);
});

// ---------- press feedback ----------
// Same contract as the popup: highlight on pointerdown, release on up/cancel
// or when the pointer is dragged off the control.
(function pressFeedback() {
  const SEL = ".save, .ghost, .danger button, .prov";
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

load();
