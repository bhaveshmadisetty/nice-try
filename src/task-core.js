// Shared task protocol. Keep mobile/lib/task-core.js identical (tested).
(function (root) {
  const copy = value => JSON.parse(JSON.stringify(value));
  const id = () => crypto.randomUUID();
  const validId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
    && !["__proto__", "constructor", "prototype"].includes(value);
  function task(value) {
    const t = typeof value === "string" ? { text: value, done: false } : copy(value);
    if (!t || typeof t.text !== "string" || !t.text.trim()) throw Error("A task needs text.");
    if (JSON.stringify(t).length > 16000) throw Error("This task is too large to sync.");
    if (!validId(t.id)) t.id = id();
    return t;
  }
  function record(t, previous, deleted = false) {
    return { id: t.id, data: JSON.stringify(t), deleted,
      updatedAt: Math.max(Date.now(), (previous?.updatedAt || 0) + 1), changeId: id() };
  }
  function valid(r) {
    if (!r || !validId(r.id) || !validId(r.changeId) || typeof r.deleted !== "boolean" ||
        !Number.isSafeInteger(r.updatedAt) || r.updatedAt < 0 || typeof r.data !== "string" || r.data.length > 16000) return false;
    try { const t = JSON.parse(r.data); return t.id === r.id && typeof t.text === "string" && !!t.text.trim(); }
    catch { return false; }
  }
  function newer(a, b) {
    if (!b) return true;
    // Deletion wins over edits of the same identity, even from a device whose
    // clock is ahead. Recreating a task gives it a new identity.
    if (a.deleted !== b.deleted) return a.deleted;
    return a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.changeId > b.changeId);
  }
  function merge(a, b) {
    const out = copy(a || {});
    for (const r of Object.values(b || {})) if (valid(r) && newer(r, out[r.id])) out[r.id] = copy(r);
    return out;
  }
  function list(records) {
    return Object.values(records || {}).filter(r => valid(r) && !r.deleted).map(r => JSON.parse(r.data))
      .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.id.localeCompare(b.id));
  }
  function migrate(raw) {
    const out = {};
    for (const [i, value] of (raw || []).entries()) {
      const t = task(value);
      if (out[t.id]) t.id = id();
      if (!Number.isFinite(t.rank)) t.rank = (i + 1) * 1024;
      out[t.id] = record(t);
    }
    return out;
  }
  // Apply only fields this editor changed. A stale editor cannot delete tasks
  // it never saw, overwrite unrelated remote fields, or resurrect a deletion.
  function edit(records, base, desired) {
    const out = copy(records);
    const before = new Map(base.map(t => [t.id, t]));
    const after = new Map(desired.map(value => { const t = task(value); return [t.id, t]; }));
    for (const old of base) {
      if (!after.has(old.id) && out[old.id] && !out[old.id].deleted) {
        out[old.id] = record(JSON.parse(out[old.id].data), out[old.id], true);
      }
    }
    for (const t of after.values()) {
      const old = before.get(t.id), current = out[t.id];
      if (current?.deleted) continue;
      if (!old) {
        if (!current) out[t.id] = record(t);
        continue;
      }
      if (!current) continue;
      const next = JSON.parse(current.data);
      for (const k of new Set([...Object.keys(old), ...Object.keys(t)])) {
        if (k === "id" || ["__proto__", "constructor", "prototype"].includes(k)) continue;
        if (JSON.stringify(old[k]) !== JSON.stringify(t[k])) {
          if (t[k] === undefined) delete next[k]; else next[k] = t[k];
        }
      }
      if (JSON.stringify(next) !== current.data) out[t.id] = record(next, current);
    }
    return out;
  }
  root.NiceTryTasks = { copy, task, record, valid, newer, merge, list, migrate, edit };
  if (typeof module !== "undefined") module.exports = root.NiceTryTasks;
})(globalThis);
