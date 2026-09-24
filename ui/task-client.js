const TaskClient = (() => {
  let base = [], owner = "guest";
  async function request(type, args = {}) {
    const result = await chrome.runtime.sendMessage({ type: "taskStore:" + type, ...args });
    if (!result?.ok) throw Error(result?.error || "Reload Nice Try to update the task service.");
    return result;
  }
  async function read() {
    const d = await request("read");
    base = structuredClone(d.todos); owner = d.owner;
    return d;
  }
  async function save(todos) {
    // Identity must exist before the first async boundary, including rapid adds.
    for (const t of todos) if (t && typeof t === "object" && !t.id) t.id = crypto.randomUUID();
    const d = await request("save", { todos, base, owner });
    base = structuredClone(d.todos); owner = d.owner;
    return d.todos;
  }
  return { read, save, request };
})();
