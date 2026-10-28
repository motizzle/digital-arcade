/* ============================================================================
   Terracotta Tic-Tac-Toe
   ----------------------------------------------------------------------------
   A game module for the Fractal Shell. Unlike pong/serpent it does NOT use the
   WebGL fractal spheres — its pieces are hand-modeled CLAY marks drawn on the
   2D ui layer: X's are glazed BLUE terra-cotta, O's are natural ORANGE
   terra-cotta. The shell still owns all the chrome (header, back link,
   fullscreen, New Game, mode switch) and the high-score plumbing.

   Mechanics:
     - 3×3 board. X (blue) always moves first.
     - 1 Player: you are X, the computer is O (mostly-optimal minimax with an
       occasional blunder so the game is winnable). 2 Players: hot-seat.
     - First to three in a row wins; a full board with no line is a draw.
     - A win is recorded to the shared leaderboard (1P records only human wins).

   Coordinates are CSS pixels. (0,0) is the top-left of the play area.

   Authored by Moti.
   ========================================================================== */
(function () {
  'use strict';

  // Clay palettes — {base, light (top-left rim), dark (bottom-right shade)}.
  const BLUE   = { base: '#4f93b8', light: '#9fd0ea', dark: '#274f66' };  // X — glazed blue terra-cotta
  const ORANGE = { base: '#c46a3f', light: '#ecaa7c', dark: '#793a1f' };  // O — natural terra-cotta

  const WIN_LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],   // rows
    [0, 3, 6], [1, 4, 7], [2, 5, 8],   // cols
    [0, 4, 8], [2, 4, 6],              // diagonals
  ];

  const AI_DELAY = 0.45;     // seconds the computer "thinks" before answering
  const AI_BLUNDER = 0.22;   // chance the computer plays a random (beatable) move

  // After a game ends we ignore taps for this long so the SAME tap that won the
  // game can't immediately reset it. (On touch, one tap fires touchstart AND
  // pointerdown — without this lock the duplicate event hit the rematch branch
  // and instantly wiped the board, so a win never got to show.)
  const END_LOCK = 0.6;      // seconds the board is "frozen on the result"

  // Festive confetti palette — the two clay glazes plus party brights.
  const CONFETTI = ['#4f93b8', '#9fd0ea', '#c46a3f', '#ecaa7c',
                    '#f4d35e', '#6bbf59', '#e85d75', '#ffffff'];

  const TicTacToeGame = {
    id: 'tictactoe',
    title: 'Clauck Tac Toe',
    subtitle: 'Three in a row — clay X vs clay O',
    aspect: 1,                 // square board
    stageMax: 560,
    hint: 'Three in a row wins   ·   Tap a square to place   ·   X (blue) moves first',

    modes: [
      { id: '1p', label: '1 Player' },
      { id: '2p', label: '2 Players' },
    ],

    // Editable name bar above the board, tinted by each side's clay color.
    // O is the AI in 1P — labeled 'Computer' unless a second human types over it.
    players: [
      { defaultName: 'Player 1', color: BLUE.base, maxLength: 12 },
      { defaultName: (shell) => (shell.mode === '1p' ? 'Computer' : 'Player 2'),
        color: ORANGE.base, maxLength: 12 },
    ],

    state: null,

    // ---- lifecycle -----------------------------------------------------------
    reset(shell) {
      this.state = {
        cells: new Array(9).fill(null),   // null | 'X' | 'O'
        anim: new Array(9).fill(0),       // 0..1 pop-in per placed mark
        turn: 'X',                        // X always starts
        over: false,
        winner: null,                     // 'X' | 'O' | 'draw' | null
        line: null,                       // winning [i,j,k] for the strike
        lineAnim: 0,                      // 0..1 strike-through draw
        hover: -1,                        // cell under the pointer (desktop)
        aiTimer: 0,                       // countdown before the computer moves
        recorded: false,
        endLock: 0,                       // taps ignored while > 0 (see END_LOCK)
        confetti: [],                     // celebration particles on a win
      };
      this._geom(shell, shell.size.w, shell.size.h);
    },

    resize(shell, w, h) { this._geom(shell, w, h); },

    _geom(shell, w, h) {
      this.w = w; this.h = h;
      // Reserve vertical headroom for the HUD: the status line sits ABOVE the
      // board and the rematch hint sits BELOW it. Without this the square board
      // fills the full height in landscape fullscreen and the HUD text gets
      // drawn over (or off) the top/bottom edges — the "doesn't render
      // properly" bug. `hud` is a band reserved on the top and bottom; the
      // board is sized to fit the leftover height.
      const hud = Math.min(w, h) * 0.13;
      const size = Math.min(w, h - hud * 2);
      this.size = size;
      this.hud = hud;
      this.x0 = (w - size) / 2;
      this.y0 = hud + (h - hud * 2 - size) / 2;
      this.cell = size / 3;
      this.pad = size * 0.02;
    },

    // ---- update --------------------------------------------------------------
    update(shell, dt) {
      const s = this.state;
      if (!s) return;

      // Pop-in animation for placed marks.
      for (let i = 0; i < 9; i++) {
        if (s.cells[i] && s.anim[i] < 1) s.anim[i] = Math.min(1, s.anim[i] + dt * 5.5);
      }
      if (s.over && s.line && s.lineAnim < 1) s.lineAnim = Math.min(1, s.lineAnim + dt * 3.2);

      // Tick down the post-game tap lock and advance the confetti.
      if (s.endLock > 0) s.endLock = Math.max(0, s.endLock - dt);
      if (s.confetti.length) this._updateConfetti(dt);

      // Computer's turn (1P only).
      if (!s.over && shell.mode === '1p' && s.turn === 'O') {
        s.aiTimer -= dt;
        if (s.aiTimer <= 0) this._aiMove(shell);
      }
    },

    // ---- input ---------------------------------------------------------------
    onPointerMove(shell, x, y) {
      const s = this.state; if (!s || s.over) { if (s) s.hover = -1; return; }
      if (shell.mode === '1p' && s.turn === 'O') { s.hover = -1; return; }
      s.hover = this._cellAt(x, y);
    },
    onPointerDown(shell, x, y) {
      const s = this.state; if (!s) return;
      if (s.over) { if (s.endLock <= 0) this.reset(shell); return; }
      if (shell.mode === '1p' && s.turn === 'O') return;   // wait for the computer
      const i = this._cellAt(x, y);
      if (i >= 0 && !s.cells[i]) this._place(shell, i, s.turn);
    },
    onKeyDown(shell, e) {
      const s = this.state; if (!s) return;
      if ((e.key === ' ' || e.key === 'Enter') && s.over && s.endLock <= 0) {
        e.preventDefault(); this.reset(shell);
      }
    },

    _cellAt(x, y) {
      const gx = x - this.x0, gy = y - this.y0;
      if (gx < 0 || gy < 0 || gx >= this.size || gy >= this.size) return -1;
      const col = Math.min(2, Math.floor(gx / this.cell));
      const row = Math.min(2, Math.floor(gy / this.cell));
      return row * 3 + col;
    },

    _place(shell, i, player) {
      const s = this.state;
      s.cells[i] = player;
      s.anim[i] = 0;
      s.hover = -1;

      const res = this._evaluate(s.cells);
      if (res.winner) {
        s.over = true; s.winner = res.winner; s.line = res.line;
        s.endLock = END_LOCK;
        this._burstConfetti(res.winner);
        this._record(shell);
      } else if (res.full) {
        s.over = true; s.winner = 'draw';
        s.endLock = END_LOCK;
      } else {
        s.turn = (player === 'X') ? 'O' : 'X';
        if (shell.mode === '1p' && s.turn === 'O') s.aiTimer = AI_DELAY;
      }
    },

    _record(shell) {
      const s = this.state;
      if (s.recorded || !shell.reportWin) return;
      const idx = s.winner === 'X' ? 0 : 1;
      // In 1P only the human (X) counts; in 2P either player counts.
      if (shell.mode === '1p' && idx !== 0) { s.recorded = true; return; }
      s.recorded = true;
      shell.reportWin({ game: 'tictactoe', player: shell.playerName(idx) });
    },

    // ---- computer opponent (minimax with an occasional blunder) -------------
    _aiMove(shell) {
      const s = this.state;
      const empty = [];
      for (let i = 0; i < 9; i++) if (!s.cells[i]) empty.push(i);
      if (!empty.length) return;
      let move;
      if (Math.random() < AI_BLUNDER) {
        move = empty[(Math.random() * empty.length) | 0];
      } else {
        move = this._best(s.cells.slice(), 'O', 0).move;
        if (move == null) move = empty[(Math.random() * empty.length) | 0];
      }
      this._place(shell, move, 'O');
    },

    // Minimax. O maximizes, X minimizes; depth term prefers faster wins.
    _best(cells, player, depth) {
      const res = this._evaluate(cells);
      if (res.winner === 'O') return { score: 10 - depth };
      if (res.winner === 'X') return { score: depth - 10 };
      if (res.full) return { score: 0 };

      let best = { score: player === 'O' ? -Infinity : Infinity, move: null };
      const next = player === 'O' ? 'X' : 'O';
      for (let i = 0; i < 9; i++) {
        if (cells[i]) continue;
        cells[i] = player;
        const r = this._best(cells, next, depth + 1);
        cells[i] = null;
        if (player === 'O' ? r.score > best.score : r.score < best.score) {
          best = { score: r.score, move: i };
        }
      }
      return best;
    },

    _evaluate(cells) {
      for (const [a, b, c] of WIN_LINES) {
        if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) {
          return { winner: cells[a], line: [a, b, c], full: false };
        }
      }
      return { winner: null, line: null, full: cells.every(Boolean) };
    },

    // ---- spheres: none — this game draws its pieces in 2D --------------------
    spheres() { return []; },

    // ---- background: board panel + glowing grid -----------------------------
    drawBackground(shell, ctx, w, h) {
      ctx.fillStyle = '#06060c';
      ctx.fillRect(0, 0, w, h);

      const amb = ctx.createRadialGradient(w / 2, h * 0.1, 0, w / 2, h * 0.1, Math.max(w, h));
      amb.addColorStop(0, 'rgba(60, 34, 20, 0.30)');
      amb.addColorStop(0.5, 'rgba(24, 16, 30, 0.10)');
      amb.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = amb;
      ctx.fillRect(0, 0, w, h);

      // Board backing — a faintly warm slate the clay sits on.
      const x0 = this.x0, y0 = this.y0, sz = this.size, r = sz * 0.04;
      ctx.save();
      ctx.fillStyle = 'rgba(20, 18, 24, 0.55)';
      this._roundRect(ctx, x0, y0, sz, sz, r);
      ctx.fill();
      ctx.restore();

      // Grid lines — warm, softly glowing.
      ctx.save();
      ctx.strokeStyle = 'rgba(196, 130, 90, 0.55)';
      ctx.lineWidth = Math.max(2, sz * 0.008);
      ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(196, 106, 63, 0.5)';
      ctx.shadowBlur = sz * 0.02;
      const inset = this.cell * 0.12;
      for (let k = 1; k <= 2; k++) {
        const gx = x0 + this.cell * k;
        ctx.beginPath();
        ctx.moveTo(gx, y0 + inset); ctx.lineTo(gx, y0 + sz - inset); ctx.stroke();
        const gy = y0 + this.cell * k;
        ctx.beginPath();
        ctx.moveTo(x0 + inset, gy); ctx.lineTo(x0 + sz - inset, gy); ctx.stroke();
      }
      ctx.restore();
    },

    // ---- foreground: marks, hover ghost, status, win strike, end card -------
    drawForeground(shell, ctx, w, h) {
      const s = this.state; if (!s) return;
      const cell = this.cell;

      // Hover ghost (desktop) — faint outline of the mark you'd place.
      if (s.hover >= 0 && !s.cells[s.hover] && !s.over) {
        const c = this._center(s.hover);
        ctx.save();
        ctx.globalAlpha = 0.18;
        this._mark(ctx, c.x, c.y, s.turn, 1);
        ctx.restore();
      }

      // Placed marks.
      for (let i = 0; i < 9; i++) {
        if (!s.cells[i]) continue;
        const c = this._center(i);
        this._mark(ctx, c.x, c.y, s.cells[i], this._ease(s.anim[i]));
      }

      // Win strike-through.
      if (s.over && s.line) this._strike(ctx, s);

      // Status pill — whose turn, or the result.
      this._status(shell, ctx, w, h);

      if (s.over) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(243, 234, 217, 0.65)';
        ctx.font = '300 ' + Math.round(this.size * 0.04) + 'px -apple-system, system-ui, sans-serif';
        ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = this.size * 0.02;
        ctx.fillText('Tap or press Space for a rematch', w / 2, this.y0 + this.size + this.hud * 0.55);
        ctx.restore();
      }

      // Confetti rains on top of everything.
      this._drawConfetti(ctx);
    },

    _center(i) {
      const col = i % 3, row = (i / 3) | 0;
      return { x: this.x0 + col * this.cell + this.cell / 2,
               y: this.y0 + row * this.cell + this.cell / 2 };
    },

    // Draw a clay X or O centered at (cx,cy), scaled by `scale` (pop-in).
    _mark(ctx, cx, cy, type, scale) {
      if (scale <= 0) return;
      const cell = this.cell;
      const reach = cell * 0.30;            // half-extent of the mark
      const lw = cell * 0.15;               // clay "rod" thickness
      const pal = (type === 'X') ? BLUE : ORANGE;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);

      let pathFn;
      if (type === 'O') {
        pathFn = (c) => { c.beginPath(); c.arc(0, 0, reach, 0, Math.PI * 2); };
      } else {
        pathFn = (c) => {
          c.beginPath();
          c.moveTo(-reach, -reach); c.lineTo(reach, reach);
          c.moveTo(reach, -reach); c.lineTo(-reach, reach);
        };
      }
      this._clay(ctx, pathFn, lw, pal);
      ctx.restore();
    },

    // 3-pass clay stroke: drop-shadowed base, top-left rim light, bottom-right
    // shade — gives the flat path a fired-clay, rounded-rod look.
    _clay(ctx, pathFn, lw, pal) {
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';

      // Base + soft drop shadow.
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = lw * 0.6;
      ctx.shadowOffsetX = lw * 0.14;
      ctx.shadowOffsetY = lw * 0.18;
      ctx.lineWidth = lw;
      ctx.strokeStyle = pal.base;
      pathFn(ctx); ctx.stroke();
      ctx.restore();

      // Bottom-right shade.
      ctx.save();
      ctx.translate(lw * 0.13, lw * 0.15);
      ctx.lineWidth = lw * 0.52;
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = pal.dark;
      pathFn(ctx); ctx.stroke();
      ctx.restore();

      // Top-left rim light.
      ctx.save();
      ctx.translate(-lw * 0.11, -lw * 0.13);
      ctx.lineWidth = lw * 0.40;
      ctx.globalAlpha = 0.75;
      ctx.strokeStyle = pal.light;
      pathFn(ctx); ctx.stroke();
      ctx.restore();

      ctx.restore();
    },

    _strike(ctx, s) {
      const a = this._center(s.line[0]), c = this._center(s.line[2]);
      const t = this._ease(s.lineAnim);
      const ex = a.x + (c.x - a.x) * t, ey = a.y + (c.y - a.y) * t;
      const pal = s.winner === 'X' ? BLUE : ORANGE;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineWidth = this.cell * 0.07;
      ctx.strokeStyle = pal.light;
      ctx.shadowColor = pal.base;
      ctx.shadowBlur = this.cell * 0.18;
      ctx.globalAlpha = 0.92;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.restore();
    },

    _status(shell, ctx, w, h) {
      const s = this.state;
      let text, color;
      if (s.winner === 'draw') { text = "Draw — nobody's clay"; color = '#e8e0d2'; }
      else if (s.winner) {
        const idx = s.winner === 'X' ? 0 : 1;
        text = shell.playerName(idx) + ' wins!';
        color = (s.winner === 'X') ? BLUE.light : ORANGE.light;
      } else {
        const idx = s.turn === 'X' ? 0 : 1;
        const thinking = (shell.mode === '1p' && s.turn === 'O');
        text = thinking ? (shell.playerName(1) + ' is thinking…') : (shell.playerName(idx) + '’s turn');
        color = (s.turn === 'X') ? BLUE.light : ORANGE.light;
      }
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '600 ' + Math.round(this.size * 0.05) + 'px -apple-system, system-ui, sans-serif';
      ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = this.size * 0.02;
      ctx.fillStyle = color;
      ctx.fillText(text, w / 2, this.y0 - this.hud * 0.5);
      ctx.restore();
    },

    // ---- confetti celebration ------------------------------------------------
    // Two corner "cannons" fire up-and-inward plus a sprinkle from above, so the
    // winner gets a proper shower that rains down over the board.
    _burstConfetti() {
      const s = this.state;
      const w = this.w || 600, h = this.h || 600;
      const parts = [];
      const rnd = (a, b) => a + Math.random() * (b - a);

      const cannon = (ox, dir) => {
        for (let i = 0; i < 70; i++) {
          parts.push({
            x: ox, y: h + rnd(-10, 10),
            vx: dir * rnd(60, 320), vy: rnd(-820, -520),
            rot: rnd(0, Math.PI * 2), vrot: rnd(-9, 9),
            w: rnd(6, 13), h: rnd(8, 18),
            color: CONFETTI[(Math.random() * CONFETTI.length) | 0],
            life: rnd(2.2, 3.6),
          });
        }
      };
      cannon(0, 1);                  // bottom-left → up-right
      cannon(w, -1);                 // bottom-right → up-left
      for (let i = 0; i < 50; i++) { // sprinkle from above the board
        parts.push({
          x: rnd(0, w), y: rnd(-h * 0.4, -20),
          vx: rnd(-60, 60), vy: rnd(80, 240),
          rot: rnd(0, Math.PI * 2), vrot: rnd(-9, 9),
          w: rnd(6, 13), h: rnd(8, 18),
          color: CONFETTI[(Math.random() * CONFETTI.length) | 0],
          life: rnd(2.6, 4.2),
        });
      }
      s.confetti = parts;
    },

    _updateConfetti(dt) {
      const s = this.state, h = this.h || 600;
      const g = 1500;               // gravity (px/s²)
      const next = [];
      for (const p of s.confetti) {
        p.life -= dt;
        if (p.life <= 0) continue;
        p.vy += g * dt;
        p.vx *= (1 - 0.6 * dt);     // air drag, mostly on the sideways throw
        p.x += p.vx * dt;
        p.y += p.vy * dt;
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
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        // A little flutter: squash width by the rotation so flakes look thin edge-on.
        const sx = 0.55 + 0.45 * Math.abs(Math.cos(p.rot * 1.7));
        ctx.globalAlpha = Math.min(1, p.life);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2 * sx, -p.h / 2, p.w * sx, p.h);
        ctx.restore();
      }
      ctx.restore();
    },

    // ---- helpers -------------------------------------------------------------
    _ease(t) {                       // easeOutBack — a little overshoot on pop-in
      t = Math.max(0, Math.min(1, t));
      const c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
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

  window.TicTacToeGame = TicTacToeGame;
})();
