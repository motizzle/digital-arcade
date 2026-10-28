/* Tests for the arcade high-score store. Run with: node --test
   Covers the ranking logic (no I/O) and the persistence layer (in-memory
   Storage stub), so the High Scores feature can't silently regress. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const HS = require('./highscores.js');

// Minimal localStorage-shaped stub.
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}
const E = (score, ts, name) => ({ name: name || 'AAA', score, ts: ts || 0 });

test('qualifies: empty and non-full boards always accept a real number', () => {
  assert.equal(HS.qualifies([], 5), true);
  assert.equal(HS.qualifies([E(100)], 1, 'desc', 10), true); // board not full
});

test('qualifies: rejects non-numbers', () => {
  assert.equal(HS.qualifies([], NaN), false);
  assert.equal(HS.qualifies([], 'x'), false);
  assert.equal(HS.qualifies([], Infinity), false);
});

test('qualifies: full board, desc — only a strictly higher score gets in', () => {
  const full = [];
  for (let i = 0; i < 10; i++) full.push(E(10 + i));   // 10..19
  assert.equal(HS.qualifies(full, 20, 'desc', 10), true);   // beats worst (10)
  assert.equal(HS.qualifies(full, 10, 'desc', 10), false);  // ties worst -> no
  assert.equal(HS.qualifies(full, 9, 'desc', 10), false);
});

test('qualifies: full board, asc — only a strictly lower score gets in', () => {
  const full = [];
  for (let i = 0; i < 10; i++) full.push(E(10 + i));   // worst (asc) is 19
  assert.equal(HS.qualifies(full, 18, 'asc', 10), true);
  assert.equal(HS.qualifies(full, 19, 'asc', 10), false);
  assert.equal(HS.qualifies(full, 25, 'asc', 10), false);
});

test('sortTrim: best-first, ties broken by earliest ts, capped to max', () => {
  const list = [E(5, 30), E(9, 10), E(9, 5), E(1, 99)];
  const out = HS.sortTrim(list, 'desc', 3);
  assert.deepEqual(out.map((e) => [e.score, e.ts]), [[9, 5], [9, 10], [5, 30]]);
  assert.equal(out.length, 3);
});

test('rankInsert: returns the 0-based rank of the new entry', () => {
  const board = [E(100, 1), E(50, 2), E(10, 3)];
  const top = HS.rankInsert(board, E(80, 4), 'desc', 10);
  assert.equal(top.rank, 1);                 // between 100 and 50
  assert.equal(top.list.length, 4);

  const off = HS.rankInsert(
    Array.from({ length: 10 }, (_, i) => E(100 + i, i)), E(1, 99), 'desc', 10);
  assert.equal(off.rank, -1);                // didn't make the trimmed board
});

test('submit + top: round-trips through storage, sanitizes names, caps at MAX', () => {
  const st = memStorage();
  for (let i = 1; i <= 15; i++) HS.submit('serpent', 'a' + i, i, { storage: st, ts: i });
  const board = HS.top('serpent', null, { storage: st });
  assert.equal(board.length, HS.MAX);        // capped at 10
  assert.equal(board[0].score, 15);          // best first
  assert.equal(board[board.length - 1].score, 6);
  assert.ok(/^[A-Z0-9]{1,3}$/.test(board[0].name)); // initials normalized
});

test('submit: rank tells the caller where they landed', () => {
  const st = memStorage();
  HS.submit('pong', 'AAA', 30, { storage: st, ts: 1 });
  const r = HS.submit('pong', 'BBB', 100, { storage: st, ts: 2 });
  assert.equal(r.rank, 0);                    // new best
});

test('sanitizeName: uppercases, strips junk, max 3, never empty', () => {
  assert.equal(HS.sanitizeName('mo!'), 'MO');
  assert.equal(HS.sanitizeName('adam'), 'ADA');
  assert.equal(HS.sanitizeName(''), 'AAA');
  assert.equal(HS.sanitizeName(null), 'AAA');
  assert.equal(HS.sanitizeName('a b c'), 'ABC');
});

test('load: tolerates corrupt / missing storage payloads', () => {
  const st = memStorage();
  st.setItem(HS.key('x'), '{not json');
  assert.deepEqual(HS.load('x', st), []);
  st.setItem(HS.key('y'), JSON.stringify([{ score: 5 }, { nope: 1 }, null]));
  assert.equal(HS.load('y', st).length, 1);  // drops malformed entries
});

test('bump: accumulates wins per player (one row per name), best first', () => {
  const st = memStorage();
  HS.bump('connect4', 'Moti', 1, { storage: st, ts: 1 });
  HS.bump('connect4', 'Ada', 1, { storage: st, ts: 2 });
  HS.bump('connect4', 'Moti', 1, { storage: st, ts: 3 });   // Moti -> 2
  const board = HS.top('connect4', null, { storage: st });
  assert.equal(board.length, 2);                              // deduped by name
  assert.deepEqual(board.map((e) => [e.name, e.score]), [['MOTI', 2], ['ADA', 1]]);
});

test('bump: keeps full player names (longer than 3 chars)', () => {
  const st = memStorage();
  HS.bump('tictactoe', 'Claude', 1, { storage: st });
  assert.equal(HS.top('tictactoe', null, { storage: st })[0].name, 'CLAUDE');
});

test('player identity: round-trips through storage, sanitizes, never fabricates', () => {
  const ss = memStorage();
  assert.equal(HS.player(ss), '');                 // unset — no 'AAA'
  assert.equal(HS.setPlayer('moti!', ss), 'MOTI'); // sanitized on write
  assert.equal(HS.player(ss), 'MOTI');
  const junk = memStorage();
  junk.setItem(HS.PLAYER_KEY, 'adà-9');
  assert.equal(HS.player(junk), 'AD9');           // sanitized on read too
});

test('lastPlayer: reads the prefill key, empty when unset', () => {
  const ls = memStorage();
  assert.equal(HS.lastPlayer(ls), '');
  ls.setItem(HS.LAST_PLAYER_KEY, 'player99');
  assert.equal(HS.lastPlayer(ls), 'PLAYER99');
});

test('clear: wipes a board', () => {
  const st = memStorage();
  HS.submit('z', 'AAA', 9, { storage: st });
  HS.clear('z', st);
  assert.deepEqual(HS.top('z', null, { storage: st }), []);
});
