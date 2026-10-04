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
