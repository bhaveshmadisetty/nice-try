const test=require('node:test');
const assert=require('node:assert/strict');
const {attachLongPress,suppressDragClick}=require('../mobile/lib/long-press.ts');
function fixture(t, animated=false){
  const animations=[];
  class Node extends EventTarget{
    constructor(id,top=0){super();this.dataset={taskId:id};this.top=top;this.style={};this.classes=new Set();this.classList={add:(...v)=>v.forEach(x=>this.classes.add(x)),remove:(...v)=>v.forEach(x=>this.classes.delete(x))};}
    closest(selector){return selector==='[data-task-id]'?this:null;}
    getBoundingClientRect(){return {top:this.top,left:0,width:300,height:80};}
    cloneNode(){return new Node(this.dataset.taskId,this.top);}
    setAttribute(){} remove(){} contains(){return true;}
    querySelectorAll(selector){return selector==='[data-task-id]'?rows:rows.filter(r=>r.classes.has('drop-before')||r.classes.has('drop-after'));}
  }
  if(animated)Node.prototype.animate=function(keyframes,options){let resolve;const finished=new Promise(r=>{resolve=r;});animations.push({keyframes,options,resolve});return {finished};};
  const rows=[new Node('a',100),new Node('b',180),new Node('c',260)];
  const list=new Node(),doc=new EventTarget(),win=new EventTarget();
  doc.body=new Node();doc.body.append=()=>{};win.scrollY=0;win.innerHeight=700;win.scrollBy=()=>{};
  const overrides={Element:Node,document:doc,window:win,requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{}};
  const restore=[]; for(const [key,value]of Object.entries(overrides)){const prior=global[key];global[key]=value;restore.push(()=>{if(prior===undefined)delete global[key];else global[key]=prior;});}
  t.mock.timers.enable({apis:['setTimeout']});
  const drops=[],messages=[];
  const cleanup=attachLongPress(list,{canDrop:()=>true,onDrop:(...args)=>drops.push(args),announce:m=>messages.push(m)});
  t.after(()=>{cleanup();restore.forEach(fn=>fn());});
  function fire(node,type,target,y=120){const event=new Event(type,{cancelable:true});Object.defineProperties(event,{target:{value:target},touches:{value:[{clientX:20,clientY:y}]}});node.dispatchEvent(event);return event;}
  return {list,doc,rows,drops,messages,fire,animations,cleanup};
}
test('long hold picks up a task, touch move marks a destination, release saves once',t=>{
  const f=fixture(t);f.fire(f.list,'touchstart',f.rows[0]);
  t.mock.timers.tick(399);assert.equal(f.rows[0].classes.has('is-dragging'),false);
  t.mock.timers.tick(1);assert.equal(f.rows[0].classes.has('is-dragging'),true);
  assert.equal(f.fire(f.doc,'touchmove',f.rows[0],350).defaultPrevented,true);
  assert.equal(f.rows[1].style.transform,'translateY(-80px)');assert.equal(f.rows[2].style.transform,'translateY(-80px)');assert.equal(f.rows[0].style.transform,'translateY(160px)');
  f.fire(f.doc,'touchend',f.rows[0],350);
  assert.deepEqual(f.drops,[['a','c',1]]);assert.equal(suppressDragClick(),true);
  assert.equal(f.rows[0].classes.has('is-dragging'),false);
});
test('normal swipe cancels pickup and leaves native scrolling available',t=>{
  const f=fixture(t);f.fire(f.list,'touchstart',f.rows[0]);
  assert.equal(f.fire(f.doc,'touchmove',f.rows[0],160).defaultPrevented,false);
  t.mock.timers.tick(500);f.fire(f.doc,'touchend',f.rows[0],160);
  assert.equal(f.rows[0].classes.has('is-dragging'),false);assert.deepEqual(f.drops,[]);
});
test('touch cancellation and holding without moving never save a new order',t=>{
  const f=fixture(t);f.fire(f.list,'touchstart',f.rows[0]);t.mock.timers.tick(400);
  f.fire(f.doc,'touchend',f.rows[0]);assert.deepEqual(f.drops,[]);
  f.fire(f.list,'touchstart',f.rows[0]);t.mock.timers.tick(400);
  f.fire(f.doc,'touchmove',f.rows[0],350);f.fire(f.doc,'touchcancel',f.rows[0]);
  assert.deepEqual(f.drops,[]);assert.equal(f.rows[0].classes.has('is-dragging'),false);
});

test('iOS-style drop settles into the reserved gap before saving',async t=>{
  const f=fixture(t,true);f.fire(f.list,'touchstart',f.rows[0]);t.mock.timers.tick(400);
  f.fire(f.doc,'touchmove',f.rows[0],350);f.fire(f.doc,'touchend',f.rows[0]);
  assert.deepEqual(f.drops,[]);
  const settle=f.animations.at(-1);assert.equal(settle.keyframes[1].top,'260px');
  settle.resolve();await Promise.resolve();
  assert.deepEqual(f.drops,[['a','c',1]]);
  assert.ok(f.rows.every(row=>row.style.transform===''));
});
test('cancelling during settle prevents a delayed save',async t=>{
  const f=fixture(t,true);f.fire(f.list,'touchstart',f.rows[0]);t.mock.timers.tick(400);
  f.fire(f.doc,'touchmove',f.rows[0],350);f.fire(f.doc,'touchend',f.rows[0]);
  f.cleanup();f.animations.at(-1).resolve();await Promise.resolve();
  assert.deepEqual(f.drops,[]);
});
