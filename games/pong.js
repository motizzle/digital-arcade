/* ============================================================================
   Fractal Pong
   ----------------------------------------------------------------------------
   A game module for the Fractal Shell. The ball(s) are fractal spheres (Julia
   or Mandelbrot, switchable). Paddles are the two team colors that the shell
   theme drives (Fire/Ice or Acid/Violet). The shell owns rendering of the
   spheres; this file owns mechanics + the 2D court/paddles/score/timer.

   Mechanics:
     - The match does NOT auto-start: the first ball is served only on click or
       Space. (Between-point serves auto-fire after a short pause.)
     - The game is TIMED to GAME_SECONDS. A countdown is drawn on the board.
     - Every EXPLODE_EVERY seconds the live balls burst into EXPLODE_BALLS
       different fractal balls flying off in random directions. A ball that
       gets past a paddle lands in THAT side's own goal and is removed; the
       score counts balls conceded, and FEWEST conceded wins. When all balls
       are gone, play returns to a single ball.
     - At 0:00 the game ends: both scores are shown large side by side and the
       winner is celebrated with confetti made of fractal balls (skipped under
       prefers-reduced-motion).

   Coordinates are CSS pixels. (0,0) is the top-left of the court.
   ========================================================================== */
(function () {
  'use strict';

  const GAME_SECONDS = 60;       // total match length
  const SERVE_DELAY = 0.9;       // seconds between a point and the next auto-serve
  const MAX_BOUNCE = 0.72;       // rad — steepest deflection off a paddle (~41°)

  const EXPLODE_EVERY = 5;       // seconds between bursts
  const EXPLODE_BALLS = 5;       // how many balls each burst produces
  const MAX_BALLS = 60;          // cap — past this, bursts stop splitting (framerate guard)
  const CONFETTI_COUNT = 36;     // fractal-ball confetti particles (< shell MAX_PIECES)

  // Paddle colors per shell theme. [player0 (left), player1 (right)].
  const PADDLE_COLORS = [
    ['#ff7a2c', '#2cb1ff'],      // theme 0 — Fire / Ice
    ['#7fff3a', '#b14aff'],      // theme 1 — Acid / Violet
  ];

  const PongGame = {
    id: 'pong',
    title: 'Radioactive Pong',
    subtitle: 'The ball is a living fractal — Mandelbrot or Julia',
    aspect: 1.6,
    hint: 'Fewest balls in your own goal wins   ·   Player 1: mouse / touch / W·S   ·   Player 2: ↑ ↓   ·   Space: serve / pause',

    modes: [
      { id: '1p', label: '1 Player' },
      { id: '2p', label: '2 Players' },
    ],

    // Editable player names; the shell renders a name field per player above
    // the board, tinted by the team color (which follows the theme). The
    // right paddle is the AI in 1P — it's 'Computer', never a fake human.
    players: [
      { defaultName: 'Player 1', color: (shell) => PADDLE_COLORS[shell.theme][0] },
      { defaultName: (shell) => (shell.mode === '1p' ? 'Computer' : 'Player 2'),
        color: (shell) => PADDLE_COLORS[shell.theme][1] },
    ],

    controls: [
      {
        // Toggle the fractal that the ball renders.
        label: () => 'Ball: ' + (PongGame.ballLook === 'bands' ? 'Mandelbrot' : 'Julia'),
        title: 'Switch the ball between a Julia set and the Mandelbrot set',
        onClick: () => { PongGame.ballLook = (PongGame.ballLook === 'bands') ? 'stalks' : 'bands'; },
      },
      {
        label: () => (PongGame.state && PongGame.state.paused ? 'Resume' : 'Pause'),
        onClick: () => { if (PongGame.state && !PongGame.state.over) PongGame.state.paused = !PongGame.state.paused; },
      },
    ],

    // 'stalks' = Julia, 'bands' = Mandelbrot (keys defined in the shell PRESETS).
    ballLook: 'stalks',
    ballSeed: 5.0,

    state: null,

    // ---- lifecycle -----------------------------------------------------------
    reset(shell) {
      const w = shell.size.w, h = shell.size.h;
      this.state = {
        scores: [0, 0],
        over: false, winner: null,
        paused: false,
        started: false,                                   // no auto-start: wait for input
        waiting: true, serveTimer: SERVE_DELAY, serveDir: Math.random() < 0.5 ? -1 : 1,
        balls: [this._makeBall(w / 2, h / 2, 0, 0, this._ballR(w, h),
          { seed: this.ballSeed, look: this.ballLook, tint: 0 })],
        left: { y: h / 2 }, right: { y: h / 2 },
        keys: {},
        speed: this._baseSpeed(w),
        timeLeft: GAME_SECONDS,
        explodeTimer: EXPLODE_EVERY,
        confetti: [],
      };
      this._geom(shell, w, h);
    },

    resize(shell, w, h) {
      const ow = this._courtW, oh = this._courtH;    // court size the state was built for
      this._geom(shell, w, h);
      if (!this.state) return;
      const s = this.state, r = this._ballR(w, h);
      // Rescale positions AND velocities into the new court. Speeds are px/s
      // relative to court width, so without this a rally carried into
      // fullscreen feels slow (old-court velocity on a bigger court), and
      // shrinking the court can strand a ball outside it — a phantom goal.
      if (ow && oh && (ow !== w || oh !== h)) {
        const fx = w / ow, fy = h / oh;
        for (const b of s.balls) { b.x *= fx; b.y *= fy; b.vx *= fx; b.vy *= fy; }
        for (const p of s.confetti) { p.x *= fx; p.y *= fy; p.vx *= fx; p.vy *= fy; p.r *= Math.min(fx, fy); }
        s.left.y *= fy; s.right.y *= fy;
        s.speed = this._baseSpeed(w);
      }
      for (const b of s.balls) b.r = r;
      s.left.y = this._clampPaddle(shell, s.left.y);
      s.right.y = this._clampPaddle(shell, s.right.y);
      if (s.waiting && s.balls.length === 1) { s.balls[0].x = w / 2; s.balls[0].y = h / 2; }
    },

    _makeBall(x, y, vx, vy, r, opts) {
      opts = opts || {};
      return {
        x, y, vx, vy, r,
        seed: (opts.seed != null) ? opts.seed : this.ballSeed,
        look: opts.look || this.ballLook,
        tint: opts.tint || 0,            // 0 -> Fire/Acid, 1 -> Ice/Violet
        capture: opts.capture || 0,      // >0 = white strike-flash pulse
      };
    },

    _geom(shell, w, h) {
      this._courtW = w; this._courtH = h;
      this.pw = Math.max(10, w * 0.014);
      this.ph = h * 0.18;
      this.leftX = w * 0.035;
      this.rightX = w - w * 0.035 - this.pw;
    },
    _ballR(w, h) { return Math.min(w, h) * 0.05; },
    _baseSpeed(w) { return w * 0.62; },
    _clampPaddle(shell, y) {
      const half = this.ph / 2;
      return Math.max(half, Math.min(shell.size.h - half, y));
    },

    // ---- update --------------------------------------------------------------
    update(shell, dt) {
      const s = this.state;
      if (!s) return;
      if (s.over) { this._updateConfetti(shell, dt); return; }
      if (s.paused) return;

      const w = shell.size.w, h = shell.size.h;
      const paddleSpeed = h * 0.95;

      // Left paddle — keyboard (pointer is handled in onPointerMove).
      if (s.keys['w'] || s.keys['W']) s.left.y -= paddleSpeed * dt;
      if (s.keys['s'] || s.keys['S']) s.left.y += paddleSpeed * dt;

      // Right paddle — AI in 1P, arrow keys in 2P.
      if (shell.mode === '2p') {
        if (s.keys['ArrowUp']) s.right.y -= paddleSpeed * dt;
        if (s.keys['ArrowDown']) s.right.y += paddleSpeed * dt;
      } else {
        let target = h / 2, bestX = -Infinity;
        for (const b of s.balls) { if (b.vx > 0 && b.x > bestX) { bestX = b.x; target = b.y; } }
        const aiSpeed = h * 0.74;
        const dy = target - s.right.y;
        s.right.y += Math.max(-aiSpeed * dt, Math.min(aiSpeed * dt, dy));
      }
      s.left.y = this._clampPaddle(shell, s.left.y);
      s.right.y = this._clampPaddle(shell, s.right.y);

      // Strike-flash decay, per ball.
      for (const b of s.balls) { if (b.capture > 0) { b.capture += dt; if (b.capture > 0.28) b.capture = 0; } }

      // Match clock + burst cadence run once the match has started.
      if (s.started) {
        s.timeLeft -= dt;
        if (s.timeLeft <= 0) { s.timeLeft = 0; this._endGame(shell); return; }
        s.explodeTimer -= dt;
      }

      // Serve wait. Before the match has STARTED, do not count down — the first
      // ball is served only by player input (no auto-start).
      if (s.waiting) {
        const b = s.balls[0];
        if (b) { b.x = w / 2; b.y = h / 2; }
        if (s.started) { s.serveTimer -= dt; if (s.serveTimer <= 0) this._launch(shell); }
        return;
      }

      // Recurring burst (only while balls are actually in play).
      if (s.explodeTimer <= 0) { this._explode(shell); s.explodeTimer = EXPLODE_EVERY; }

      // Integrate + collide + score, per ball.
      const half = this.ph / 2;
      const survivors = [];
      for (const b of s.balls) {
        b.x += b.vx * dt;
        b.y += b.vy * dt;

        if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy); }
        if (b.y > h - b.r) { b.y = h - b.r; b.vy = -Math.abs(b.vy); }

        if (b.vx < 0 && b.x - b.r <= this.leftX + this.pw && b.x - b.r > this.leftX - this.pw) {
          if (b.y >= s.left.y - half - b.r && b.y <= s.left.y + half + b.r) {
            b.x = this.leftX + this.pw + b.r;
            this._bounce(shell, b, s.left.y, 0);
          }
        }
        if (b.vx > 0 && b.x + b.r >= this.rightX && b.x + b.r < this.rightX + this.pw + b.r) {
          if (b.y >= s.right.y - half - b.r && b.y <= s.right.y + half + b.r) {
            b.x = this.rightX - b.r;
            this._bounce(shell, b, s.right.y, 1);
          }
        }

        // A ball that gets past a paddle lands in THAT side's own goal — bad
        // for them. The score is balls-conceded; fewest wins.
        if (b.x < -b.r) this._point(shell, 0);        // into LEFT's goal
        else if (b.x > w + b.r) this._point(shell, 1); // into RIGHT's goal
        else survivors.push(b);
      }
      s.balls = survivors;

      // All balls have left the court — return to single-ball play (auto-serve).
      if (s.balls.length === 0) {
        s.balls = [this._makeBall(w / 2, h / 2, 0, 0, this._ballR(w, h),
          { seed: this.ballSeed, look: this.ballLook, tint: 0 })];
        s.waiting = true;
        s.serveTimer = SERVE_DELAY;
      }
    },

    _launch(shell) {
      const s = this.state, w = shell.size.w;
      s.waiting = false;
      s.started = true;
      s.speed = this._baseSpeed(w);
      const ang = (Math.random() * 2 - 1) * 0.35;     // ±20° opening serve
      for (const b of s.balls) {
        b.vx = s.serveDir * s.speed * Math.cos(ang);
        b.vy = s.speed * Math.sin(ang);
      }
    },

    _bounce(shell, b, paddleCenter, player) {
      const half = this.ph / 2;
      const offset = Math.max(-1, Math.min(1, (b.y - paddleCenter) / half));
      const cur = Math.hypot(b.vx, b.vy) || this._baseSpeed(shell.size.w);
      const sp = Math.min(cur * 1.05, shell.size.w * 1.5);   // speed up a touch each hit
      const dir = (player === 0) ? 1 : -1;
      const ang = offset * MAX_BOUNCE;
      b.vx = dir * sp * Math.cos(ang);
      b.vy = sp * Math.sin(ang);
      b.tint = player;          // ball glows the color of who last hit it
      b.capture = 0.001;        // trigger the strike flash
    },

    _point(shell, goalOwner) {
      const s = this.state;
      s.scores[goalOwner]++;                       // balls conceded by this side
      s.serveDir = (goalOwner === 0) ? 1 : -1;     // next serve heads away from that goal
    },

    // Recurring burst: every live ball SPLITS into EXPLODE_BALLS different
    // fractal balls radiating from its current position. No ball ever
    // disappears, so the count multiplies each burst (3 balls -> 15 -> 75 …)
    // until it reaches MAX_BALLS, after which bursts are skipped entirely.
    _explode(shell) {
      const s = this.state, w = shell.size.w, h = shell.size.h;
      // Framerate guard: once the court is crowded, leave the live balls alone
      // instead of multiplying them again (3 -> 15 -> 75 would tank the FPS).
      if (s.balls.length >= MAX_BALLS) return;
      const sources = s.balls.length ? s.balls : [{ x: w / 2, y: h / 2, vx: 0, vy: 0 }];
      const r = this._ballR(w, h);
      const looks = ['stalks', 'bands'];
      const balls = [];
      for (const src of sources) {
        const start = Math.random() * Math.PI * 2;
        const base = Math.max(this._baseSpeed(w), Math.hypot(src.vx, src.vy)) * 1.05;
        for (let i = 0; i < EXPLODE_BALLS; i++) {
          const ang = start + i * (Math.PI * 2 / EXPLODE_BALLS) + (Math.random() - 0.5) * 0.6;
          balls.push(this._makeBall(src.x, src.y, Math.cos(ang) * base, Math.sin(ang) * base, r, {
            seed: Math.random() * 100,
            look: looks[(Math.random() * looks.length) | 0],
            tint: (Math.random() < 0.5) ? 0 : 1,
            capture: 0.001,
          }));
        }
      }
      s.balls = balls;
    },

    _endGame(shell) {
      const s = this.state;
      s.over = true;
      // Fewest balls conceded wins.
      s.winner = (s.scores[0] === s.scores[1]) ? null : (s.scores[0] < s.scores[1] ? 0 : 1);
      s.balls = [];
      this._spawnConfetti(shell);
      // 1P high score: balls you let into your own goal — fewest is best (asc).
      if (shell.mode === '1p' && shell.recordScore) {
        shell.recordScore(s.scores[0], { order: 'asc', label: 'CONCEDED' });
      }
    },

    // ---- confetti (fractal balls) -------------------------------------------
    _spawnConfetti(shell) {
      const s = this.state, w = shell.size.w, h = shell.size.h;
      s.confetti = [];
      // Honor reduced-motion: skip the decorative particle effect entirely.
      if (shell.reducedMotion) return;
      for (let i = 0; i < CONFETTI_COUNT; i++) s.confetti.push(this._confetti(shell, w, h, true));
    },
    _confetti(shell, w, h, initial) {
      const s = this.state, r0 = this._ballR(w, h);
      const looks = ['stalks', 'bands'];
      return {
        x: Math.random() * w,
        y: initial ? -Math.random() * h : -r0 * 2,       // start scattered above the top
        vx: (Math.random() - 0.5) * w * 0.18,
        vy: (0.18 + Math.random() * 0.5) * h,            // px/s downward
        r: r0 * (0.26 + Math.random() * 0.36),
        seed: Math.random() * 100,
        look: looks[(Math.random() * looks.length) | 0],
        // Mostly the winner's color; some of the other for variety. Draw -> mixed.
        tint: (s.winner === null) ? ((Math.random() < 0.5) ? 0 : 1)
          : (Math.random() < 0.78 ? s.winner : 1 - s.winner),
      };
    },
    _updateConfetti(shell, dt) {
      const s = this.state, w = shell.size.w, h = shell.size.h;
      if (!s.confetti || !s.confetti.length) return;
      const grav = h * 0.6;
      for (const p of s.confetti) {
        p.vy += grav * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.x < -p.r) p.x = w + p.r;
        if (p.x > w + p.r) p.x = -p.r;
        if (p.y > h + p.r) {                              // recycle for continuous rain
          const np = this._confetti(shell, w, h, false);
          p.x = np.x; p.y = np.y; p.vx = np.vx; p.vy = np.vy;
          p.r = np.r; p.seed = np.seed; p.look = np.look; p.tint = np.tint;
        }
      }
    },

    // ---- input ---------------------------------------------------------------
    onPointerMove(shell, x, y) {
      if (!this.state) return;
      this.state.left.y = this._clampPaddle(shell, y);
    },
    onPointerDown(shell) {
      const s = this.state; if (!s) return;
      if (s.over) { this.reset(shell); return; }
      if (s.waiting) this._launch(shell);     // serve now (also starts the match)
    },
    onKeyDown(shell, e) {
      const s = this.state; if (!s) return;
      s.keys[e.key] = true;
      if (e.key === ' ') {
        e.preventDefault();
        if (s.over) { this.reset(shell); }
        else if (s.waiting) { this._launch(shell); }
        else { s.paused = !s.paused; shell.refreshControls(); }
      }
      if (['ArrowUp', 'ArrowDown', 'w', 's', 'W', 'S'].includes(e.key)) e.preventDefault();
    },
    onKeyUp(shell, e) { if (this.state) this.state.keys[e.key] = false; },

    // ---- fractal spheres (balls in play, or confetti on the end screen) ------
    spheres(shell) {
      const s = this.state; if (!s) return [];
      const src = s.over ? (s.confetti || []) : s.balls;
      const out = [];
      for (const b of src) {
        out.push({
          x: b.x, y: b.y, r: b.r,
          tint: b.tint, look: b.look, seed: b.seed,
          zoom: 1.25, capture: b.capture || 0, frozen: false,
        });
      }
      return out;
    },

    // ---- 2D layers -----------------------------------------------------------
    drawBackground(shell, ctx, w, h) {
      ctx.fillStyle = '#04040a';
      ctx.fillRect(0, 0, w, h);
      const amb = ctx.createRadialGradient(w / 2, h * 0.05, 0, w / 2, h * 0.05, Math.max(w, h) * 0.9);
      amb.addColorStop(0, 'rgba(48, 28, 78, 0.32)');
      amb.addColorStop(0.45, 'rgba(20, 12, 36, 0.12)');
      amb.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = amb;
      ctx.fillRect(0, 0, w, h);

      // Center net — dashed.
      ctx.save();
      ctx.strokeStyle = 'rgba(232, 232, 240, 0.16)';
      ctx.lineWidth = Math.max(2, w * 0.004);
      ctx.setLineDash([h * 0.03, h * 0.025]);
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.stroke();
      ctx.restore();
    },

    drawForeground(shell, ctx, w, h) {
      const s = this.state; if (!s) return;
      const colors = PADDLE_COLORS[shell.theme] || PADDLE_COLORS[0];

      // Countdown timer — always visible, top center. shadowBlur repaints
      // every frame and is the priciest Canvas2D op under software
      // rasterization — shed it once lowPerf latches.
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.font = '300 ' + Math.round(h * 0.055) + 'px -apple-system, system-ui, sans-serif';
      if (!shell.lowPerf) { ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = h * 0.012; }
      ctx.fillStyle = (s.started && !s.over && s.timeLeft <= 10) ? '#ff6a6a' : 'rgba(232,232,240,0.9)';
      ctx.fillText(this._fmtTime(s.timeLeft), w / 2, h * 0.03);
      ctx.restore();

      if (!s.over) {
        // Live scores, left / right.
        ctx.save();
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.font = '300 ' + Math.round(h * 0.14) + 'px -apple-system, system-ui, sans-serif';
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = colors[0]; ctx.fillText(s.scores[0], w * 0.28, h * 0.07);
        ctx.fillStyle = colors[1]; ctx.fillText(s.scores[1], w * 0.72, h * 0.07);
        ctx.restore();

        // Paddles.
        this._paddle(shell, ctx, this.leftX, s.left.y, colors[0]);
        this._paddle(shell, ctx, this.rightX, s.right.y, colors[1]);
      }

      // Overlays.
      if (s.over) {
        this._endCard(shell, ctx, w, h, colors);
      } else if (s.paused) {
        this._banner(ctx, w, h, '#e8e8f0', 'Paused', 'Space to resume');
      } else if (!s.started) {
        this._banner(ctx, w, h, '#e8e8f0', 'Radioactive Pong', 'Space or tap to serve');
      }
    },

    _fmtTime(t) {
      const sec = Math.max(0, Math.ceil(t));
      const m = Math.floor(sec / 60), r = sec % 60;
      return m + ':' + String(r).padStart(2, '0');
    },

    // Final scoreboard + winner celebration. Confetti (fractal balls) is drawn
    // by the shell on the GL layer behind this card.
    _endCard(shell, ctx, w, h, colors) {
      const s = this.state;
      const nameL = shell.playerName(0), nameR = shell.playerName(1);

      // A centered celebration card (a panel, not a full-width band).
      const pw = w * 0.72, ph = h * 0.68, px = (w - pw) / 2, py = (h - ph) / 2;
      ctx.save();
      ctx.fillStyle = 'rgba(8, 8, 16, 0.62)';
      this._roundRect(ctx, px, py, pw, ph, Math.min(pw, ph) * 0.06);
      ctx.fill();
      ctx.strokeStyle = 'rgba(190, 200, 230, 0.28)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = h * 0.02;

      // Title — the winner's name.
      const title = (s.winner === null) ? "It's a draw" : (shell.playerName(s.winner) + ' wins!');
      const titleColor = (s.winner === null) ? '#e8e8f0' : colors[s.winner];
      ctx.fillStyle = titleColor;
      ctx.font = '300 ' + Math.round(h * 0.095) + 'px -apple-system, system-ui, sans-serif';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(title, w / 2, h * 0.33);

      // Player names above their scores.
      ctx.font = '300 ' + Math.round(h * 0.042) + 'px -apple-system, system-ui, sans-serif';
      ctx.globalAlpha = (s.winner === 1) ? 0.45 : 1;
      ctx.fillStyle = colors[0]; ctx.fillText(nameL, w * 0.37, h * 0.45);
      ctx.globalAlpha = (s.winner === 0) ? 0.45 : 1;
      ctx.fillStyle = colors[1]; ctx.fillText(nameR, w * 0.63, h * 0.45);

      // Two scores, large, side by side. Loser dimmed.
      ctx.font = '300 ' + Math.round(h * 0.22) + 'px -apple-system, system-ui, sans-serif';
      ctx.globalAlpha = (s.winner === 1) ? 0.45 : 1;
      ctx.fillStyle = colors[0]; ctx.fillText(String(s.scores[0]), w * 0.37, h * 0.66);
      ctx.globalAlpha = (s.winner === 0) ? 0.45 : 1;
      ctx.fillStyle = colors[1]; ctx.fillText(String(s.scores[1]), w * 0.63, h * 0.66);

      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(232,232,240,0.5)';
      ctx.font = '300 ' + Math.round(h * 0.13) + 'px -apple-system, system-ui, sans-serif';
      ctx.fillText('–', w / 2, h * 0.645);

      // Subtitle.
      ctx.fillStyle = 'rgba(232,232,240,0.7)';
      ctx.font = '300 ' + Math.round(h * 0.034) + 'px -apple-system, system-ui, sans-serif';
      ctx.fillText('Space or tap for a rematch', w / 2, h * 0.77);
      ctx.restore();
    },

    _paddle(shell, ctx, x, cy, color) {
      const ph = this.ph, pw = this.pw, y = cy - ph / 2, r = pw / 2;
      ctx.save();
      // Glow + gradient are decoration; a flat fill reads the same at speed.
      if (!shell.lowPerf) {
        ctx.shadowColor = color;
        ctx.shadowBlur = pw * 1.6;
        const g = ctx.createLinearGradient(x, 0, x + pw, 0);
        g.addColorStop(0, color);
        g.addColorStop(1, this._darken(color, 0.55));
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = color;
      }
      this._roundRect(ctx, x, y, pw, ph, r);
      ctx.fill();
      ctx.restore();
    },

    _banner(ctx, w, h, color, title, subtitle) {
      // No background band — a soft text shadow keeps the words legible over
      // the board without masking the center of the court.
      ctx.save();
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
      ctx.shadowBlur = Math.round(h * 0.03);
      ctx.fillStyle = color;
      ctx.font = '300 ' + Math.round(h * 0.09) + 'px -apple-system, system-ui, sans-serif';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(title, w / 2, h * 0.5);
      ctx.fillStyle = 'rgba(232,232,240,0.7)';
      ctx.font = '300 ' + Math.round(h * 0.035) + 'px -apple-system, system-ui, sans-serif';
      ctx.fillText(subtitle, w / 2, h * 0.57);
      ctx.restore();
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
    _darken(hex, f) {
      const n = parseInt(hex.slice(1), 16);
      const r = Math.round(((n >> 16) & 255) * f);
      const g = Math.round(((n >> 8) & 255) * f);
      const b = Math.round((n & 255) * f);
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    },
  };

  window.PongGame = PongGame;
})();
