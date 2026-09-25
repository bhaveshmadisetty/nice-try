const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = require('../extension-root.cjs');

async function syncUI(state) {
  const elements = {};
  const calls = [];
  const document = { getElementById(id) {
    return elements[id] ||= { hidden: false, disabled: false, checked: false,
      classList: { toggle() {}, add() {}, remove() {} } };
  } };
  const scope = { document, TaskClient: { request: async(type, args) => {
    calls.push({type,args});
    if(type === 'signOut') return {...state,email:'',lastSync:0};
    if(type === 'signIn') return {...state,email:'tester@example.com'};
    return state;
  } } };
  await vm.runInNewContext(fs.readFileSync(path.join(root,'ui/sync-settings.js'),'utf8'),scope);
  return { elements, calls };
}
test('sync card exposes only actions available in each account state', async () => {
  const local = await syncUI({configured:false});
  assert.equal(local.elements.syncSignIn.hidden,true);
  assert.equal(local.elements.syncImportRow.hidden,true);
  assert.equal(local.elements.syncNow.hidden,true);
  assert.match(local.elements.syncStatus.textContent,/saved here/);
  const ready = await syncUI({configured:true});
  assert.equal(ready.elements.syncSignIn.hidden,false);
  assert.equal(ready.elements.syncImportRow.hidden,false);
  assert.equal(ready.elements.syncImport.checked,false);
  await ready.elements.syncSignIn.onclick();
  assert.equal(ready.calls.find(c=>c.type==='signIn').args.importLocal,false);
  assert.equal(ready.elements.syncNow.hidden,false);
  assert.equal(ready.elements.syncImportRow.hidden,true);
  await ready.elements.syncSignOut.onclick();
  assert.equal(ready.elements.syncSignIn.hidden,false);
  assert.equal(ready.elements.syncNow.hidden,true);
});

test('stats renders empty, populated and neutral-only reports with accurate date ranges', () => {
  const box = {innerHTML:''};
  const scope = {document:{getElementById:()=>box},URL};
  const source = fs.readFileSync(path.join(root,'ui/stats.js'),'utf8').split('// ---------- segmented control ----------')[0];
  vm.createContext(scope); vm.runInContext(source,scope);
  vm.runInContext('render()',scope);
  assert.match(box.innerHTML,/No activity yet/);
  vm.runInContext('log = {[todayKey()]: {productive:3600,junk:1200,neutral:300,sites:{Example:{s:3600,u:"https://example.com",c:{productive:3600}}}},"2000-01-01":{productive:99999}}; range="7"; wallet={earned:1,balance:1,ledger:[]}; render()',scope);
  assert.equal(vm.runInContext('keysInRange().length',scope),1);
  assert.match(box.innerHTML,/75%/);
  assert.ok(box.innerHTML.indexOf('Where your time went') < box.innerHTML.indexOf('Coins &amp; milestones'));
  assert.equal((box.innerHTML.match(/<details/g)||[]).length,(box.innerHTML.match(/<\/details>/g)||[]).length);
  vm.runInContext('log = {[todayKey()]:{neutral:300}}; range="review"; render()',scope);
  assert.match(box.innerHTML,/focus rate this week/);
  assert.doesNotMatch(box.innerHTML,/Your week starts here/);
});
