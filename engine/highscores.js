/* ============================================================================
   Arcade High Scores
   ----------------------------------------------------------------------------
   A tiny, DOM-agnostic high-score store shared by the hub and every game.

   Two layers, both pure-ish and unit-tested (see highscores.test.js):
     - ranking logic   : qualifies() / rankInsert() / sortTrim()  (no I/O)
     - persistence      : load() / save() / submit() / top()       (Storage)

   Scores live in localStorage under `arcade.hs.<gameId>` as a JSON array of
   { name, score, ts }. `order` is 'desc' (higher is better, default) or 'asc'
   (lower is better). The board is capped to MAX (top ten — classic arcade).

   Runs in the browser (window.HighScores) and Node (module.exports) so the
   ranking logic can be tested without a DOM. Storage is injectable, so tests
   pass an in-memory stub instead of localStorage.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HighScores = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX = 10;                 // top ten
  const PREFIX = 'arcade.hs.';
  const PLAYER_KEY = 'arcade.player';        // the identity picked this session
  const LAST_PLAYER_KEY = 'arcade.player.last';  // previous answer, prompt prefill only

  function cmp(order) {
    // Sort so the BEST score is first. 'asc' => smaller is better.
    return (order === 'asc') ? (a, b) => a - b : (a, b) => b - a;
  }

  // Sort a list best-first and trim to `max`. Ties broken by earliest ts
  // (the older record keeps the higher rank — first to get there wins).
  function sortTrim(list, order, max) {
    if (max == null) max = MAX;
    const c = cmp(order);
    const out = (list || []).slice().sort(
      (a, b) => c(a.score, b.score) || ((a.ts || 0) - (b.ts || 0))
    );
    return out.slice(0, max);
  }

  // Would `score` earn a spot on the board?
  function qualifies(list, score, order, max) {
    order = order || 'desc';
    if (max == null) max = MAX;
    if (typeof score !== 'number' || !isFinite(score)) return false;
    const board = sortTrim(list, order, max);
    if (board.length < max) return true;
    const worst = board[board.length - 1];
    return (order === 'asc') ? (score < worst.score) : (score > worst.score);
  }

  // Insert `entry` and re-rank. Returns { list, rank }; rank is the 0-based
  // position of `entry` on the trimmed board, or -1 if it didn't make it.
  function rankInsert(list, entry, order, max) {
    order = order || 'desc';
    if (max == null) max = MAX;
    const merged = sortTrim((list || []).concat([entry]), order, max);
    return { list: merged, rank: merged.indexOf(entry) };
  }

  // ---- persistence ---------------------------------------------------------
  function defaultStorage() {
    try { if (typeof localStorage !== 'undefined') return localStorage; } catch (e) {}
    return null;
  }
  function key(gameId) { return PREFIX + gameId; }

  function load(gameId, storage) {
    storage = storage || defaultStorage();
    if (!storage) return [];
    try {
      const raw = storage.getItem(key(gameId));
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr)
        ? arr.filter((e) => e && typeof e.score === 'number' && isFinite(e.score))
        : [];
    } catch (e) { return []; }
  }

  function save(gameId, list, storage) {
    storage = storage || defaultStorage();
    if (!storage) return;
    try { storage.setItem(key(gameId), JSON.stringify(list)); } catch (e) {}
  }

  // Normalize a name to the arcade shape: A–Z0–9, capped to maxLen (default 3,
  // the classic initials length; win-tally boards pass a longer maxLen so real
  // player names like MOTI / ADA survive).
  function sanitizeName(name, maxLen) {
    if (maxLen == null) maxLen = 3;
    const s = String(name == null ? '' : name).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, maxLen);
    return s || 'AAA';
  }

  function now() { try { return Date.now(); } catch (e) { return 0; } }

  // Record a score. Returns { list, rank, entry } — rank -1 means off the board
  // (still saved to nothing; the caller usually checks qualifies() first).
  function submit(gameId, name, score, opts) {
    opts = opts || {};
    const order = opts.order || 'desc';
    const max = (opts.max == null) ? MAX : opts.max;
    const storage = opts.storage;
    const ts = (opts.ts == null) ? now() : opts.ts;
    const entry = { name: sanitizeName(name, opts.maxLen), score: score, ts: ts };
    const { list, rank } = rankInsert(load(gameId, storage), entry, order, max);
    save(gameId, list, storage);
    return { list: list, rank: rank, entry: entry };
  }

  // Cumulative tally: add `delta` (default 1) to the named player's running
  // total for a game, keyed by name (one row per player). Used by win-based
  // games (tic-tac-toe, Connect 4) where the "high score" is total wins.
  function bump(gameId, name, delta, opts) {
    opts = opts || {};
    const storage = opts.storage;
    const order = opts.order || 'desc';
    const max = (opts.max == null) ? MAX : opts.max;
    const inc = (delta == null) ? 1 : delta;
    const nm = sanitizeName(name, opts.maxLen == null ? 12 : opts.maxLen);
    const list = load(gameId, storage);
    let entry = null;
    for (let i = 0; i < list.length; i++) { if (list[i].name === nm) { entry = list[i]; break; } }
    if (entry) entry.score += inc;
    else list.push({ name: nm, score: inc, ts: (opts.ts == null ? now() : opts.ts) });
    const trimmed = sortTrim(list, order, max);
    save(gameId, trimmed, storage);
    return trimmed;
  }

  // ---- shared player identity ----------------------------------------------
  // "Who's playing?" is asked once per browser SESSION. The answer lives in
  // sessionStorage: it survives navigating between the hub and the games
  // (same-tab page loads share it) but a fresh visit asks again — kids swap
  // chairs between visits. The most recent answer is also kept in
  // localStorage, purely as a prompt prefill, never as an identity.
  function defaultSession() {
    try { if (typeof sessionStorage !== 'undefined') return sessionStorage; } catch (e) {}
    return null;
  }

  function readName(storage, k) {
    if (!storage) return '';
    try {
      const raw = storage.getItem(k);
      if (!raw) return '';                       // unset — don't fabricate 'AAA'
      return String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    } catch (e) { return ''; }
  }

  function player(storage) {
    return readName(storage || defaultSession(), PLAYER_KEY);
  }

  // The previous session's name — offered as a prefill in name prompts.
  function lastPlayer(storage) {
    return readName(storage || defaultStorage(), LAST_PLAYER_KEY);
  }

  function setPlayer(name, storage) {
    storage = storage || defaultSession();
    const nm = sanitizeName(name, 12);
    if (storage) { try { storage.setItem(PLAYER_KEY, nm); } catch (e) {} }
    const last = defaultStorage();
    if (last) { try { last.setItem(LAST_PLAYER_KEY, nm); } catch (e) {} }
    return nm;
  }

  function top(gameId, n, opts) {
    opts = opts || {};
    const board = sortTrim(load(gameId, opts.storage), opts.order || 'desc', opts.max || MAX);
    return (n != null) ? board.slice(0, n) : board;
  }

  function clear(gameId, storage) {
    storage = storage || defaultStorage();
    if (storage) { try { storage.removeItem(key(gameId)); } catch (e) {} }
  }

  return {
    MAX, PREFIX, PLAYER_KEY, LAST_PLAYER_KEY,
    cmp, sortTrim, qualifies, rankInsert, sanitizeName,
    key, load, save, submit, bump, top, clear,
    player, setPlayer, lastPlayer,
  };
});
