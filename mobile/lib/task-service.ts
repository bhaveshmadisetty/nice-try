"use client";
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import config from "./sync-config.json";
import "./task-core.js";
import "./task-cloud.js";

export type Task = { id: string; text: string; done: boolean; date?: string; doneDate?: string; rank?: number; url?: string; [key: string]: unknown };
type RecordData = { id: string; data: string; deleted: boolean; updatedAt: number; changeId: string };
type Records = Record<string, RecordData>;
type Core = { list(r: Records): Task[]; merge(a: Records, b: Records): Records;
  edit(r: Records, b: Task[], n: Task[]): Records; migrate(t: Partial<Task>[]): Records; valid(r: unknown): boolean };
const C = (globalThis as unknown as { NiceTryTasks: Core }).NiceTryTasks;
const cloud = (globalThis as unknown as { NiceTryCloud: { sync(p: string, u: string, t: string, r: Records): Promise<{ records: Records; conflicts: number }> } }).NiceTryCloud;
export const configured = !!(config.apiKey && config.projectId && config.authDomain);
export type View = { tasks: Task[]; email: string; status: string; ready: boolean; busy: boolean; owner: string; recoverableCount: number };
let view: View = { tasks: [], email: "", status: "Opening your tasks…", ready: false, busy: false, owner: "guest", recoverableCount: 0 };
let user: User | null = null, owner = "guest", generation = 0, importOnLogin = false;
let auth: ReturnType<typeof getAuth> | null = null, syncing: Promise<void> | null = null;
const listeners = new Set<(view: View) => void>();
const storageKey = (space = owner) => "nice-try.tasks.v1:" + space;
function load(space = owner): Records {
  const raw = localStorage.getItem(storageKey(space));
  if (!raw) return {};
  const records = JSON.parse(raw);
  if (!records || typeof records !== "object" || Array.isArray(records) || Object.values(records).some(r => !C.valid(r)))
    throw Error("Saved task data could not be read. Export or recover it before making changes.");
  return records;
}
function emit(next: Partial<View> = {}) {
  let recoverableCount = 0;
  const currentOwner = next.owner || owner;
  if (currentOwner !== "guest") {
    try {
      const existing = load(currentOwner);
      recoverableCount = C.list(load("guest")).filter(task => !existing[task.id]).length;
    } catch {}
  }
  view = { ...view, ...next, owner, recoverableCount };
  for (const fn of listeners) fn(view);
}
function persist(records: Records) {
  localStorage.setItem(storageKey(), JSON.stringify(records));
  emit({ tasks: C.list(records) });
}
async function exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
  if (navigator.locks) return await navigator.locks.request("nice-try-task-write", async () => await fn());
  return await fn();
}
export function subscribe(fn: (view: View) => void) { listeners.add(fn); fn(view); return () => { listeners.delete(fn); }; }
let started = false;
export async function start() {
  if (started) return;
  started = true;
  try {
    emit({ tasks: C.list(load()), ready: !configured,
      status: configured ? "Checking your account…" : "Saved on this phone · Google sync not configured yet" });
    if (configured) {
      auth = getAuth(initializeApp(config));
      onAuthStateChanged(auth, async next => {
        const epoch = ++generation;
        user = next; owner = next ? config.projectId + ":" + next.uid : "guest";
        try {
          await exclusive(() => {
            if (epoch !== generation) return;
            let records = load();
            if (next && importOnLogin) records = C.merge(records, load("guest"));
            importOnLogin = false;
            persist(records);
          });
          if (epoch !== generation) return;
          emit({ email: next?.email || "", ready: true, busy: false,
            status: next ? "Ready to sync" : "Saved on this phone" });
          if (next) void sync();
        } catch (e) { emit({ ready: false, status: (e as Error).message }); }
      });
    }
    window.addEventListener("storage", e => {
      if (e.key === storageKey()) {
        try { emit({ tasks: C.list(load()) }); } catch (err) { emit({ ready: false, status: (err as Error).message }); }
      }
    });
    window.addEventListener("online", () => { void sync(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) void sync(); });
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").then(async () => {
        const registration = await navigator.serviceWorker.ready;
        registration.active?.postMessage({ type: "CACHE_SHELL", urls: performance.getEntriesByType("resource").map(r => r.name) });
      }).catch(() => {});
    }
  } catch (e) { emit({ ready: false, status: (e as Error).message }); }
}
export async function save(base: Task[], desired: Task[], expectedOwner: string) {
  if (!view.ready || expectedOwner !== owner) throw Error("The account changed. Reopen the task and try again.");
  const changed = await exclusive(() => {
    if (expectedOwner !== owner) throw Error("The account changed.");
    const previous = load(), next = C.edit(previous, base, desired);
    if (JSON.stringify(previous) === JSON.stringify(next)) return false;
    persist(next);
    emit({ status: user ? "Saved here · waiting to sync" : "Saved on this phone" });
    return true;
  });
  if (changed) void sync();
}
export async function connect(importLocal: boolean) {
  if (!auth) throw Error("Google sync needs the app's Firebase configuration first.");
  importOnLogin = importLocal;
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) {
    importOnLogin = false;
    const code = (e as {code?: string}).code;
    const messages: Record<string,string> = {
      "auth/popup-closed-by-user": "Sign-in cancelled. Try again when you are ready.",
      "auth/popup-blocked": "Allow the Google sign-in popup, then try again.",
      "auth/network-request-failed": "Check your connection and try again.",
      "auth/unauthorized-domain": "Sign-in is not enabled for this address yet."
    };
    throw Error(messages[code || ""] || "Google sign-in could not finish. Please try again.");
  }
}
export async function disconnect() {
  if (auth) await signOut(auth);
}
export async function recoverGuestTasks() {
  if (!user || owner === "guest") throw Error("Sign in before restoring this phone's tasks.");
  const expectedOwner = owner, expectedGeneration = generation;
  const recovered = await exclusive(() => {
    if (!user || owner !== expectedOwner || generation !== expectedGeneration) throw Error("The account changed. Try restoring again.");
    const account = load(expectedOwner), guest = load("guest");
    const missing = C.list(guest).filter(task => !account[task.id]);
    if (!missing.length) return 0;
    localStorage.setItem("nice-try.task-recovery-backup:" + expectedOwner,
      JSON.stringify({ createdAt: new Date().toISOString(), account, guest }));
    for (const task of missing) account[task.id] = structuredClone(guest[task.id]);
    persist(account);
    emit({ status: "Restored " + missing.length + " local task" + (missing.length === 1 ? "" : "s") + " ? syncing" });
    return missing.length;
  });
  if (recovered) void sync();
  return recovered;
}
export async function sync() {
  if (!user) return;
  if (syncing) return syncing;
  const currentUser = user, epoch = generation, currentOwner = owner;
  syncing = (async () => {
    emit({ busy: true, status: navigator.onLine ? "Syncing…" : "Offline · changes saved on this phone" });
    try {
      if (!navigator.onLine) return;
      const records = load();
      const result = await cloud.sync(config.projectId, currentUser.uid, await currentUser.getIdToken(), records);
      await exclusive(() => {
        if (generation !== epoch || owner !== currentOwner) return;
        const latest = load();
        const changedDuringSync = JSON.stringify(latest) !== JSON.stringify(records);
        const merged = C.merge(latest, result.records);
        if (JSON.stringify(merged) !== JSON.stringify(latest)) persist(merged);
        emit({ status: result.conflicts || changedDuringSync ? "Saved here · another sync is needed" : "Synced " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
        if (changedDuringSync || result.conflicts) setTimeout(() => { void sync(); }, 3000);
      });
    } catch (e) { if (epoch === generation) emit({ status: (e as Error).message }); }
    finally { if (epoch === generation) emit({ busy: false }); }
  })().finally(() => { syncing = null; });
  return syncing;
}
export function exportTasks() {
  return JSON.stringify({ format: "nice-try-tasks-v1", exportedAt: new Date().toISOString(), tasks: view.tasks }, null, 2);
}
export async function importTasks(text: string) {
  const data = JSON.parse(text);
  if (data.format !== "nice-try-tasks-v1" || !Array.isArray(data.tasks) || data.tasks.length > 5000) throw Error("Choose a Nice Try task export (up to 5,000 tasks).");
  const tasks = C.list(C.migrate(data.tasks));
  const existing = new Set(view.tasks.map(t => t.id));
  await save(view.tasks, [...view.tasks, ...tasks.filter(t => !existing.has(t.id))], owner);
}
