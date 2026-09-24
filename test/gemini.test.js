const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const extensionRoot = require("../extension-root.cjs");
const vm = require("node:vm");
const Gemini = require(path.join(extensionRoot, "src/gemini.js"));

const success = text => ({ ok: true, status: 200, json: async () => ({
  candidates: [{ finishReason: "STOP", content: { parts: [
    { text: "DISTRACTION", thought: true }, { text }
  ] } }]
}) });

test("Gemini sends the prompt using header authentication and reads only final text", async () => {
  const key = "test-private-key";
  const answer = await Gemini.chat("Classify this title", key, 40, "", async (url, options, timeout) => {
    assert.ok(url.endsWith(`/models/${Gemini.DEFAULT_MODEL}:generateContent`));
    assert.equal(url.includes(key), false);
    assert.equal(options.headers["x-goog-api-key"], key);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(timeout, 15000);
    const body = JSON.parse(options.body);
    assert.equal(body.contents[0].parts[0].text, "Classify this title");
    assert.ok(body.generationConfig.maxOutputTokens >= 1024);
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "LOW");
    return success("PRODUCTIVE 0");
  });
  assert.equal(answer, "PRODUCTIVE 0");
});

test("quota, auth, model and service errors are surfaced without retries or leaking data", async () => {
  for (const [status, message] of [[400, /rejected the request/], [401, /rejected access/],
    [403, /rejected access/], [404, /model unavailable/], [429, /quota reached/], [503, /HTTP 503/]]) {
    let calls = 0;
    await assert.rejects(Gemini.chat("private task", "secret", 40, "", async () => {
      calls++;
      return { status, ok: false, json: async () => { throw Error("must not read error body"); } };
    }), message);
    assert.equal(calls, 1);
  }
});

test("truncated, blocked, empty and thoughts-only output cannot become verdicts", async () => {
  for (const data of [
    { promptFeedback: { blockReason: "SAFETY" } },
    { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "PRODUCTIVE" }] } }] },
    { candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "PRODUCTIVE" }] } }] },
    { candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "PRODUCTIVE" }] } }] },
    {}
  ]) {
    await assert.rejects(Gemini.chat("prompt", "key", 40, "", async () => ({ ok: true, json: async () => data })));
  }
});

test("model override is validated and 2.5 Flash can disable thinking", async () => {
  await assert.rejects(Gemini.chat("prompt", "key", 40, "../../other", () => {
    throw Error("request must not run");
  }), /model ID/);
  await Gemini.chat("prompt", "key", 40, "models/gemini-2.5-flash-lite", async (url, options) => {
    assert.ok(url.endsWith("/gemini-2.5-flash-lite:generateContent"));
    assert.equal(JSON.parse(options.body).generationConfig.thinkingConfig.thinkingBudget, 0);
    return success("answer");
  });
});

const worker = fs.readFileSync(path.join(extensionRoot, "src/background.js"), "utf8");
function slice(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}

test("worker routes explicit Gemini keys correctly and retains existing provider behavior", async () => {
  let config = { aiProvider: "gemini", geminiModel: "gemini-3.5-flash-lite" };
  const calls = [];
  const scope = {
    Gemini, lastAiError: "old failure", chrome: { storage: { local: { get: async () => config } } },
    fetchT: async (url, options) => {
      calls.push(url);
      if (url.includes("googleapis")) return success("PRODUCTIVE 0");
      return { ok: true, json: async () => ({ choices: [{ message: { content: "PRODUCTIVE 0" } }] }) };
    },
    getGroqModels: async () => ["groq-model"], getFreeModels: async () => ["router-model"],
    chatBody: (model, prompt) => ({ model, messages: [{ role: "user", content: prompt }] })
  };
  vm.runInNewContext(slice(worker, "function providerOf(", "const GRACE_SECONDS"), scope);
  vm.runInNewContext(slice(worker, "async function aiChat(", "// fetch with a deadline."), scope);
  assert.equal(scope.providerOf("AIza-example"), "gemini");
  assert.equal(scope.providerOf("gsk_example"), "groq");
  assert.equal(scope.providerOf("sk-or-example"), "openrouter");
  assert.equal(await scope.aiChat("prompt", "new-key-format", 40), "PRODUCTIVE 0");
  assert.equal(scope.lastAiError, "");
  config = {};
  await scope.aiChat("prompt", "gsk_example", 40);
  await scope.aiChat("prompt", "sk-or-example", 40);
  assert.ok(calls[0].includes("generativelanguage.googleapis.com"));
  assert.ok(calls[1].includes("api.groq.com"));
  assert.ok(calls[2].includes("openrouter.ai"));
  await assert.rejects(scope.aiChat("prompt", "unknown-key-format", 40), /Select your AI provider/);
  assert.equal(calls.length, 3, "unknown key must never reach a guessed provider");
  config = { aiProvider: "gemini" };
  scope.fetchT = async () => ({ status: 429, ok: false });
  await assert.rejects(scope.aiChat("prompt", "key", 40), /quota/);
  assert.match(scope.lastAiError, /quota/);
});

test("onboarding accepts explicit Gemini key formats and probes the correct provider", () => {
  const welcome = fs.readFileSync(path.join(extensionRoot, "ui/welcome.js"), "utf8");
  let selected = "auto";
  const scope = { el: () => ({ value: selected }) };
  vm.runInNewContext(slice(welcome, "function keyLooksValid(", "// ---------- checking the key"), scope);
  vm.runInNewContext(slice(welcome, "function keyProbe(", "async function checkKey"), scope);
  assert.equal(scope.keyLooksValid("AIza-example"), true);
  assert.equal(scope.keyLooksValid("unknown-format"), false);
  selected = "gemini";
  assert.equal(scope.keyLooksValid("new-key-format"), true);
  assert.equal(scope.keyLooksValid("bad key with spaces"), false);
  assert.equal(scope.keyProbe("new-key-format").headers["x-goog-api-key"], "new-key-format");
  assert.ok(scope.keyProbe("new-key-format").url.startsWith("https://generativelanguage.googleapis.com/"));
});
