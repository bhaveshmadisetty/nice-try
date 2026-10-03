// The worker is the sole task writer. Each editor sends a base snapshot so a
// delayed save changes only what that editor touched.
const TaskSync = (() => {
  const C = NiceTryTasks;
  let queue = Promise.resolve(), running = null;
  const serial = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  async function state() {
    const d = await chrome.storage.local.get(["taskSpaces", "todos"]);
    if (d.taskSpaces) return d.taskSpaces;
    const s = { owner: "guest", spaces: { guest: C.migrate(d.todos || []) } };
    await chrome.storage.local.set({ taskMigrationBackup: d.todos || [], taskSpaces: s, todos: C.list(s.spaces.guest) });
    return s;
  }
  const persist = s => chrome.storage.local.set({ taskSpaces: s, todos: C.list(s.spaces[s.owner]) });
  async function read() {
    return serial(async () => {
      const s = await state(), todos = C.list(s.spaces[s.owner]);
      return { todos, base: C.copy(todos), owner: s.owner };
    });
  }
  async function save(todos, base, owner) {
    let changed = false;
    const result = await serial(async () => {
      const s = await state();
      if (owner !== s.owner) throw Error("The account changed. Reopen this task list before editing.");
      const previous = s.spaces[s.owner];
      const next = C.edit(previous, base, todos);
      changed = JSON.stringify(next) !== JSON.stringify(previous);
      if (changed) {
        s.spaces[s.owner] = next;
        await persist(s);
      }
      return { todos: C.list(s.spaces[s.owner]), owner: s.owner };
    });
    // Alarm survives worker suspension. Changes are durable before network work.
    if (changed && configured() && result.owner !== "guest") {
      await chrome.alarms.create("taskSyncSoon", { when: Date.now() + 3000 });
    }
    return result;
  }
  const configured = () => !!(NiceTrySyncConfig.firebase.apiKey && NiceTrySyncConfig.firebase.projectId && NiceTrySyncConfig.googleClientId);
  async function status() {
    const d = await chrome.storage.local.get(["taskSyncAuth", "taskSyncStatus"]);
    const recovery = await serial(async () => {
      const s = await state(), account = s.spaces[s.owner] || {};
      return s.owner === "guest" ? 0 : C.list(s.spaces.guest || {}).filter(t => !account[t.id]).length;
    });
    return { configured: configured(), email: d.taskSyncAuth?.email || "", ...d.taskSyncStatus,
      recoverableCount: recovery,
      redirectUrl: chrome.identity.getRedirectURL(), mobileUrl: NiceTrySyncConfig.mobileUrl };
  }
  async function recoverLocal() {
    const recovered = await serial(async () => {
      const s = await state();
      if (s.owner === "guest") throw Error("Sign in before adding local tasks to your account.");
      const records = s.spaces[s.owner] || {}, guest = s.spaces.guest || {};
      const missing = C.list(guest).filter(t => !records[t.id]);
      if (!missing.length) return 0;
      // Save task data only, before changing it. Existing edits and deletions win.
      await chrome.storage.local.set({ taskRecoveryBackup: { createdAt: Date.now(), taskSpaces: C.copy(s) } });
      for (const task of missing) records[task.id] = C.copy(guest[task.id]);
      s.spaces[s.owner] = records;
      await persist(s);
      return missing.length;
    });
    await chrome.alarms.create("taskSyncSoon", { when: Date.now() + 1000 });
    return { ...await status(), recovered };
  }
  async function authRequest(url, body, form = false) {
    const r = await fetch(url, { method: "POST", signal: AbortSignal.timeout(20000),
      headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" },
      body: form ? body.toString() : JSON.stringify(body) });
    if (!r.ok) throw Error("Google connection failed. Check Firebase configuration or sign in again.");
    return r.json();
  }
  async function token(auth) {
    if (auth.expiresAt > Date.now() + 60000) return auth.idToken;
    const d = await authRequest("https://securetoken.googleapis.com/v1/token?key=" + encodeURIComponent(NiceTrySyncConfig.firebase.apiKey),
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: auth.refreshToken }), true);
    if (d.user_id !== auth.uid) throw Error("The signed-in account changed. Please reconnect.");
    await serial(async () => {
      const current = (await chrome.storage.local.get("taskSyncAuth")).taskSyncAuth;
      if (current?.session !== auth.session) throw Error("The account changed during sync.");
      await chrome.storage.local.set({ taskSyncAuth: { ...auth, idToken: d.id_token,
        refreshToken: d.refresh_token, expiresAt: Date.now() + Number(d.expires_in) * 1000 } });
    });
    return d.id_token;
  }
  async function sync() {
    if (running) return running;
    running = (async () => {
      const auth = (await chrome.storage.local.get("taskSyncAuth")).taskSyncAuth;
      if (!auth || !configured()) return status();
      try {
        const snapshot = await serial(async () => C.copy(await state()));
        if (snapshot.owner !== auth.owner) return status();
        const result = await NiceTryCloud.sync(NiceTrySyncConfig.firebase.projectId, auth.uid,
          await token(auth), snapshot.spaces[snapshot.owner]);
        await serial(async () => {
          const currentAuth = (await chrome.storage.local.get("taskSyncAuth")).taskSyncAuth;
          if (currentAuth?.session !== auth.session) return;
          const current = await state();
          if (current.owner !== snapshot.owner) return;
          current.spaces[current.owner] = C.merge(current.spaces[current.owner], result.records);
          await persist(current);
          await chrome.storage.local.set({ taskSyncStatus: { lastSync: Date.now(),
            error: result.conflicts ? "Another device edited tasks. Sync again to finish merging." : "" } });
        });
      } catch (e) {
        await serial(async () => {
          const current = (await chrome.storage.local.get("taskSyncAuth")).taskSyncAuth;
          if (current?.session === auth.session) await chrome.storage.local.set({ taskSyncStatus: { error: e.message } });
        });
      }
      return status();
    })().finally(() => { running = null; });
    return running;
  }
  async function signIn(importLocal) {
    if (!configured()) throw Error("Google task sync needs the app's Firebase configuration first.");
    if ((await chrome.storage.local.get("taskSyncAuth")).taskSyncAuth) throw Error("Disconnect the current account before signing in again.");
    const redirect = chrome.identity.getRedirectURL();
    const nonce = crypto.randomUUID(), stateValue = crypto.randomUUID();
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: NiceTrySyncConfig.googleClientId,
      redirect_uri: redirect, response_type: "id_token", scope: "openid email profile",
      state: stateValue, nonce, prompt: "select_account" }).toString();
    const callback = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
    if (!callback) throw Error("Google sign-in was cancelled.");
    const returned = new URL(callback);
    if (returned.origin !== new URL(redirect).origin || returned.pathname !== new URL(redirect).pathname) throw Error("Unexpected sign-in redirect.");
    const params = new URLSearchParams(returned.hash.slice(1));
    const googleToken = params.get("id_token");
    if (params.get("state") !== stateValue || !googleToken) throw Error("Google sign-in did not complete.");
    const segment = googleToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(segment.padEnd(Math.ceil(segment.length / 4) * 4, "=")));
    if (claims.nonce !== nonce) throw Error("The sign-in response did not match this request.");
    // Firebase verifies Google's token signature and audience; decoded claims alone are never trusted.
    const d = await authRequest("https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=" + encodeURIComponent(NiceTrySyncConfig.firebase.apiKey),
      { postBody: new URLSearchParams({ id_token: googleToken, providerId: "google.com" }).toString(),
        requestUri: redirect, returnSecureToken: true });
    if (!d.localId || !d.idToken || !d.refreshToken) throw Error("Firebase did not return a complete session.");
    const owner = NiceTrySyncConfig.firebase.projectId + ":" + d.localId;
    await serial(async () => {
      const s = await state();
      if (s.owner !== "guest") throw Error("Another account connected during sign-in.");
      const records = s.spaces[owner] || {};
      // This checkbox is explicit upload consent. Restoring an account never
      // silently imports a different account's tasks.
      s.spaces[owner] = importLocal ? C.merge(records, s.spaces.guest) : records;
      s.owner = owner;
      await chrome.storage.local.set({ taskSyncAuth: { owner, uid: d.localId, email: d.email || "Google account",
        session: crypto.randomUUID(), idToken: d.idToken, refreshToken: d.refreshToken,
        expiresAt: Date.now() + Number(d.expiresIn) * 1000 }, taskSyncStatus: {} });
      await persist(s);
    });
    await chrome.alarms.create("taskSyncPeriodic", { periodInMinutes: 1 });
    return sync();
  }
  async function signOut() {
    await serial(async () => {
      const s = await state();
      s.owner = "guest";
      await chrome.storage.local.remove("taskSyncAuth");
      await chrome.storage.local.set({ taskSyncStatus: {} });
      await persist(s);
    });
    await chrome.alarms.clear("taskSyncPeriodic");
    return status();
  }
  chrome.alarms.onAlarm.addListener(alarm => {
    if (["taskSyncSoon", "taskSyncPeriodic"].includes(alarm.name)) sync().catch(() => {});
  });
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg?.type?.startsWith("taskStore:")) return;
    if (!sender.url?.startsWith(chrome.runtime.getURL("ui/"))) {
      reply({ ok: false, error: "Only Nice Try's own pages can manage task sync." }); return;
    }
    const actions = {
      "taskStore:read": read,
      "taskStore:save": () => save(msg.todos, msg.base, msg.owner),
      "taskStore:status": status,
      "taskStore:signIn": () => signIn(msg.importLocal === true),
      "taskStore:signOut": signOut,
      "taskStore:recoverLocal": recoverLocal,
      "taskStore:sync": sync
    };
    const action = actions[msg.type];
    if (!action) return;
    action().then(value => reply({ ok: true, ...value }), e => reply({ ok: false, error: e.message }));
    return true;
  });
  return { read, save };
})();
