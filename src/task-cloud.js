// Firestore REST transport shared with the phone app. Authentication is supplied
// by each host. Conditional writes prevent a stale read from replacing a newer write.
(function (root) {
  async function json(url, token, options = {}) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000),
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } });
    if (response.status === 409 || response.status === 412 || response.status === 400) {
      const data = await response.json().catch(() => ({}));
      if (["FAILED_PRECONDITION", "ALREADY_EXISTS", "ABORTED"].includes(data.error?.status)) return { conflict: true };
    }
    if (!response.ok) {
      if (response.status === 401) throw Error("Sign in again to reconnect task sync.");
      if (response.status === 403) throw Error("Task sync access denied. Check the deployed Firestore rules.");
      if (response.status === 429) throw Error("Task sync quota reached. Your changes remain on this device.");
      throw Error("Task sync could not connect (HTTP " + response.status + "). Your changes remain on this device.");
    }
    return response.json();
  }
  function decode(doc) {
    const f = doc.fields || {};
    const r = { id: f.id?.stringValue, data: f.data?.stringValue, deleted: f.deleted?.booleanValue,
      updatedAt: Number(f.updatedAt?.integerValue), changeId: f.changeId?.stringValue };
    if (!root.NiceTryTasks.valid(r)) throw Error("An invalid cloud task was found. Local tasks were kept.");
    return r;
  }
  const fields = r => ({ id: { stringValue: r.id }, data: { stringValue: r.data },
    deleted: { booleanValue: r.deleted }, updatedAt: { integerValue: String(r.updatedAt) }, changeId: { stringValue: r.changeId } });
  async function sync(projectId, uid, token, local) {
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId) || !uid) throw Error("Configure a valid Firebase project first.");
    const base = "https://firestore.googleapis.com/v1/projects/" + projectId +
      "/databases/(default)/documents/users/" + encodeURIComponent(uid) + "/tasks";
    const remote = {}, versions = {};
    let page = "";
    do {
      const data = await json(base + "?pageSize=300" + (page ? "&pageToken=" + encodeURIComponent(page) : ""), token);
      for (const doc of data.documents || []) {
        const r = decode(doc); remote[r.id] = r; versions[r.id] = doc.updateTime;
      }
      page = data.nextPageToken || "";
    } while (page);
    const merged = root.NiceTryTasks.merge(local, remote);
    let conflicts = 0;
    for (const r of Object.values(merged)) {
      if (!root.NiceTryTasks.newer(r, remote[r.id])) continue;
      const precondition = versions[r.id] ? "currentDocument.updateTime=" + encodeURIComponent(versions[r.id]) : "currentDocument.exists=false";
      const data = await json(base + "/" + encodeURIComponent(r.id) + "?" + precondition, token,
        { method: "PATCH", body: JSON.stringify({ fields: fields(r) }) });
      if (data.conflict) conflicts++;
    }
    return { records: merged, conflicts };
  }
  root.NiceTryCloud = { sync };
  if (typeof module !== "undefined") module.exports = root.NiceTryCloud;
})(globalThis);
