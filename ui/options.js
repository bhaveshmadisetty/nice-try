// options.js — settings page: API key, allowed sites, reset data.

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
  const d = await chrome.storage.local.get(["apiKey", "allowDomains"]);
  el("apiKey").value = d.apiKey || "";
  el("allowDomains").value = (d.allowDomains || []).join("\n");
}

el("toggleKey").addEventListener("click", () => {
  const inp = el("apiKey");
  const showing = inp.type === "text";
  inp.type = showing ? "password" : "text";
  el("toggleKey").textContent = showing ? "Show" : "Hide";
});

el("save").addEventListener("click", async () => {
  const allowDomains = el("allowDomains").value.split("\n").map(cleanDomain).filter(Boolean);
  await chrome.storage.local.set({
    apiKey: el("apiKey").value.trim(),
    allowDomains
  });
  // reflect the cleaned domains back so the user sees what was stored
  el("allowDomains").value = allowDomains.join("\n");
  const m = el("savedMsg");
  m.classList.add("show");
  setTimeout(() => m.classList.remove("show"), 1800);
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

load();
