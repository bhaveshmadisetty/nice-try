const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const extensionRoot = require("../extension-root.cjs");
const test = require("node:test");
const vm = require("node:vm");

const root = extensionRoot;
const worker = fs.readFileSync(path.join(root, "src/background.js"), "utf8");
const popup = fs.readFileSync(path.join(root, "ui/popup.js"), "utf8");

function between(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `could not locate ${start}`);
  return source.slice(a, b);
}

test("worker grants one free row pause and rejects later or over-budget requests", async () => {
  const handler = between(worker, '  if (msg.type === "pauseFor") {',
    '  // Why the tool is not running');
  async function request(ctx, source = "row", busy = false) {
    const effects = [];
    let reply;
    const answered = new Promise(resolve => { reply = resolve; });
    const scope = {
      msg: { type: "pauseFor", source, minutes: 30, reason: "tired" },
      pauseForBusy: busy,
      sendResponse: value => reply(value),
      loadSession: async () => {}, sessionActive: () => false,
      pauseCtx: async () => ctx, loadPause: async () => {},
      pausedUntil: 0, pauseKind: "", lastTickTs: 0,
      persistPause: () => effects.push("persist"),
      openDown: async () => effects.push("downtime"),
      updatePauseBadge: () => {}, resetStreak: () => {},
      logPause: async () => {}, noteFreePause: async () => effects.push("ledger"),
      log: () => {}, clearHeadsUp: async () => {},
      pauseLeftMs: () => 0
    };
    vm.runInNewContext(`(function () { ${handler} })()`, scope);
    return { result: await answered, effects };
  }

  const first = await request({ freesToday: 0, overBudget: false });
  assert.equal(first.result.ok, true);
  assert.deepEqual(first.effects, ["persist", "downtime", "ledger"]);

  for (const ctx of [
    { freesToday: 1, overBudget: false },
    { freesToday: 0, overBudget: true }
  ]) {
    const denied = await request(ctx);
    assert.equal(denied.result.ok, false);
    assert.equal(denied.result.reason, "budget");
    assert.deepEqual(denied.effects, []);
  }

  const noSource = await request({ freesToday: 1, overBudget: false }, "");
  assert.equal(noSource.result.reason, "budget");
  assert.deepEqual(noSource.effects, []);

  const concurrent = await request({ freesToday: 0, overBudget: false }, "row", true);
  assert.equal(concurrent.result.reason, "busy");
  assert.deepEqual(concurrent.effects, []);
});

test("all four free-row answer paths identify themselves to the worker", () => {
  const handlers = between(popup, 'el("pwSkip").addEventListener',
    '// ---------- press feedback ----------');
  const listeners = new Map();
  const sent = [];
  const elements = new Map();
  for (const id of ["pwSkip", "pwGo", "pwChips", "pauseReason"]) {
    elements.set(id, {
      value: "typed reason",
      addEventListener(event, fn) { listeners.set(`${id}:${event}`, fn); }
    });
  }
  vm.runInNewContext(handlers, {
    el: id => elements.get(id), pendingPauseMins: 30,
    pauseFor: (...args) => sent.push(args)
  });
  listeners.get("pwSkip:click")();
  listeners.get("pwGo:click")();
  listeners.get("pwChips:click")({ target: {
    closest: () => ({ dataset: { r: "tired" } })
  } });
  let prevented = false;
  listeners.get("pauseReason:keydown")({ key: "Enter", preventDefault() { prevented = true; } });

  assert.equal(prevented, true);
  assert.deepEqual(sent, [
    [30, "", "row"],
    [30, "typed reason", "row"],
    [30, "tired", "row"],
    [30, "typed reason", "row"]
  ]);
});
