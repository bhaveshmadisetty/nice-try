const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=require('../extension-root.cjs');
const source=fs.readFileSync(path.join(root,'ui/popup.js'),'utf8');
function setup(){
 const elements={};
 function element(id){return elements[id] ||= {dataset:{},disabled:true,inert:true,attrs:{},classList:{removed:[],remove(x){this.removed.push(x);}},setAttribute(k,v){this.attrs[k]=v;},replaceChildren(x){this.replacement=x;}};}
 let accept,reject,wallet;
 const read=new Promise((a,b)=>{accept=a;reject=b;});
 const ctx={console:{error(){}},document:{body:element('body'),querySelector:()=>element('app'),createElement:()=>({style:{}})},
 el:element,readState:()=>read,chrome:{runtime:{sendMessage:(m,cb)=>{wallet=cb;}},storage:{local:{set:async()=>{}}}},
 normalizeTodos:x=>x,refreshSetup:async()=>{},renderTodos:()=>{},renderScore:()=>{},setStatus:()=>{},todayKey:()=> '2026-10-03',
 renderWallet:()=>{},renderPricing:()=>{},loadDowntime:()=>{},setTimeout:()=>{},show:{boot(){}},
 startWalletPolling:()=>{},checkCelebration:()=>{},checkOffState:()=>{},checkAi:()=>{},checkPause:()=>{},checkSession:()=>{},loadTabChip:()=>{}};
 vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('function loadWallet()'),source.indexOf('// The wallet was fetched once')),ctx);
 vm.runInContext(source.slice(source.indexOf('async function load()')),ctx);
 return {elements,accept,reject,wallet:()=>wallet,ctx};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('delayed storage cannot reveal default values; wallet remains independently gated',async()=>{
 const html=fs.readFileSync(path.join(root,'ui/popup.html'),'utf8');
 assert.match(html,/<body class="booting">/);
 assert.match(html,/<div class="app" aria-busy="true" inert>/);
 const x=setup();
 assert.equal(x.elements.body.classList.removed.length,0);
 assert.equal(typeof x.wallet(),'function');
 x.accept({todos:[],log:{},repairDone:true});await flush();
 assert.ok(x.elements.body.classList.removed.includes('booting'));
 assert.equal(x.elements.app.inert,false);
 assert.equal(x.elements.coinBar,undefined);
 x.wallet()({balance:42,streak:8});
 assert.ok(x.elements.streakCard.classList.removed.includes('wallet-loading'));
 assert.equal(x.elements.coinBar.disabled,false);
});
test('failed storage reveals an error instead of the empty task and zero-stat template',async()=>{
 const x=setup();x.reject(Error('Storage unavailable'));await flush();
 assert.match(x.elements.app.replacement.innerHTML,/Couldn/);
 assert.ok(x.elements.body.classList.removed.includes('booting'));
});
