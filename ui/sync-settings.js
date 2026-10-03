(async () => {
  const status = document.getElementById("syncStatus"), signIn = document.getElementById("syncSignIn");
  const signOut = document.getElementById("syncSignOut"), syncNow = document.getElementById("syncNow");
  const importRow = document.getElementById("syncImportRow"), importLocal = document.getElementById("syncImport");
  const phone = document.getElementById("syncPhone");
  const badge = document.getElementById("syncBadge"), account = document.getElementById("syncAccount");
  const recovery = document.getElementById("syncRecovery"), recover = document.getElementById("syncRecover");
  let current = null, busy = false;
  function paint(d) {
    current = d;
    const connected = !!d.email;
    const welcome = document.getElementById("accountWelcome");
    if (welcome) {
      welcome.textContent = connected ? "You're connected." : "Your focus, everywhere.";
      document.getElementById("accountIdentity").textContent = d.email || "One task list. Phone and browser.";
      document.getElementById("accountAvatar").textContent = connected ? d.email.charAt(0).toUpperCase() : "N.";
      document.getElementById("accountTasks").hidden = !connected;
    }
    if (recovery) {
      recovery.hidden = !connected || !d.recoverableCount;
      recover.disabled = busy;
      document.getElementById("syncRecoveryNote").textContent = `${d.recoverableCount || 0} local tasks are still saved on this device and aren't in this account.`;
    }
    signIn.hidden = connected || !d.configured;
    signIn.disabled = busy || !d.configured;
    signOut.hidden = !connected; syncNow.hidden = !connected;
    signOut.disabled = busy; syncNow.disabled = busy;
    importRow.hidden = connected || !d.configured;
    importLocal.disabled = busy;
    document.getElementById("syncDisconnectNote").hidden = !connected;
    if (d.mobileUrl) phone.href = d.mobileUrl;
    account.textContent = d.email || "Phone & browser";
    badge.textContent = connected ? (d.error ? "Needs attention" : "Connected") : "On this device";
    badge.classList.toggle("connected", connected && !d.error);
    status.classList.toggle("error", !!d.error);
    status.textContent = d.error || (!d.configured ? "Tasks are saved here. Google sync isn't available yet."
      : connected ? (d.lastSync ? "Last synced " + new Date(d.lastSync).toLocaleTimeString([], { hour:"numeric", minute:"2-digit" }) : "Ready to sync.")
      : "Sign in to sync tasks with your phone.");
  }
  async function run(action, args) {
    if (busy) return;
    busy = true;
    if (current) paint(current);
    status.classList.remove("error");
    status.textContent = action === "signIn" ? "Opening Google…" : "Updating…";
    let failure = "";
    try { current = await TaskClient.request(action, args); }
    catch (e) { failure = e.message; }
    finally {
      busy = false;
      if (current) paint(current);
      if (!failure && action === "recoverLocal") status.textContent = `${current.recovered} tasks restored on this device. Sync now to upload them.`;
      if (failure) { status.textContent = failure; status.classList.add("error"); }
    }
  }
  signIn.onclick = () => run("signIn", { importLocal: importLocal.checked });
  signOut.onclick = () => run("signOut");
  syncNow.onclick = () => run("sync");
  if (recover) recover.onclick = () => run("recoverLocal");
  document.getElementById("syncExport").onclick = async () => {
    try {
      const d = await TaskClient.read();
      const blob = new Blob([JSON.stringify({ format: "nice-try-tasks-v1", exportedAt: new Date().toISOString(), tasks: d.todos }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = "nice-try-tasks.json"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { status.textContent = e.message; }
  };
  try { paint(await TaskClient.request("status")); }
  catch (e) { badge.textContent = "Unavailable"; status.textContent = e.message; status.classList.add("error"); }
})();
