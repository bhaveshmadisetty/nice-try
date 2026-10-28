const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
// Resolve typescript from wherever it is installed. A hardcoded
// ../mobile/node_modules path only works in a tree whose phone deps are
// installed, so a fresh clone and CI both failed on a require, not an
// assertion. Skip cleanly instead of reporting a red suite for a missing
// dev dependency.
let ts;
try { ts=require('typescript'); }
catch { try { ts=require('../mobile/node_modules/typescript'); } catch {} }
if(!ts){ require('node:test').skip('typescript not installed - run npm ci in mobile'); return; }
const C=require(path.join(require('../extension-root.cjs'),'src/task-core.js'));
const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../mobile/lib/task-service.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
test('mobile sync is event-driven and no-op saves do not sync or write',async()=>{
 const data=new Map(),events={},exports={};let authChanged,calls=0,writes=0;
 const scope={exports,console,crypto,URL,AbortSignal,structuredClone,Date,JSON,Map,Set,Promise,
 NiceTryTasks:C,NiceTryCloud:{sync:async(p,u,t,records)=>{calls++;return {records,conflicts:0};}},
 localStorage:{getItem:k=>data.get(k)||null,setItem:(k,v)=>{writes++;data.set(k,v);}},
 navigator:{onLine:true},window:{addEventListener:(name,fn)=>events[name]=fn},document:{hidden:false,addEventListener:(name,fn)=>events[name]=fn},
 setInterval:()=>{throw Error('Recurring sync must not be scheduled');},setTimeout:()=>{},
 require(name){if(name==='firebase/app')return {initializeApp:()=>({})};if(name==='firebase/auth')return {getAuth:()=>({}),onAuthStateChanged:(a,fn)=>authChanged=fn};if(name==='./sync-config.json')return {apiKey:'test',projectId:'test-project',authDomain:'test'};return {};}};
 vm.runInNewContext(code,scope);let view;exports.subscribe(v=>view=v);await exports.start();
 await authChanged({uid:'user',email:'test@example.org',getIdToken:async()=> 'token'});await new Promise(r=>setImmediate(r));
 const initialCalls=calls,initialWrites=writes;
 await exports.save(view.tasks,view.tasks,view.owner);await new Promise(r=>setImmediate(r));
 assert.equal(calls,initialCalls);assert.equal(writes,initialWrites);
 await exports.save(view.tasks,[{id:'new',text:'New task',done:false,rank:1024}],view.owner);await new Promise(r=>setImmediate(r));
 assert.equal(calls,initialCalls+1);
 scope.document.hidden=true;events.visibilitychange();await new Promise(r=>setImmediate(r));assert.equal(calls,initialCalls+1);
 scope.document.hidden=false;events.visibilitychange();await new Promise(r=>setImmediate(r));assert.equal(calls,initialCalls+2);
 events.online();await new Promise(r=>setImmediate(r));assert.equal(calls,initialCalls+3);
});
function harness(data){
 const events={},exports={};let authChanged,signedOut=0;
 const scope={exports,console,crypto,URL,AbortSignal,structuredClone,Date,JSON,Map,Set,Promise,
 NiceTryTasks:C,NiceTryCloud:{sync:async(p,u,t,records)=>({records,conflicts:0})},
 localStorage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)},
 navigator:{onLine:false},window:{addEventListener:(name,fn)=>events[name]=fn},document:{hidden:false,addEventListener:(name,fn)=>events[name]=fn},
 setTimeout:()=>{},
 require(name){if(name==='firebase/app')return {initializeApp:()=>({})};if(name==='firebase/auth')return {getAuth:()=>({currentUser:null}),onAuthStateChanged:(a,fn)=>authChanged=fn,signOut:async()=>{signedOut++;}};if(name==='./sync-config.json')return {apiKey:'test',projectId:'test-project',authDomain:'test'};return {};}};
 vm.runInNewContext(code,scope);let view;exports.subscribe(v=>view=v);
 return {exports,view:()=>view,auth:u=>authChanged(u),signedOut:()=>signedOut};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('a cold start opens the last account\'s cached tasks before Firebase answers',async()=>{
 const data=new Map();
 const first=harness(data);await first.exports.start();
 await first.auth({uid:'u1',email:'me@example.org',getIdToken:async()=>'t'});await tick();
 await first.exports.save(first.view().tasks,[{id:'a',text:'Cached task',done:false,rank:1024}],first.view().owner);
 const second=harness(data);await second.exports.start();
 assert.equal(second.view().ready,true);
 assert.equal(second.view().email,'me@example.org');
 assert.equal(second.view().owner,'test-project:u1');
 assert.deepEqual(second.view().tasks.map(t=>t.text),['Cached task']);
 assert.match(second.view().status,/Offline/);
});
test('Firebase dropping the session keeps cached tasks; only Sign out returns to guest',async()=>{
 const data=new Map();
 const first=harness(data);await first.exports.start();
 await first.auth({uid:'u1',email:'me@example.org',getIdToken:async()=>'t'});await tick();
 await first.exports.save(first.view().tasks,[{id:'a',text:'Cached task',done:false,rank:1024}],first.view().owner);
 const second=harness(data);await second.exports.start();
 await second.auth(null);await tick();
 assert.equal(second.view().signedOut,true);
 assert.equal(second.view().owner,'test-project:u1');
 assert.deepEqual(second.view().tasks.map(t=>t.text),['Cached task']);
 await second.exports.save(second.view().tasks,[...second.view().tasks,{id:'b',text:'Offline edit',done:false,rank:2048}],second.view().owner);
 assert.equal(second.view().tasks.length,2);
 await second.exports.disconnect();await tick();
 assert.equal(second.view().owner,'guest');assert.equal(second.view().email,'');assert.deepEqual(second.view().tasks,[]);
 assert.equal(data.has('nice-try.last-account'),false);
 assert.equal(JSON.parse(data.get('nice-try.tasks.v1:test-project:u1')).b.id,'b','account tasks stay on the phone for the next sign-in');
});
