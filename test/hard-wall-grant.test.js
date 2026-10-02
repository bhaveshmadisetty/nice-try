const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const extensionRoot = require("../extension-root.cjs");
const test = require("node:test");
const vm = require("node:vm");

const worker = fs.readFileSync(path.join(extensionRoot, "src/background.js"), "utf8");

function between(start, end) {
  const a = worker.indexOf(start);
  const b = worker.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `missing ${start}`);
  return worker.slice(a, b);
}

const identityCode = between("function linkIdentity(url) {",
  "// Hosts that identify a page by query param");
const identityScope = { URL, ID_PARAM_HOSTS: {} };
vm.runInNewContext(identityCode, identityScope);
const linkIdentity = identityScope.linkIdentity;
const hostOf = url => new URL(url).hostname.replace(/^www\./, "");

test("hard-wall approval grants only the real blocked tab and page", async () => {
  const handler = between('  if (msg.type === "grantAccess") {',
    '  // "This was flagged by mistake"');
  async function request({ tier = "hard", legit = true, session = false,
                           senderUrl = "https://www.youtube.com/watch?v=one",
                           tabUrl = senderUrl, mark = true } = {}) {
    const pageGrants = new Map();
    const lockedTabs = new Map();
    if (mark) lockedTabs.set(7, { host: "youtube.com", tier, title: "Video one" });
    const access = [];
    let answer;
    const replied = new Promise(resolve => { answer = resolve; });
    const scope = {
      msg: { type: "grantAccess", legit },
      sender: { tab: { id: 7 }, url: senderUrl },
      sendResponse: answer,
      locksReady: Promise.resolve(), loadSession: async () => {},
      loadPageGrants: async () => {}, sessionActive: () => session,
      pageGrants, lockedTabs, linkIdentity, hostOf, GRANT_MS: 180000,
      chrome: { tabs: { get: async () => ({ url: tabUrl, title: "Video one" }) } },
      persistPageGrants: async () => {}, persistLocks: () => {},
      resetStreak: () => {},
      activePageGrantUntil: 0, updatePauseBadge: () => {},
      recordAccess: async (...args) => access.push(args), log: () => {},
      pausedUntil: 0,
      persistPause: () => { throw new Error("global pause written"); },
      rememberVerdict: () => { throw new Error("title cached"); }
    };
    vm.runInNewContext(`(function () { ${handler} })()`, scope);
    return { result: await replied, pageGrants, lockedTabs, access, scope };
  }

  const approved = await request();
  assert.equal(approved.result.ok, true);
  assert.equal(approved.scope.pausedUntil, 0);
  assert.equal(approved.lockedTabs.size, 0);
  assert.equal(approved.pageGrants.get(7).id, "youtube.com/watch?v=one");
  assert.equal(approved.pageGrants.get(7).legit, true);
  assert.equal(approved.access[0][2], "answers");

  const forced = await request({ legit: false });
  assert.equal(forced.pageGrants.get(7).legit, false);
  assert.equal(forced.access[0][2], "typing");

  for (const denied of [
    { mark: false }, { tier: "medium" }, { session: true },
    { tabUrl: "https://www.youtube.com/watch?v=two" }
  ]) {
    const r = await request(denied);
    assert.equal(r.result.ok, false);
    assert.equal(r.pageGrants.size, 0);
  }
});

test("page grant cannot follow another tab or video and expires", () => {
  const code = between("function pageGrantFor(tabId, url) {", "let pausedUntil = 0;");
  const pageGrants = new Map([[7, {
    id: "youtube.com/watch?v=one", until: Date.now() + 180000, legit: true
  }]]);
  let writes = 0;
  const scope = { pageGrants, linkIdentity,
    persistPageGrants: () => { writes++; } };
  vm.runInNewContext(code, scope);
  const one = "https://www.youtube.com/watch?v=one";
  assert.equal(scope.pageGrantFor(8, one), null);
  assert.equal(scope.pageGrantFor(7, one).legit, true);
  assert.equal(scope.pageGrantFor(7, "https://www.youtube.com/watch?v=two"), null);
  assert.equal(pageGrants.size, 0);
  assert.equal(writes, 1);
  pageGrants.set(7, { id: "youtube.com/watch?v=one", until: Date.now() - 1, legit: true });
  assert.equal(scope.pageGrantFor(7, one), null);
  assert.equal(writes, 2);
});

test("answer judge asks for a concrete connection to this page", async () => {
  const code = between("async function aiJudgeAnswers(",
    "// Generate ONE pointed, personal justification question");
  const prompts = [];
  const scope = {
    log: () => {},
    aiChat: async prompt => { prompts.push(prompt); return '{"pass":true,"reason":"specific lesson"}'; }
  };
  vm.runInNewContext(code, scope);
  const verdict = await scope.aiJudgeAnswers("Sorting lesson", ["Why?"],
    ["I need its worked example for tomorrow's lesson plan"],
    ["Write lesson plan"], "key", "Teach algorithms");
  assert.equal(verdict.pass, true);
  assert.match(prompts[0], /specific task, deliverable, or person/);
  assert.match(prompts[0], /this page plausibly helps/);
  assert.match(prompts[0], /When the connection is unclear, FAIL/);
  assert.doesNotMatch(prompts[0], /When in doubt, PASS/);
});
