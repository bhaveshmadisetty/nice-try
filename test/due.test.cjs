const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = require('../extension-root.cjs');
const D = require(path.join(root, 'ui/due.js'));
const C = require(path.join(root, 'src/task-core.js'));
// Saturday 18 Oct 2026, 10:00 local.
const now = new Date(2026, 9, 18, 10, 0);

test('deadline labels read by distance, not by date format', () => {
  const at = due => D.info(due, now);
  assert.deepEqual([at('2026-10-18').label, at('2026-10-18').level], ['Due today', 'soon']);
  assert.equal(at('2026-10-18T17:00').label, 'Due today 5 PM');
  assert.equal(at('2026-10-18T12:30').label, 'Due in 2h 30m');
  assert.equal(at('2026-10-18T10:20').label, 'Due in 20m');
  assert.equal(at('2026-10-19T09:05').label, 'Due tomorrow 9:05 AM');
  assert.deepEqual([at('2026-10-23').label, at('2026-10-23').level], ['Due Fri', 'later']);
  assert.equal(at('2026-11-02').label, 'Due 2 Nov');
  assert.deepEqual([at('2026-10-18T09:00').label, at('2026-10-18T09:00').level], ['Overdue · was due 9 AM', 'over']);
  assert.equal(at('2026-10-16').label, 'Overdue · 2 days');
  assert.equal(at('2026-10-23T17:00').title, 'Deadline: Fri 23 Oct, 5 PM · 5 days left');
  assert.equal(at('2026-10-18T00:00').level, 'over', 'midnight today has already passed at 10 AM');
});

test('bad or missing deadlines render nothing instead of a wrong label', () => {
  for (const bad of [undefined, '', 'tomorrow', '2026-02-30', '2026-10-18T25:00', '2026-10-18T10:60', 42])
    assert.equal(D.info(bad, now), null, String(bad));
  assert.equal(D.join('', '17:00'), '', 'a time alone is not a deadline');
  assert.equal(D.join('2026-10-20', ''), '2026-10-20');
  assert.equal(D.join('2026-10-20', '08:15'), '2026-10-20T08:15');
  assert.equal(D.join('2026-02-30', ''), '');
});

test('a finished task says whether it made its deadline', () => {
  assert.equal(D.outcome('2026-10-20T17:00', '2026-10-20'), 'Met');
  assert.equal(D.outcome('2026-10-20', '2026-10-19'), 'Met');
  assert.equal(D.outcome('2026-10-20', '2026-10-23'), 'Missed by 3 days');
  assert.equal(D.outcome(undefined, '2026-10-23'), '');
});

test('the phone app ships the same deadline file as the extension', () => {
  const phone = path.join(__dirname, '../mobile/lib/due.js');
  const norm = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(norm(phone), norm(path.join(root, 'ui/due.js')), 'run scripts/prepare-mobile.cjs');
});

test('a deadline set on one device survives sync and can be cleared', () => {
  const base = C.list(C.migrate([{ text: 'Submit assignment', date: '2026-10-18' }])), records = C.migrate(base);
  const withDue = C.list(C.merge(records, C.edit(records, base, [{ ...base[0], due: '2026-10-20T17:00' }])));
  assert.equal(withDue[0].due, '2026-10-20T17:00');
  assert.equal(withDue[0].date, '2026-10-18', 'the deadline never moves the planned day');
  const after = C.migrate(withDue);
  const { due, ...rest } = withDue[0];
  assert.equal(C.list(C.edit(after, withDue, [rest]))[0].due, undefined);
});
