/* ============================================================================
   Fractal Connect 4
   ----------------------------------------------------------------------------
   A game module for the Fractal Shell. The pieces ARE the shell's WebGL
   fractal spheres — each player gets a different sphere *shape* and *color*:
     • Player 1 — luminous Julia "stalks", warm palette half (tint 0).
     • Player 2 — banded Mandelbrot "bands", cool palette half (tint 1).
   Drop discs down the 7×6 grid; first to line up four (horizontal, vertical,
   or diagonal) wins.

   The twist: the EXPLODING piece. There's no arming — the game itself randomly
   turns up to 3 drops over the course of a match into a glowing Newton "nova"
   sphere. You still pick the column and it falls normally, but when a bomb lands
   it detonates: the bomb itself plus ~20% of the other pieces are destroyed at
   random, then gravity collapses what's left. The collapse itself can complete
   (or wreck) a four-in-a-row, so it's re-checked.

   Coordinates are CSS pixels. (0,0) is the top-left of the play area. The shell
   owns all chrome (header, back link, fullscreen, New Game, mode/theme switch)
   and the high-score plumbing.

   Authored by Moti & Claude.
   ========================================================================== */
(function () {
  'use strict';

  const COLS = 7, ROWS = 6;
  const BOMBS_PER_GAME = 3;             // up to this many drops become bombs
  const BOMB_CHANCE = 0.18;            // chance a given drop is randomly a bomb
  const DESTROY_FRAC = 0.20;           // a bomb destroys ~20% of OTHER pieces
  const AI_DELAY = 0.5;                // seconds the computer "thinks"

  // Per-player sphere identity — a distinct fractal LOOK and palette half.
  // Accent colors here are only for the 2D HUD (names, status, win line);
  // the spheres themselves are colored by the shell's theme + tint.
  const SIDES = {
    1: { look: 'stalks', tint: 0, seed: 0.18, accent: '#ff7a2c', soft: '#ffd0a3' },
    2: { look: 'bands',  tint: 1, seed: 0.61, accent: '#2cb1ff', soft: '#b9e6ff' },
  };
  const BOMB = { look: 'nova', accent: '#ffe27a', soft: '#fff4c2' };

  const CONFETTI = ['#ff7a2c', '#ffd0a3', '#2cb1ff', '#b9e6ff',
                    '#ffe27a', '#6bbf59', '#e85d75', '#ffffff'];

  // After a game ends, ignore taps briefly so the SAME tap that won can't
  // immediately reset the board (touch fires touchstart + pointerdown).
  const END_LOCK = 0.6;

  const Connect4Game = {
    id: 'connect4',
    title: 'Connect 4',
    subtitle: 'Four in a row — with exploding spheres',
    aspect: COLS / ROWS,
    stageMax: 720,
    hint: 'Drop in a column — four in a row wins   ·   random 💥 bombs blow up part of the board',

    modes: [
      { id: '1p', label: '1 Player' },
      { id: '2p', label: '2 Players' },
    ],

    // Side 2 is the AI in 1P — labeled 'Computer' unless a second human types over it.
    players: [
      { defaultName: 'Player 1', color: SIDES[1].accent, maxLength: 12 },
      { defaultName: (shell) => (shell.mode === '1p' ? 'Computer' : 'Player 2'),
        color: SIDES[2].accent, maxLength: 12 },
    ],

    state: null,

    // ---- lifecycle -----------------------------------------------------------
    reset(shell) {
      this.state = {
        grid: new Array(COLS * ROWS).fill(null),  // null | piece
        turn: 1,
        phase: 'idle',          // idle | dropping | exploding | settling | over
        bombsLeft: BOMBS_PER_GAME,  // bombs still up for grabs this game
        winner: null,           // 1 | 2 | 'draw' | null
        winCells: null,         // [i,i,i,i] grid indices of the winning four
        winAnim: 0,
        hoverCol: -1,
        aiTimer: 0,
        active: null,           // the piece currently being resolved
        explodeT: 0,            // detonation flash timer
        endLock: 0,
        recorded: false,
        confetti: [],
        shards: [],             // per-piece explosion debris
        t: 0,
      };
      this._geom(shell, shell.size.w, shell.size.h);
    },

    resize(shell, w, h) { this._geom(shell, w, h); },

    _geom(shell, w, h) {
      this.w = w; this.h = h;
      // Fit a 7×6 grid in the play area, RESERVING vertical headroom for the
      // HUD: the turn/status line sits above the board and the rematch hint
      // sits below it. Without this the board fills the whole area (most badly
      // in landscape fullscreen, where it's limited by height) and the HUD text
      // gets drawn off the top/bottom edges — the "doesn't render properly"
      // bug. padTop/padBot are in cell units and are deducted from the height
      // budget so the board shrinks just enough to keep the labels on-screen.
      const padTop = 1.1, padBot = 1.0;
      const cell = Math.min(w / COLS, h / (ROWS + padTop + padBot));
      this.cell = cell;
      this.bw = cell * COLS;
      this.bh = cell * ROWS;
      this.x0 = (w - this.bw) / 2;
      // Center the board in the leftover space, but never eat into the reserved
      // top/bottom padding (centering only ever adds to both margins).
      this.y0 = padTop * cell + (h - (padTop + padBot) * cell - this.bh) / 2;
      this.r = cell * 0.40;
      // Re-pin settled pieces to their (possibly new) cell centers.
      const s = this.state;
      if (s) for (let i = 0; i < s.grid.length; i++) {
        const p = s.grid[i];
        if (p && p.settled) { p.vy = this._cy(this._row(i)); }
      }
    },

    _col(i) { return i % COLS; },
    _row(i) { return (i / COLS) | 0; },
    _idx(col, row) { return row * COLS + col; },
    _cx(col) { return this.x0 + (col + 0.5) * this.cell; },
    _cy(row) { return this.y0 + (row + 0.5) * this.cell; },

    // ---- update --------------------------------------------------------------
    update(shell, dt) {
      const s = this.state;
      if (!s) return;
      s.t += dt;
      if (s.endLock > 0) s.endLock = Math.max(0, s.endLock - dt);
      if (s.winAnim < 1 && s.winCells) s.winAnim = Math.min(1, s.winAnim + dt * 3);
      if (s.confetti.length) this._updateConfetti(dt);
      if (s.shards.length) this._updateShards(dt);

      this._physics(dt);

      if (s.phase === 'dropping') {
        if (s.active && s.active.settled) this._afterDrop(shell);
      } else if (s.phase === 'exploding') {
        s.explodeT -= dt;
        if (s.explodeT <= 0) this._collapse(shell);
      } else if (s.phase === 'settling') {
        if (this._allSettled()) this._afterCollapse(shell);
      }

      // Computer's turn (1P only).
      if (s.phase === 'idle' && shell.mode === '1p' && s.turn === 2 && !s.winner) {
        s.aiTimer -= dt;
        if (s.aiTimer <= 0) this._aiMove(shell);
      }
    },

    // Gravity for every piece's visual y; pieces rest at their cell center
    // with a small bounce. Doomed pieces (mid-detonation) just sit and flash.
    _physics(dt) {
      const s = this.state;
      const G = this.cell * 26;
      for (let i = 0; i < s.grid.length; i++) {
        const p = s.grid[i];
        if (!p || p.settled || p.doomed) continue;
        const ty = this._cy(this._row(i));
        p.vv += G * dt;
        p.vy += p.vv * dt;
        if (p.vy >= ty) {
          p.vy = ty;
          if (p.vv > this.cell * 5) p.vv = -p.vv * 0.22;   // bounce
          else { p.vv = 0; p.settled = true; }
        }
      }
    },

    _allSettled() {
      const s = this.state;
      for (const p of s.grid) if (p && !p.settled) return false;
      return true;
    },

    // ---- input ---------------------------------------------------------------
    onPointerMove(shell, x, y) {
      const s = this.state; if (!s) return;
      if (s.phase !== 'idle' || (shell.mode === '1p' && s.turn === 2)) {
        s.hoverCol = -1; return;
      }
      s.hoverCol = this._colAt(x);
    },
    onPointerDown(shell, x, y) {
      const s = this.state; if (!s) return;
      if (s.winner) { if (s.endLock <= 0) this.reset(shell); return; }
      if (s.phase !== 'idle') return;
      if (shell.mode === '1p' && s.turn === 2) return;     // wait for computer
      const col = this._colAt(x);
      if (col >= 0) this._drop(shell, col);
    },
    onKeyDown(shell, e) {
      const s = this.state; if (!s) return;
      if ((e.key === ' ' || e.key === 'Enter') && s.winner && s.endLock <= 0) {
        e.preventDefault(); this.reset(shell); return;
      }
    },

    _colAt(x) {
      const gx = x - this.x0;
      if (gx < 0 || gx >= this.bw) return -1;
      return Math.min(COLS - 1, Math.floor(gx / this.cell));
    },

    // ---- dropping a piece ----------------------------------------------------
    _landingRow(col) {
      const s = this.state;
      for (let row = ROWS - 1; row >= 0; row--) {
        if (!s.grid[this._idx(col, row)]) return row;
      }
      return -1;     // column full
    },

    _drop(shell, col) {
      const s = this.state;
      const row = this._landingRow(col);
      if (row < 0) return;                 // column full
      // No arming — the game randomly turns up to BOMBS_PER_GAME drops into a
      // bomb. You still chose the column; it just happens to be live.
      const isBomb = s.bombsLeft > 0 && Math.random() < BOMB_CHANCE;
      if (isBomb) s.bombsLeft--;

      const p = {
        player: s.turn,
        bomb: isBomb,
        seed: (isBomb ? 0.5 : SIDES[s.turn].seed) + Math.sin(s.t * 13.7) * 0.07,
        vy: this.y0 - this.cell,         // start above the board
        vv: 0,
        settled: false,
        doomed: false,
        dieT: 0,
        born: 0.18,                      // brief landing flash budget
      };
      s.grid[this._idx(col, row)] = p;
      s.active = p;
      s.hoverCol = -1;
      s.phase = 'dropping';
      shell.refreshControls && shell.refreshControls();
    },

    _afterDrop(shell) {
      const s = this.state;
      const p = s.active;
      s.active = null;
      if (p && p.bomb) { this._detonate(shell, p); return; }
      this._resolve(shell);
    },

    // ---- explosion -----------------------------------------------------------
    _detonate(shell, bombPiece) {
      const s = this.state;
      const bi = s.grid.indexOf(bombPiece);

      // Every OTHER occupied cell is a candidate; ~20% of them die at random.
      const others = [];
      for (let i = 0; i < s.grid.length; i++) {
        if (s.grid[i] && i !== bi) others.push(i);
      }
      let kill = Math.max(2, Math.round(others.length * DESTROY_FRAC));
      kill = Math.min(kill, others.length);

      // Random selection without replacement (Fisher–Yates prefix).
      for (let i = others.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const tmp = others[i]; others[i] = others[j]; others[j] = tmp;
      }
      const doomed = others.slice(0, kill);
      for (const i of doomed) {
        s.grid[i].doomed = true; s.grid[i].dieT = 0;
        // Each existing ball bursts into a spray of shards in ITS OWN color,
        // so they blow apart visibly instead of fading silently — and look
        // distinct from the bomb's golden shockwave.
        this._burstShards(i, SIDES[s.grid[i].player]);
      }
      // The bomb piece ALWAYS goes too, so a detonation is never a no-op.
      if (bi >= 0) { s.grid[bi].doomed = true; s.grid[bi].dieT = 0; }

      s.blast = (bi >= 0) ? { x: this._cx(this._col(bi)), y: this._cy(this._row(bi)) } : null;
      s.explodeT = 0.55;
      s.phase = 'exploding';
    },

    _collapse(shell) {
      const s = this.state;
      // Remove doomed pieces.
      for (let i = 0; i < s.grid.length; i++) {
        if (s.grid[i] && s.grid[i].doomed) s.grid[i] = null;
      }
      // Gravity: per column, restack survivors to the bottom; they re-fall.
      for (let col = 0; col < COLS; col++) {
        const stack = [];
        for (let row = ROWS - 1; row >= 0; row--) {
          const p = s.grid[this._idx(col, row)];
          if (p) stack.push(p);
          s.grid[this._idx(col, row)] = null;
        }
        // `stack` is bottom→up; place back from the bottom.
        for (let k = 0; k < stack.length; k++) {
          const row = ROWS - 1 - k;
          const p = stack[k];
          s.grid[this._idx(col, row)] = p;
          // If it needs to fall to a lower row, re-animate it.
          if (p.vy < this._cy(row) - 1) { p.settled = false; }
          else { p.vy = this._cy(row); p.settled = true; }
        }
      }
      s.blast = null;
      s.phase = 'settling';
    },

    _afterCollapse(shell) {
      // The collapse may have created — or destroyed — a four-in-a-row.
      this._resolve(shell, /*fromBlast*/ true);
    },

    // ---- resolve a settled board ---------------------------------------------
    _resolve(shell, fromBlast) {
      const s = this.state;
      const res = this._evaluate();
      if (res.winner) {
        s.winner = res.winner;
        s.winCells = res.cells;
        s.winAnim = 0;
        s.phase = 'over';
        s.endLock = END_LOCK;
        this._burstConfetti();
        this._record(shell);
        shell.refreshControls && shell.refreshControls();
        return;
      }
      if (s.grid.every(Boolean)) {
        s.winner = 'draw';
        s.phase = 'over';
        s.endLock = END_LOCK;
        shell.refreshControls && shell.refreshControls();
        return;
      }
      // Bomb explosions don't pass the turn (the detonation WAS your move's
      // payload, and the turn already changed below for the drop). Keep it
      // simple: a normal drop and a bomb drop both end the turn here.
      s.turn = s.turn === 1 ? 2 : 1;
      s.phase = 'idle';
      if (shell.mode === '1p' && s.turn === 2) s.aiTimer = AI_DELAY;
      shell.refreshControls && shell.refreshControls();
    },

    _record(shell) {
      const s = this.state;
      if (s.recorded || !shell.reportWin || s.winner === 'draw') return;
      const idx = s.winner - 1;
      if (shell.mode === '1p' && idx !== 0) { s.recorded = true; return; }
      s.recorded = true;
      shell.reportWin({ game: 'connect4', player: shell.playerName(idx) });
    },

    // ---- win detection -------------------------------------------------------
    _evaluate() {
      const s = this.state, g = s.grid;
      const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
      for (let col = 0; col < COLS; col++) {
        for (let row = 0; row < ROWS; row++) {
          const base = g[this._idx(col, row)];
          if (!base) continue;
          for (const [dc, dr] of dirs) {
            const cells = [this._idx(col, row)];
            let ok = true;
            for (let k = 1; k < 4; k++) {
              const c = col + dc * k, rr = row + dr * k;
              if (c < 0 || c >= COLS || rr < 0 || rr >= ROWS) { ok = false; break; }
              const p = g[this._idx(c, rr)];
              if (!p || p.player !== base.player) { ok = false; break; }
              cells.push(this._idx(c, rr));
            }
            if (ok) return { winner: base.player, cells };
          }
        }
      }
      return { winner: null, cells: null };
    },

    // ---- computer opponent (heuristic) --------------------------------------
    _aiMove(shell) {
      const s = this.state;
      const valid = [];
      for (let c = 0; c < COLS; c++) if (this._landingRow(c) >= 0) valid.push(c);
      if (!valid.length) return;

      // 1) Win now.
      let move = this._findLine(2);
      // 2) Block the human's win.
      if (move == null) move = this._findLine(1);
      // 3) Prefer the center, with a little spread.
      if (move == null) {
        const order = [3, 2, 4, 1, 5, 0, 6].filter((c) => valid.includes(c));
        move = order[Math.min(order.length - 1, (Math.random() * 2) | 0)];
        if (move == null) move = valid[(Math.random() * valid.length) | 0];
      }
      this._drop(shell, move);
    },

    // Return a column where `player` would immediately complete four, else null.
    _findLine(player) {
      const s = this.state;
      for (let c = 0; c < COLS; c++) {
        const row = this._landingRow(c);
        if (row < 0) continue;
        const i = this._idx(c, row);
        s.grid[i] = { player };               // tentatively place
        const win = this._evaluate().winner === player;
        s.grid[i] = null;                      // undo
        if (win) return c;
      }
      return null;
    },

    // ---- spheres: the pieces themselves -------------------------------------
    spheres(shell) {
      const s = this.state;
      if (!s) return [];
      const out = [];

      // A ghost preview sphere at the top of the hovered column (desktop).
      if (s.phase === 'idle' && s.hoverCol >= 0 && this._landingRow(s.hoverCol) >= 0
          && !(shell.mode === '1p' && s.turn === 2)) {
        const side = SIDES[s.turn];
        out.push({
          x: this._cx(s.hoverCol),
          y: this.y0 - this.cell * 0.15,
          r: this.r * 0.62,
          tint: side.tint,
          look: side.look,
          seed: side.seed,
          zoom: 1.0,
          hover: true,
          capture: 0,
          frozen: false,
        });
      }

      for (let i = 0; i < s.grid.length; i++) {
        const p = s.grid[i];
        if (!p) continue;
        const side = SIDES[p.player];
        let r = this.r, capture = 0;
        if (p.doomed) {
          // Detonation: flare white then shrink away.
          const k = Math.min(1, p.dieT / 0.55);
          r = this.r * (1 - k * k);
          capture = 1.0;
        } else if (p.bomb) {
          capture = 0.30 + 0.20 * Math.sin(s.t * 7 + p.seed * 6.28);
        } else if (p.born > 0) {
          capture = Math.min(0.8, p.born * 4);   // brief flash on landing
        }
        // Glow the four winning spheres.
        const inWin = s.winCells && s.winCells.includes(i);
        if (inWin) capture = Math.max(capture, 0.35 + 0.35 * Math.sin(s.t * 6));

        out.push({
          x: this._cx(this._col(i)),
          y: p.vy,
          r,
          tint: p.bomb ? (p.player === 1 ? 0 : 1) : side.tint,
          look: p.bomb ? BOMB.look : side.look,
          seed: p.seed,
          zoom: p.bomb ? 1.25 : 1.0,
          hover: inWin || (p.bomb && !p.doomed),
          capture,
          frozen: !!s.winner && p.settled && !inWin,
        });
        if (p.born > 0) p.born = Math.max(0, p.born - 0.016);
        if (p.doomed) p.dieT += 0.016;
      }
      return out;
    },

    // ---- background: the grid frame ------------------------------------------
    drawBackground(shell, ctx, w, h) {
      ctx.fillStyle = '#05060c';
      ctx.fillRect(0, 0, w, h);

      const amb = ctx.createRadialGradient(w / 2, h * 0.0, 0, w / 2, h * 0.0, Math.max(w, h));
      amb.addColorStop(0, 'rgba(40, 60, 110, 0.28)');
      amb.addColorStop(0.5, 'rgba(20, 18, 40, 0.10)');
      amb.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = amb;
      ctx.fillRect(0, 0, w, h);

      const { x0, y0, bw, bh, cell } = this;

      // Hovered-column highlight.
      const s = this.state;
      if (s && s.phase === 'idle' && s.hoverCol >= 0 && !s.winner) {
        ctx.save();
        ctx.fillStyle = 'rgba(120, 170, 255, 0.07)';
        ctx.fillRect(x0 + s.hoverCol * cell, y0, cell, bh);
        ctx.restore();
      }

      // Board backing.
      ctx.save();
      ctx.fillStyle = 'rgba(18, 22, 38, 0.55)';
      this._roundRect(ctx, x0 - cell * 0.08, y0 - cell * 0.08,
                      bw + cell * 0.16, bh + cell * 0.16, cell * 0.12);
      ctx.fill();
      ctx.restore();

      // The seven slot columns + the round wells, lightly glowing. All 42
      // rings share one style — batch them into a single stroke call
      // (identical output, 42 strokes -> 1).
      ctx.save();
      ctx.strokeStyle = 'rgba(120, 150, 220, 0.30)';
      ctx.lineWidth = Math.max(1.5, cell * 0.03);
      ctx.beginPath();
      const wellR = this.r * 1.06;
      for (let col = 0; col < COLS; col++) {
        for (let row = 0; row < ROWS; row++) {
          const cx = this._cx(col), cy = this._cy(row);
          ctx.moveTo(cx + wellR, cy);
          ctx.arc(cx, cy, wellR, 0, Math.PI * 2);
        }
      }
      ctx.stroke();
      ctx.restore();
    },

    // ---- foreground: blast ring, status, win line, rematch hint -------------
    drawForeground(shell, ctx, w, h) {
      const s = this.state; if (!s) return;

      // Detonation shockwave ring.
      if (s.blast && s.phase === 'exploding') {
        const k = 1 - Math.max(0, s.explodeT) / 0.55;
        const rad = this.cell * (0.4 + k * 4.5);
        ctx.save();
        ctx.globalAlpha = (1 - k) * 0.8;
        ctx.strokeStyle = BOMB.soft;
        ctx.lineWidth = this.cell * 0.18 * (1 - k);
        ctx.shadowColor = BOMB.accent;
        ctx.shadowBlur = this.cell * 0.5;
        ctx.beginPath();
        ctx.arc(s.blast.x, s.blast.y, rad, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Winning line.
      if (s.winCells && s.winAnim > 0) {
        const a = s.winCells[0], b = s.winCells[3];
        const ax = this._cx(this._col(a)), ay = this._cy(this._row(a));
        const bx = this._cx(this._col(b)), by = this._cy(this._row(b));
        const t = this._ease(s.winAnim);
        const ex = ax + (bx - ax) * t, ey = ay + (by - ay) * t;
        const side = SIDES[s.winner];
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineWidth = this.cell * 0.10;
        ctx.strokeStyle = side.soft;
        ctx.shadowColor = side.accent;
        ctx.shadowBlur = this.cell * 0.3;
        ctx.beginPath();
        ctx.moveTo(ax, ay); ctx.lineTo(ex, ey);
        ctx.stroke();
        ctx.restore();
      }

      this._status(shell, ctx, w, h);

      if (s.winner) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(225, 232, 245, 0.7)';
        ctx.font = '300 ' + Math.round(this.cell * 0.34) + 'px -apple-system, system-ui, sans-serif';
        ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = this.cell * 0.15;
        ctx.fillText('Tap or press Space for a rematch', w / 2, this.y0 + this.bh + this.cell * 0.55);
        ctx.restore();
      }

      this._drawShards(ctx);
      this._drawConfetti(ctx);
    },

    _status(shell, ctx, w, h) {
      const s = this.state;
      let text, color;
      if (s.winner === 'draw') { text = 'Draw — board full'; color = '#e1e8f5'; }
      else if (s.winner) {
        text = shell.playerName(s.winner - 1) + ' wins!';
        color = SIDES[s.winner].soft;
      } else {
        const thinking = (shell.mode === '1p' && s.turn === 2);
        text = thinking ? (shell.playerName(1) + ' is thinking…') : (shell.playerName(s.turn - 1) + '’s turn');
        color = SIDES[s.turn].soft;
      }
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '600 ' + Math.round(this.cell * 0.40) + 'px -apple-system, system-ui, sans-serif';
      ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = this.cell * 0.12;
      ctx.fillStyle = color;
      ctx.fillText(text, w / 2, this.y0 - this.cell * 0.42);
      ctx.restore();
    },

    // ---- shards: a doomed ball blowing apart in its own color ---------------
    _burstShards(gridIdx, side) {
      const s = this.state;
      const cx = this._cx(this._col(gridIdx)), cy = this._cy(this._row(gridIdx));
      const rnd = (a, b) => a + Math.random() * (b - a);
      const cell = this.cell || 60;
      const n = 12 + (Math.random() * 5 | 0);
      for (let k = 0; k < n; k++) {
        const ang = (k / n) * Math.PI * 2 + rnd(-0.25, 0.25);
        const spd = rnd(2.2, 6.2) * cell;
        s.shards.push({
          x: cx, y: cy,
          vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - rnd(0.4, 1.6) * cell,
          rot: rnd(0, Math.PI * 2), vrot: rnd(-16, 16),
          len: rnd(0.10, 0.26) * cell, wid: rnd(0.04, 0.10) * cell,
          color: Math.random() < 0.35 ? side.soft : side.accent,
          life: rnd(0.45, 0.8), max: 0.8,
        });
      }
      // A short bright core flash where the ball was.
      s.shards.push({ flash: true, x: cx, y: cy, r: this.r * 1.6,
                      color: side.soft, life: 0.22, max: 0.22 });
    },

    _updateShards(dt) {
      const s = this.state;
      const cell = this.cell || 60, drag = 2.6, g = 5.0 * cell, next = [];
      for (const p of s.shards) {
        p.life -= dt;
        if (p.life <= 0) continue;
        if (!p.flash) {
          p.vy += g * dt;
          const d = Math.max(0, 1 - drag * dt);
          p.vx *= d; p.vy *= d;
          p.x += p.vx * dt; p.y += p.vy * dt;
          p.rot += p.vrot * dt;
        }
        next.push(p);
      }
      s.shards = next;
    },

    _drawShards(ctx) {
      const s = this.state;
      if (!s.shards.length) return;
      ctx.save();
      for (const p of s.shards) {
        const a = Math.max(0, Math.min(1, p.life / p.max));
        if (p.flash) {
          ctx.save();
          const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
          grd.addColorStop(0, p.color);
          grd.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.globalAlpha = a;
          ctx.fillStyle = grd;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
          continue;
        }
        ctx.save();
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = p.wid * 3;
        ctx.fillRect(-p.len / 2, -p.wid / 2, p.len, p.wid);
        ctx.restore();
      }
      ctx.restore();
    },

    // ---- confetti (shared style with tic-tac-toe) ---------------------------
    _burstConfetti() {
      const s = this.state;
      const w = this.w || 600, h = this.h || 600;
      const parts = [];
      const rnd = (a, b) => a + Math.random() * (b - a);
      const cannon = (ox, dir) => {
        for (let i = 0; i < 70; i++) parts.push({
          x: ox, y: h + rnd(-10, 10),
          vx: dir * rnd(60, 320), vy: rnd(-820, -520),
          rot: rnd(0, Math.PI * 2), vrot: rnd(-9, 9),
          w: rnd(6, 13), h: rnd(8, 18),
          color: CONFETTI[(Math.random() * CONFETTI.length) | 0],
          life: rnd(2.2, 3.6),
        });
      };
      cannon(0, 1); cannon(w, -1);
      for (let i = 0; i < 50; i++) parts.push({
        x: rnd(0, w), y: rnd(-h * 0.4, -20),
        vx: rnd(-60, 60), vy: rnd(80, 240),
        rot: rnd(0, Math.PI * 2), vrot: rnd(-9, 9),
        w: rnd(6, 13), h: rnd(8, 18),
        color: CONFETTI[(Math.random() * CONFETTI.length) | 0],
        life: rnd(2.6, 4.2),
      });
      s.confetti = parts;
    },

    _updateConfetti(dt) {
      const s = this.state, h = this.h || 600;
      const g = 1500, next = [];
      for (const p of s.confetti) {
        p.life -= dt;
        if (p.life <= 0) continue;
        p.vy += g * dt;
        p.vx *= (1 - 0.6 * dt);
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.rot += p.vrot * dt;
        if (p.y < h + 40) next.push(p);
      }
      s.confetti = next;
    },

    _drawConfetti(ctx) {
      const s = this.state;
      if (!s.confetti.length) return;
      ctx.save();
      for (const p of s.confetti) {
        ctx.save();
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        const sx = 0.55 + 0.45 * Math.abs(Math.cos(p.rot * 1.7));
        ctx.globalAlpha = Math.min(1, p.life);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2 * sx, -p.h / 2, p.w * sx, p.h);
        ctx.restore();
      }
      ctx.restore();
    },

    // ---- helpers -------------------------------------------------------------
    _ease(t) {
      t = Math.max(0, Math.min(1, t));
      return 1 - Math.pow(1 - t, 3);
    },
    _roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    },
  };

  window.Connect4Game = Connect4Game;
})();
