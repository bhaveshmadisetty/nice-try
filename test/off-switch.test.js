const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const extensionRoot = require("../extension-root.cjs");
const test = require("node:test");
const vm = require("node:vm");

const popup = fs.readFileSync(path.join(extensionRoot, "ui/popup.js"), "utf8");
const start = popup.indexOf("// ---------- the off-switch intercept ----------");
const end = popup.indexOf('// ---------- "it isn\'t running" banner ----------', start);
assert.ok(start >= 0 && end > start);
const code = popup.slice(start, end);

function element(dataset = {}) {
  const listeners = new Map();
  const classes = new Set();
  return {
    dataset, listeners, children: [], hidden: true, disabled: false,
    textContent: "", checked: true, offsetHeight: 100,
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }
    },
    addEventListener: (event, fn) => listeners.set(event, fn),
    replaceChildren(...children) { this.children = children; },
    appendChild(child) { this.children.push(child); }
  };
}

test("switch offers a bounded free pause, priced pauses, and confirmed manual off", async () => {
  const ids = ["offSheet", "sheetOff", "sheetN", "sheetWarn", "sheetMsg", "enabled"];
  const els = new Map(ids.map(id => [id, element()]));
  const buttons = [10, 30, 60].map(mins => element({
    item: `pause${mins}`, mins: String(mins)
  }));
  const messages = [];
  const writes = [];
  const rendered = [];
  let wallet = { streak: 0, balance: 20, store: [
    { id: "pause10", price: 4 }, { id: "pause30", price: 14 },
    { id: "pause60", price: 30 }
  ] };
  let downtime = { today: { frees: 0, total: 0 }, budgetMin: 60 };
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, reply) {
        messages.push(msg);
        if (msg.type === "wallet") reply(wallet);
        else if (msg.type === "downtime") reply(downtime);
        else reply({ ok: true, pausedUntil: 123456789 });
      }
    },
    storage: { local: { async set(value) { writes.push(value); } } }
  };
  vm.runInNewContext(code, {
    el: id => els.get(id), chrome, lastWallet: null, lastDown: null,
    document: {
      querySelectorAll: selector => selector === ".sheet-opt" ? buttons : [],
      createTextNode: text => ({ textContent: text }),
      createElement: () => element()
    },
    requestAnimationFrame: fn => fn(), setTimeout: () => {},
    renderPause: (...args) => rendered.push(args),
    loadWallet: () => {}, setStatus: () => {}, checkOffState: () => {}
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const switchOff = async () => {
    els.get("enabled").checked = false;
    await els.get("enabled").listeners.get("change")();
    await flush();
  };

  await switchOff();
  assert.equal(els.get("enabled").checked, true);
  assert.equal(els.get("offSheet").hidden, false);
  assert.equal(els.get("sheetN").textContent, "Take a break");
  assert.equal(buttons[0].children[1].textContent, "Free today");
  buttons[0].listeners.get("click")();
  assert.equal(messages.at(-1).type, "pauseFor");
  assert.equal(messages.at(-1).minutes, 10);
  assert.equal(messages.at(-1).source, "row");
  assert.equal(rendered.at(-1)[1], "free");
  assert.deepEqual(writes, []);

  downtime = { today: { frees: 1, total: 600 }, budgetMin: 60 };
  await switchOff();
  assert.equal(buttons[0].children[1].textContent, "4 coins");
  assert.equal(buttons[2].disabled, true);
  buttons[1].listeners.get("click")();
  assert.equal(messages.at(-1).type, "buyPause");
  assert.equal(messages.at(-1).itemId, "pause30");
  assert.equal(rendered.at(-1)[1], "bought");

  wallet = { ...wallet, balance: 0 };
  await switchOff();
  assert.ok(buttons.every(b => b.disabled));
  await els.get("sheetOff").listeners.get("click")();
  assert.deepEqual(writes, []);
  assert.equal(els.get("sheetOff").textContent, "Confirm: turn off indefinitely");
  await els.get("sheetOff").listeners.get("click")();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].enabled, false);
});
