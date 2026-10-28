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
