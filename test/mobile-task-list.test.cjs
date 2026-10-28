const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const C = require(path.join(require('../extension-root.cjs'), 'src/task-core.js'));
const {moveTask,taskLink,compareRank} = require('../mobile/lib/task-list.ts');
const fixture = () => C.list(C.migrate(['First','Second','Third','Fourth']));
test('mobile moves persist through shared records without changing task content',()=>{
  const base=fixture(), records=C.migrate(base);
  const desired=moveTask(base,base[2].id,base[0].id,-1);
  const merged=C.list(C.merge(records,C.edit(records,base,desired)));
  assert.deepEqual(merged.map(t=>t.text),['Third','First','Second','Fourth']);
  assert.equal(desired.filter((t,i)=>t.rank!==base[i].rank).length,1);
  const back=moveTask(merged,base[2].id,base[3].id,1).sort(compareRank);
  assert.deepEqual(back.map(t=>t.text),['First','Second','Fourth','Third']);
});
test('tied ranks and filtered neighbors reorder deterministically',()=>{
  const base=fixture().map(t=>({...t,rank:0})).sort(compareRank);
  const moved=moveTask(base,base[0].id,base[2].id,1).sort(compareRank);
  assert.deepEqual(moved.map(t=>t.id),[base[1].id,base[2].id,base[0].id,base[3].id]);
  assert.ok(moved.every(t=>Number.isFinite(t.rank)));
});
test('reorder preserves remote edits and additions through the existing merge',()=>{
  const base=fixture(), records=C.migrate(base);
  const remote=C.edit(records,base,[...base.map((t,i)=>i===1?{...t,text:'Updated remotely',url:'https://example.com'}:t),{id:'new',text:'New remote task',done:false,rank:9000}]);
  const result=C.list(C.edit(remote,base,moveTask(base,base[1].id,base[0].id,-1)));
  assert.equal(result[0].text,'Updated remotely');
  assert.equal(result[0].url,'https://example.com');
  assert.ok(result.some(t=>t.id==='new'));
});
test('links accept web URLs and inline links but reject unsafe and malformed URLs',()=>{
  assert.equal(taskLink({url:'https://example.com/path',text:'Task'}).hostname,'example.com');
  assert.equal(taskLink({text:'Read https://example.org/path'}).href,'https://example.org/path');
  for(const url of ['javascript:alert(1)','data:text/html,test','not a url']) assert.equal(taskLink({url,text:'Task'}),null);
});
test('link field normalizes like the extension and rejects sentences',()=>{
  const {parseLink}=require('../mobile/lib/task-list.ts');
  assert.deepEqual(parseLink('example.com/a'),{url:'https://example.com/a',host:'example.com'});
  assert.deepEqual(parseLink(' https://www.youtube.com/watch?v=1 '),{url:'https://www.youtube.com/watch?v=1',host:'youtube.com'});
  assert.equal(parseLink(''),'');
  assert.equal(parseLink('   '),'');
  for(const bad of ['not a link','javascript:alert(1)','ftp://example.com','https://nodot']) assert.equal(parseLink(bad),null,bad);
});
test('URLs typed into task text become tappable parts without trailing punctuation',()=>{
  const {textParts}=require('../mobile/lib/task-list.ts');
  assert.deepEqual(textParts('Read https://a.com/x. then (https://b.org)'),[
    {text:'Read '},{text:'https://a.com/x',href:'https://a.com/x'},{text:'. then ('},{text:'https://b.org',href:'https://b.org/'},{text:')'}]);
  assert.deepEqual(textParts('no links here'),[{text:'no links here'}]);
  assert.equal(taskLink({text:'see https://a.com.'}).href,'https://a.com/');
});
test('removing a link from the phone clears url and host through the shared merge',()=>{
  const base=C.list(C.migrate([{text:'Watch',url:'https://example.com/v',host:'example.com'}])),records=C.migrate(base);
  const {url,host,...rest}=base[0];
  const result=C.list(C.merge(records,C.edit(records,base,[rest])));
  assert.equal(result[0].url,undefined);assert.equal(result[0].host,undefined);
  const added=C.list(C.edit(records,base,[{...base[0],url:'https://other.com/',host:'other.com'}]));
  assert.equal(added[0].host,'other.com');
});

test('phone breaks rank ties like the extension: overdue first, then list order',()=>{
  const day=n=>{const d=new Date();d.setDate(d.getDate()+n);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
  // The extension ranks per day, so yesterday's carried-over tasks share ranks with today's.
  const tasks=C.list(C.migrate([
    {id:'zz-old',text:'Old 1',done:false,date:day(-2),rank:1024},
    {id:'aa-today',text:'Today 1',done:false,date:day(0),rank:1024},
    {id:'mm-mid',text:'Old 2',done:false,date:day(-1),rank:1024},
    {id:'bb-today',text:'Today 2',done:false,date:day(0),rank:2048}]));
  // Extension popup tasksFor(today): stable sort by rank, then overdue days, over C.list order.
  const pc=tasks.map(t=>({t,overdue:t.date<day(0)?Math.round((Date.parse(day(0))-Date.parse(t.date))/864e5):0}))
    .sort((a,b)=>a.t.rank-b.t.rank||b.overdue-a.overdue).map(r=>r.t.text);
  assert.deepEqual([...tasks].sort(compareRank).map(t=>t.text),pc);
  // A phone drag saved through the shared records reads back in the same order on the PC.
  const moved=moveTask(tasks,'bb-today','zz-old',-1).sort(compareRank);
  const pcAfter=moved.map(t=>({t,overdue:t.date<day(0)?Math.round((Date.parse(day(0))-Date.parse(t.date))/864e5):0}))
    .sort((a,b)=>a.t.rank-b.t.rank||b.overdue-a.overdue).map(r=>r.t.text);
  assert.deepEqual(moved.map(t=>t.text),['Today 2','Old 1','Old 2','Today 1']);
  assert.deepEqual(pcAfter,moved.map(t=>t.text));
});
