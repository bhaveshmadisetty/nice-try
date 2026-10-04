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
