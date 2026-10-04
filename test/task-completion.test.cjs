const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=require('../extension-root.cjs');
const popup=fs.readFileSync(path.join(root,'ui/popup.js'),'utf8').replace(/\r\n/g,'\n');
const board=fs.readFileSync(path.join(root,'ui/tasks.js'),'utf8').replace(/\r\n/g,'\n');
function setup(){
 const listeners={},elements={};
 const el=id=>elements[id]||=( {value:'',classList:{remove(){},add(){}},addEventListener:(event,fn)=>{listeners[id]=fn;}} );
 const ctx={el,todos:[],viewKey:'2026-10-01',todayKey:()=> '2026-10-04',openIndex:0,pendingDate:'',query:'',Date,
 saveTodos:()=>{},save:async()=>{},closeDetail:()=>{},measureRows:()=>new Map(),travel:()=>{},strikeThenSave:()=>{},
 extractUrl:()=>'',hostOfUrl:()=>'',dateOfKey:key=>new Date(key+'T12:00:00')};
 vm.createContext(ctx);return {ctx,listeners,el};
}
const rowEvent={target:{dataset:{act:'toggle'},closest(selector){if(selector==='[data-act="open"]')return null;if(selector==='[data-act]')return this;return {dataset:{i:'0'}};}}};
for(const surface of ['popup','board list','board detail'])test(surface+' records actual completion day for past and future tasks',()=>{
 const x=setup();
 if(surface==='popup')vm.runInContext(popup.slice(popup.indexOf('el("todoList").addEventListener("click"'),popup.indexOf('// A new task goes to the BOTTOM')),x.ctx);
 else if(surface==='board list')vm.runInContext(board.slice(board.indexOf('function onRowClick('),board.indexOf('function onRowKey(')),x.ctx);
 else vm.runInContext(board.slice(board.indexOf('el("shToggle").addEventListener'),board.indexOf('el("shDelete").addEventListener')),x.ctx);
 const toggle=()=>surface==='popup'?x.listeners.todoList(rowEvent):surface==='board list'?x.ctx.onRowClick(rowEvent):x.listeners.shToggle();
 for(const date of ['2026-10-01','2026-10-09']){
   x.ctx.todos=[{id:'a',text:'Task',date,rank:42,done:false,url:'https://example.com'}];
   toggle();assert.equal(x.ctx.todos[0].doneDate,'2026-10-04');assert.equal(x.ctx.todos[0].date,date);assert.equal(x.ctx.todos[0].rank,42);
   toggle();assert.equal(x.ctx.todos[0].done,false);assert.equal(x.ctx.todos[0].doneDate,undefined);
 }
});
test('editing the planned date of a completed task preserves its completion record',()=>{
 const x=setup();x.ctx.todos=[{id:'a',text:'Task',done:true,date:'2026-10-01',doneDate:'2026-10-04'}];
 x.ctx.pendingDate='2026-10-02';x.el('shText').value='Task';
 vm.runInContext(board.slice(board.indexOf('el("shSave").addEventListener'),board.indexOf('el("shToggle").addEventListener')),x.ctx);
 x.listeners.shSave();assert.equal(x.ctx.todos[0].date,'2026-10-02');assert.equal(x.ctx.todos[0].doneDate,'2026-10-04');assert.equal(x.ctx.viewKey,'2026-10-04');
});
test('legacy repair does not replace an explicit completion date with browsing evidence',()=>{
 const x=setup();Object.assign(x.ctx,{needsRepair:true,guessLegacyDay:()=> '2026-09-01'});
 vm.runInContext(popup.slice(popup.indexOf('function repairMisdated('),popup.indexOf('// A rank of 0')),x.ctx);
 const task={text:'Task',done:true,date:'2026-10-04',doneDate:'2026-10-04'};
 assert.equal(x.ctx.repairMisdated(task,{}),task);
});
test('completed tasks appear on completion day rather than planned day on both extension lists',()=>{
 for(const source of [popup,board]){
   const x=setup();Object.assign(x.ctx,{byOrder:()=>0,rankOf:t=>t.rank||0});x.ctx.todos=[{text:'Task',date:'2026-10-01',done:true,doneDate:'2026-10-04'}];
   const start=source.indexOf('function tasksFor('),end=source.indexOf('\n}\n',start)+3;
   vm.runInContext(source.slice(start,end),x.ctx);
   assert.equal(x.ctx.tasksFor('2026-10-01').length,0);assert.equal(x.ctx.tasksFor('2026-10-04').length,1);
 }
});
test('mobile delay labels distinguish late, early and same-day completion',()=>{
 const {completionTiming}=require('../mobile/lib/task-list.ts');
 assert.equal(completionTiming({done:true,date:'2026-10-01',doneDate:'2026-10-04'}),'3 days late');
 assert.equal(completionTiming({done:true,date:'2026-10-05',doneDate:'2026-10-04'}),'1 day early');
 assert.equal(completionTiming({done:true,date:'2026-10-04',doneDate:'2026-10-04'}),'On planned day');
 assert.equal(completionTiming({done:true,date:'2026-10-01'}),'');
});
