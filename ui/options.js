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

async function load() {
  const d = await chrome.storage.local.get(["apiKey", "allowDomains", "mission"]);
  el("apiKey").value = d.apiKey || "";
  el("mission").value = d.mission || "";
  el("allowDomains").value = (d.allowDomains || []).join("\n");
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

el("save").addEventListener("click", async () => {
  const allowDomains = el("allowDomains").value.split("\n").map(cleanDomain).filter(Boolean);
  await chrome.storage.local.set({
    apiKey: el("apiKey").value.trim(),
    mission: el("mission").value.trim(),
    allowDomains
  });
  // reflect the cleaned domains back so the user sees what was stored
  el("allowDomains").value = allowDomains.join("\n");
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
