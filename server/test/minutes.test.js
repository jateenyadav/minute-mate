import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, parseClock, joinParts, windows, search, passages, cleanMinutes, toMarkdown } from '../minutes.js';
import { demoMeeting } from '../demo.js';

test('clock and parseClock round-trip', () => {
  assert.equal(clock(75), '01:15');
  assert.equal(clock(3725), '1:02:05');
  assert.equal(parseClock('01:15'), 75);
  assert.equal(parseClock('[1:02:05]'), 3725);
  assert.equal(parseClock(12), 12);
  assert.equal(parseClock('soon'), null);
  assert.equal(parseClock(''), null);
});

test('joinParts sorts pieces and drops Whisper silence hallucinations', () => {
  const segs = joinParts([
    { i: 1, segments: [{ s: 90, e: 92, t: 'Second part.' }, { s: 95, e: 99, t: 'Thank you.' }] },
    { i: 0, segments: [{ s: 0, e: 2, t: 'First part.' }, { s: 3, e: 4, t: '[Music]' }] },
  ]);
  assert.deepEqual(segs.map((s) => s.t), ['First part.', 'Second part.']);
});

test('windows split at segment boundaries under the word budget', () => {
  const segs = Array.from({ length: 30 }, (_, i) => ({ s: i * 10, e: i * 10 + 9, t: 'word '.repeat(100).trim() }));
  const w = windows(segs, 1100);
  assert.equal(w.length, 3);
  assert.ok(w.every((x) => x.length <= 11));
  assert.equal(w.flat().length, 30);
});

test('search finds the right moment of the sample meeting', () => {
  const { segments } = demoMeeting();
  const top = search(segments, 'who owns the cashback budget from finance?', 2);
  assert.ok(top.flat().some((s) => /finance by Monday/.test(s.t)));
  const anything = search(segments, 'what?', 3);
  assert.equal(anything.length, 3, 'no keyword match falls back to spread-out passages');
  assert.ok(passages(segments).every((p) => p.length >= 1));
});

test('cleanMinutes drops empty items and impossible timestamps', () => {
  const m = cleanMinutes({ decisions: [{ text: 'A', at: 10 }, { text: null, at: 1 }], actions: [{ task: 'B', owner: 'X', due: null, at: 999 }] }, 120);
  assert.equal(m.decisions.length, 1);
  assert.equal(m.actions[0].at, null);
  assert.equal(m.actions[0].done, false);
});

test('markdown export has every section', () => {
  const md = toMarkdown(demoMeeting());
  for (const h of ['## Summary', '## Decisions', '## Action items', '## Open questions', '## Transcript']) assert.match(md, new RegExp(h));
  assert.match(md, /- \[x\] Write the spec/);
});
