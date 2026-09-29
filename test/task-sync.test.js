const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const extensionRoot = require("../extension-root.cjs");
const vm = require("node:vm");
const C = require(path.join(extensionRoot, "src/task-core.js"));

test("legacy tasks get stable identities without losing task fields or ordering", () => {
  const records = C.migrate(["Old task", { text: "Plan", done: true, date: "2026-09-01", rank: 9000, url: "https://example.org", late: true }]);
  const tasks = C.list(records);
  assert.equal(tasks.length, 2);
  assert.ok(tasks[0].id && tasks[1].id !== tasks[0].id);
  assert.equal(tasks[1].late, true);
  assert.equal(tasks[1].url, "https://example.org");
  assert.deepEqual(C.list(C.migrate(tasks)), tasks);
});

test("a stale editor preserves remote additions and unrelated changes", () => {
  const initial = C.migrate([{ text: "First", done: false, date: "2026-10-02" }]);
  const base = C.list(initial);
  const remote = C.edit(initial, base, [{ ...base[0], date: "2026-10-03" }, { text: "Phone task", done: false }]);
  const edited = C.edit(remote, base, [{ ...base[0], text: "Edited on laptop" }]);
  const tasks = C.list(edited);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].text, "Edited on laptop");
  assert.equal(tasks[0].date, "2026-10-03");
  assert.equal(tasks[1].text, "Phone task");
});

test("deletions survive stale edits and repeated offline merges", () => {
  const initial = C.migrate(["Delete me"]), base = C.list(initial);
  const removed = C.edit(initial, base, []);
  assert.equal(C.list(C.merge(initial, removed)).length, 0);
  assert.equal(C.list(C.edit(removed, base, [{ ...base[0], text: "Old offline edit" }])).length, 0);
  assert.deepEqual(C.merge(C.merge(initial, removed), initial), removed);
  const offline = C.edit(initial, base, [{ ...base[0], text: "Edited later while offline" }]);
  offline[base[0].id].updatedAt += 9999999;
  assert.equal(C.list(C.merge(removed, offline)).length, 0);
});

test("two device records converge regardless of merge direction and tie timestamps", () => {
  const initial = C.migrate(["Task"]), base = C.list(initial), id = base[0].id;
  const a = C.edit(initial, base, [{ ...base[0], text: "A" }]);
  const b = C.edit(initial, base, [{ ...base[0], text: "B" }]);
  b[id].updatedAt = a[id].updatedAt;
  assert.deepEqual(C.merge(a,b), C.merge(b,a));
  assert.deepEqual(C.merge(a,a), a);
  assert.equal(C.valid({ ...a[id], id: "__proto__" }), false);
});

function worker(initial = {}) {
  const storage = structuredClone(initial), handlers = [], alarms = [], writes = [];
  const local = {
    async get(keys) { const out={}; for(const k of typeof keys === "string" ? [keys] : keys) if(k in storage) out[k]=structuredClone(storage[k]); return out; },
    async set(values) { writes.push(structuredClone(values)); Object.assign(storage, structuredClone(values)); },
    async remove(key) { delete storage[key]; }
  };
  const scope = { NiceTryTasks:C, NiceTrySyncConfig:{firebase:{apiKey:"test",projectId:"test-project"},googleClientId:"client",mobileUrl:"https://example.org"},
    NiceTryCloud:{ sync:async()=>({records:{},conflicts:0}) }, crypto, URL, URLSearchParams, AbortSignal, atob,
    chrome:{ storage:{local}, identity:{getRedirectURL:()=>"https://extension.chromiumapp.org/"},
      alarms:{create:async(...a)=>alarms.push(a),clear:async()=>true,onAlarm:{addListener:()=>{}}},
      runtime:{getURL:p=>"chrome-extension://extension/"+p,onMessage:{addListener:fn=>handlers.push(fn)}} } };
  vm.runInNewContext(fs.readFileSync(path.join(extensionRoot, "src/task-sync.js"),"utf8")+"\nglobalThis.service=TaskSync;",scope);
  const request = (type, args={}, sender={url:"chrome-extension://extension/ui/options.html"}) => new Promise(resolve => handlers[0]({type:"taskStore:"+type,...args},sender,resolve));
  return {scope,storage,request,service:scope.service,alarms,writes};
}

test("worker serializes editors, preserves migration backup, and refuses stale accounts", async () => {
  const w=worker({todos:["Existing"]});
  const a=await w.service.read(),b=await w.service.read();
  await Promise.all([
    w.service.save([...a.todos,{text:"A",done:false}],a.base,a.owner),
    w.service.save([...b.todos,{text:"B",done:false}],b.base,b.owner)
  ]);
  assert.deepEqual(w.storage.taskMigrationBackup,["Existing"]);
  assert.deepEqual(new Set(w.storage.todos.map(t=>t.text)),new Set(["Existing","A","B"]));
  await assert.rejects(w.service.save([],a.base,"different-user"),/account changed/);
  const denied=await w.request("read",{},{url:"https://untrusted.example"});
  assert.equal(denied.ok,false);
});

test("disconnect restores guest tasks and cannot be undone by an in-flight sync", async () => {
  const guest=C.migrate(["Guest"]),account=C.migrate(["Account"]),owner="test-project:user";
  const w=worker({taskSpaces:{owner,spaces:{guest,[owner]:account}},todos:C.list(account),
    taskSyncAuth:{owner,uid:"user",email:"me@example.org",session:"session",idToken:"test",expiresAt:Date.now()+999999}});
  let finish,started;
  const waiting=new Promise(r=>started=r);
  w.scope.NiceTryCloud.sync=()=>{started();return new Promise(r=>finish=r);};
  const pending=w.request("sync"); await waiting;
  await w.request("signOut");
  finish({records:C.migrate(["Late remote response"]),conflicts:0}); await pending;
  assert.equal(w.storage.taskSpaces.owner,"guest");
  assert.deepEqual(w.storage.todos.map(t=>t.text),["Guest"]);
  assert.deepEqual(C.list(w.storage.taskSpaces.spaces[owner]).map(t=>t.text),["Account"]);
  assert.equal(w.storage.taskSyncAuth,undefined);
});

test("local edits skip sync alarms while connected account edits schedule them", async () => {
  const guest = worker({ todos: ["Local"] });
  const local = await guest.service.read();
  await guest.service.save(local.todos.map(t => ({ ...t, text: "Local edit" })), local.base, local.owner);
  assert.equal(guest.alarms.length, 0);

  const owner = "test-project:user", records = C.migrate(["Account"]);
  const account = worker({ taskSpaces: { owner, spaces: { [owner]: records } } });
  const before = await account.service.read();
  await account.service.save(before.todos.map(t => ({ ...t, text: "Changed" })), before.base, owner);
  assert.equal(account.alarms[0][0], "taskSyncSoon");
  account.alarms.length = 0;
  account.scope.NiceTrySyncConfig.googleClientId = "";
  await account.service.save(before.todos.map(t => ({ ...t, text: "Changed again" })), before.base, owner);
  assert.equal(account.alarms.length, 0);
});

test("phone and extension ship exactly the same synchronization protocol", () => {
  for (const name of ["task-core.js","task-cloud.js"]) {
    assert.equal(fs.readFileSync(path.join(extensionRoot, "src",name),"utf8"),fs.readFileSync(path.join(__dirname,"../mobile/lib",name),"utf8"));
  }
});

test("Firestore transport paginates, authenticates, and uses conditional writes", async () => {
  const local=C.migrate(["New task"]),id=C.list(local)[0].id,calls=[];
  const scope={NiceTryTasks:C,AbortSignal,fetch:async(url,opts)=>{
    calls.push({url,opts});
    if(opts.method==="PATCH")return {ok:false,status:409,json:async()=>({error:{status:"ALREADY_EXISTS"}})};
    return {ok:true,json:async()=>calls.length===1?{nextPageToken:"page-two"}:{documents:[]}};
  }};
  vm.runInNewContext(fs.readFileSync(path.join(extensionRoot, "src/task-cloud.js"),"utf8"),scope);
  const result=await scope.NiceTryCloud.sync("test-project","user","token",local);
  assert.equal(result.conflicts,1);
  assert.ok(calls[1].url.includes("pageToken=page-two"));
  assert.ok(calls[2].url.endsWith(id+"?currentDocument.exists=false"));
  assert.equal(calls[2].opts.headers.Authorization,"Bearer token");
  assert.ok(!calls[2].url.includes("token"));
});


test("unchanged and stale no-op saves do not write storage or schedule sync", async () => {
  const owner = "test-project:user", records = C.migrate(["Original"]);
  const w = worker({ taskSpaces: { owner, spaces: { [owner]: records } }, todos: C.list(records) });
  const original = await w.service.read();
  await w.service.save(original.todos, original.base, owner);
  assert.equal(w.writes.length, 0);
  assert.equal(w.alarms.length, 0);
  await w.service.save(original.todos.map(t => ({ ...t, text: "Edited elsewhere" })), original.base, owner);
  assert.equal(w.writes.length, 1);
  assert.equal(w.alarms.length, 1);
  w.writes.length = 0; w.alarms.length = 0;
  const result = await w.service.save(original.todos, original.base, owner);
  assert.equal(result.todos[0].text, "Edited elsewhere");
  assert.equal(w.writes.length, 0);
  assert.equal(w.alarms.length, 0);
});


test("two signed-in devices exchange additions, completions and deletions", async () => {
 const owner="test-project:user";
 const device=()=>worker({taskSpaces:{owner,spaces:{[owner]:{}}},todos:[],taskSyncAuth:{owner,uid:"user",session:crypto.randomUUID(),idToken:"test",expiresAt:Date.now()+999999}});
 const a=device(),b=device();let server={};
 const cloud=async(p,u,t,local)=>{server=C.merge(server,local);return {records:C.copy(server),conflicts:0};};
 a.scope.NiceTryCloud.sync=cloud;b.scope.NiceTryCloud.sync=cloud;
 let s=await a.service.read();await a.service.save([{text:"Laptop task",done:false}],s.base,owner);
 await a.request("sync");await b.request("sync");s=await b.service.read();assert.equal(s.todos[0].text,"Laptop task");
 await b.service.save(s.todos.map(t=>({...t,text:"Phone edit",done:true})),s.base,owner);
 await b.request("sync");await a.request("sync");s=await a.service.read();assert.equal(s.todos[0].text,"Phone edit");assert.equal(s.todos[0].done,true);
 await a.service.save([],s.base,owner);await a.request("sync");await b.request("sync");assert.equal((await b.service.read()).todos.length,0);
});

test("Google connection accepts matching nonce and rejects a mismatched callback", async () => {
 const w=worker({todos:["Local task"]});
 w.scope.chrome.identity.launchWebAuthFlow=async({url})=>{const u=new URL(url);return "https://extension.chromiumapp.org/#"+new URLSearchParams({state:u.searchParams.get("state"),id_token:"header."+Buffer.from(JSON.stringify({nonce:u.searchParams.get("nonce")})).toString("base64url")+".signature"});};
 w.scope.fetch=async()=>({ok:true,json:async()=>({localId:"user",idToken:"test",refreshToken:"test-refresh",email:"test@example.org",expiresIn:"3600"})});
 assert.equal((await w.request("signIn",{importLocal:true})).ok,true);
 assert.equal(w.storage.todos[0].text,"Local task");assert.equal(w.storage.taskSpaces.owner,"test-project:user");
 assert.equal(w.alarms.find(a=>a[0]==="taskSyncPeriodic")[1].periodInMinutes,1);
 await w.request("signOut");
 w.scope.chrome.identity.launchWebAuthFlow=async({url})=>"https://extension.chromiumapp.org/#"+new URLSearchParams({state:new URL(url).searchParams.get("state"),id_token:"header."+Buffer.from(JSON.stringify({nonce:"wrong"})).toString("base64url")+".signature"});
 assert.equal((await w.request("signIn",{importLocal:true})).ok,false);assert.equal(w.storage.taskSpaces.owner,"guest");
});
