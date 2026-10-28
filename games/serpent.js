/* ============================================================================
   Serpent Bloom
   ----------------------------------------------------------------------------
   A self-growing fractal serpent for the Fractal Shell. The snake grows on a
   timer — no food. Steer with arrow keys / WASD. Survive as long as
   you can without tying yourself in knots, and leave a constellation trail.

   Modes (walls always kill you):
     - Bloom  — standard growth rate
     - Knot   — grows faster; you'll knot yourself sooner
     - Mirror — left/right controls flip on the right half of the board

   Visuals: the head is the Sun; each body segment is a planet from Mercury
   outward, cycling Julia/Mandelbrot fractals per lap. Planet-colored auras,
   rings, and band hints on the 2D layer; constellation trail on the board.
   ========================================================================== */
(function () {
  'use strict';

  const BASE_GROWTH = 1.55;
  const LINGER_SEC = 2.4;
  const TRAIL_LIFE = 9.0;
  const TRAIL_MIN_DIST = 10;
  const TRAIL_MAX = 320;
  const EMBER_LIFE = 0.85;
  const BIRTH_GLOW_LIFE = 0.55;
  const CRASH_FLASH_LIFE = 0.7;
  const TURN_HALO_LIFE = 0.35;
  const SHARP_TURN = 2.8;
  const MAX_SPHERES = 48;          // stay under shell MAX_PIECES (64)
  const FRACTAL_LOOKS = ['stalks', 'bands']; // Julia, then Mandelbrot, alternating
  const ORB_SPAWN_EVERY = 11;      // seconds between orb clusters
  const ORB_PICKUP_SEC = 5;        // window to grab the power-up before it sours
  const ORB_LIFE = 8.5;            // how long a cluster lingers before clearing
  const OBSTACLE_COUNT = 2;        // hazards spawned alongside each power-up
  const INVINCIBLE_SEC = 5;
  const ORB_HUES = [0, 55, 120, 190, 260, 310];

  // Player-selectable serpent speed. Medium is the original feel; the chosen
  // scale multiplies the length-based base speed.
  const SPEED_SETTINGS = [
    { id: 'slow', label: 'Slow', scale: 0.72 },
    { id: 'med', label: 'Medium', scale: 1.0 },
    { id: 'fast', label: 'Fast', scale: 1.45 },
  ];

  // Planets in solar order (closest to the Sun first). relR is relative to headR.
  const SUN = {
    name: 'Sun', color: '#ffaa33', core: '#fff4c8', relR: 1.14, seed: 0.42, zoom: 1.48, tint: 0, look: 'nova',
  };
  const PLANETS = [
    { name: 'Mercury', color: '#9a958c', core: '#c4bdb0', relR: 0.36, seed: 2.17, zoom: 1.22, tint: 0 },
    { name: 'Venus',   color: '#e5c07a', core: '#fff0c8', relR: 0.50, seed: 3.61, zoom: 1.18, tint: 0 },
    { name: 'Earth',   color: '#1e6bb5', core: '#3d9ad4', relR: 0.52, seed: 4.93, zoom: 1.25, tint: 1, earth: true },
    { name: 'Mars',    color: '#c1440e', core: '#e86f3a', relR: 0.42, seed: 5.84, zoom: 1.20, tint: 0 },
    { name: 'Jupiter', color: '#c88a4a', core: '#e8c090', relR: 0.96, seed: 7.31, zoom: 1.15, tint: 0, bands: true },
    { name: 'Saturn',  color: '#e8d8a8', core: '#fff5d4', relR: 0.82, seed: 8.47, zoom: 1.12, tint: 0, rings: true },
    { name: 'Uranus',  color: '#5ad4e8', core: '#9eeaf5', relR: 0.70, seed: 9.52, zoom: 1.28, tint: 1 },
    { name: 'Neptune', color: '#2a4fd4', core: '#5a82e8', relR: 0.68, seed: 10.66, zoom: 1.30, tint: 1 },
  ];

  const TEAM_COLORS = [
    ['#ff7a2c', '#2cb1ff'],
    ['#7fff3a', '#b14aff'],
  ];

  const SerpentGame = {
    id: 'serpent',
    title: 'Serpent Bloom',
    subtitle: 'A living solar system — the Sun leads Mercury through Neptune',
    aspect: 1.0,
    stageMax: 1600,
    hint: 'Grab the bright orb for a shield · dodge the 2 red obstacles   ·   Drag or keys to steer   ·   Space: pause',

    modes: [
      { id: 'bloom', label: 'Bloom', title: 'Standard growth — hit a wall or knot yourself and you\'re out' },
      { id: 'knot', label: 'Knot', title: 'Faster growth — the serpent knots itself sooner; dodge your own tail' },
      { id: 'mirror', label: 'Mirror', title: 'On the right half of the board, ← → steering flips' },
    ],

    nameStyle: 'underline',

    players: [
      { defaultName: 'Gardener', color: (shell) => TEAM_COLORS[shell.theme][0] },
    ],

    // Speed preset (index into SPEED_SETTINGS); starts on Medium.
    speedIdx: 1,

    controls: [
      {
        label: () => 'Speed: ' + SPEED_SETTINGS[SerpentGame.speedIdx].label,
        title: 'Cycle serpent speed — Slow / Medium / Fast',
        onClick: (shell) => {
          SerpentGame.speedIdx = (SerpentGame.speedIdx + 1) % SPEED_SETTINGS.length;
          if (shell.refreshControls) shell.refreshControls();
        },
      },
      {
        label: (shell) => (SerpentGame.state && SerpentGame.state.paused ? 'Resume' : 'Pause'),
        title: 'Pause or resume the run',
        onClick: (shell) => {
          const s = SerpentGame.state;
          if (s && !s.over && s.started) { s.paused = !s.paused; shell.refreshControls(); }
        },
        active: (shell) => {
          const s = SerpentGame.state;
          return !!(s && s.started && !s.over && s.paused);
        },
      },
    ],

    state: null,

    // ---- lifecycle -----------------------------------------------------------
    reset(shell) {
      const w = shell.size.w, h = shell.size.h;
      const cx = w / 2, cy = h / 2;
      const headR = this._headR(w, h);
      const spacing = headR * 1.65;
      const path = [{ x: cx, y: cy, d: 0 }];
      this.state = {
        over: false,
        paused: false,
        started: false,
        linger: 0,
        head: { x: cx, y: cy, angle: 0 },
        speedMult: 1,
        turnRate: 3.4,
        spacing,
        headR,
        segments: 1,
        path,
        growthTimer: this._growthInterval(1, shell.mode),
        time: 0,
        best: this.state ? this.state.best : 0,
        keys: {},
        pointer: { down: false, x: cx, y: cy },
        trail: [],
        births: [],
        embers: [],
        crash: null,
        turnHalo: 0,
        gridPhase: 0,
        bodyPts: [],
        orbs: [],
        nextOrbAt: ORB_SPAWN_EVERY,
        invincible: 0,
      };
      this._geom(w, h);
      this._rebuildBodyPts(this.state);
    },

    resize(shell, w, h) {
      const ow = this._courtW, oh = this._courtH;
      this._geom(w, h);
      if (!this.state) return;
      const s = this.state;
      if (ow && oh && (ow !== w || oh !== h)) {
        const fx = w / ow, fy = h / oh;
        const scaleXY = (p) => { p.x *= fx; p.y *= fy; };
        scaleXY(s.head);
        scaleXY(s.pointer);
        for (const pt of s.path) scaleXY(pt);
        this._rebuildPathD(s);
        for (const t of s.trail) scaleXY(t);
        for (const b of s.births) scaleXY(b);
        for (const o of s.orbs) scaleXY(o);
        for (const e of s.embers) { scaleXY(e); e.vx *= fx; e.vy *= fy; }
        if (s.crash) scaleXY(s.crash);
      }
      s.headR = this._headR(w, h);
      s.spacing = s.headR * 1.65;
      if (s.path.length) this._rebuildBodyPts(s);
    },

    _rebuildPathD(s) {
      let d = 0;
      for (let i = 0; i < s.path.length; i++) {
        if (i > 0) {
          const prev = s.path[i - 1];
          d += Math.hypot(s.path[i].x - prev.x, s.path[i].y - prev.y);
        }
        s.path[i].d = d;
      }
    },

    _geom(w, h) {
      this._courtW = w;
      this._courtH = h;
      this.margin = Math.min(w, h) * 0.04;
      this.gridCols = 12;
      this.gridRows = 12;
      this.cellW = w / this.gridCols;
      this.cellH = h / this.gridRows;
    },

    _headR(w, h) { return Math.min(w, h) * 0.042; },

    _baseSpeedFromSegments(segments, minSide) {
      // Taper the per-segment acceleration past 45 so a long serpent stays
      // controllable. The old linear curve kept speeding up without limit and
      // made the run effectively un-survivable around length ~60 — that was the
      // "we end at 60" ceiling (not a hard cap). Now it plateaus gently.
      const seg = Math.min(segments, 45) + Math.max(0, segments - 45) * 0.22;
      return minSide * (0.09 + 0.0075 * seg);
    },

    _growthInterval(segments, mode) {
      let iv = BASE_GROWTH;
      if (mode === 'knot') iv *= 0.72;
      if (segments >= 20) iv *= 0.88;
      if (segments >= 35) iv *= 0.82;
      if (segments >= 50) iv *= 0.76;
      return iv;
    },

    // ---- update --------------------------------------------------------------
    update(shell, dt) {
      const s = this.state;
      if (!s) return;

      s.gridPhase += dt;

      if (s.over) {
        s.linger -= dt;
        this._decayFx(s, dt);
        return;
      }
      if (s.paused || !s.started) return;

      s.time += dt;
      const w = shell.size.w, h = shell.size.h;
      const prevAngle = s.head.angle;
      const minSide = Math.min(w, h);

      if (s.pointer.down) {
        this._applyDragSteer(shell, s, w, h, minSide, dt);
      } else {
        let turn = 0;
        if (this._inputActive(s, 'turnL')) turn -= 1;
        if (this._inputActive(s, 'turnR')) turn += 1;
        if (shell.mode === 'mirror' && s.head.x > w / 2) turn *= -1;
        if (turn !== 0) s.head.angle += turn * s.turnRate * dt;

        if (this._inputActive(s, 'faster')) {
          s.speedMult = Math.min(s.speedMult + 1.4 * dt, 1.45);
        }
        if (this._inputActive(s, 'slower')) {
          s.speedMult = Math.max(s.speedMult - 1.4 * dt, 0.65);
        }
      }

      const dAngle = Math.abs(s.head.angle - prevAngle) / Math.max(dt, 1e-4);
      if (dAngle > SHARP_TURN) s.turnHalo = TURN_HALO_LIFE;

      const speedScale = SPEED_SETTINGS[this.speedIdx].scale;
      const speed = this._baseSpeedFromSegments(s.segments, minSide) * s.speedMult * speedScale;
      s.head.x += Math.cos(s.head.angle) * speed * dt;
      s.head.y += Math.sin(s.head.angle) * speed * dt;

      if (s.invincible > 0) s.invincible -= dt;

      this._updateOrbs(shell, s, w, h, dt);

      const m = s.headR;
      if (s.invincible <= 0 && (s.head.x < m || s.head.x > w - m || s.head.y < m || s.head.y > h - m)) {
        this._crash(shell, s.head.x, s.head.y);
        return;
      }

      this._pushPath(s, s.head.x, s.head.y);

      // Timed growth.
      let grew = false;
      s.growthTimer -= dt;
      if (s.growthTimer <= 0) {
        s.segments++;
        s.growthTimer = this._growthInterval(s.segments, shell.mode);
        grew = true;
      }

      this._rebuildBodyPts(s);

      if (grew) {
        const newborn = s.bodyPts[s.bodyPts.length - 1];
        if (newborn) {
          s.births.push({ x: newborn.x, y: newborn.y, t: 0 });
          this._spawnEmbers(s, newborn.x, newborn.y, 7, 0.55);
        }
      }

      // Trail drops from tail (throttled so it doesn't grow every frame).
      const tail = s.bodyPts[s.bodyPts.length - 1];
      if (tail && s.time > 0.1) {
        const last = s.trail[s.trail.length - 1];
        if (!last || Math.hypot(tail.x - last.x, tail.y - last.y) >= TRAIL_MIN_DIST) {
          s.trail.push({ x: tail.x, y: tail.y, age: 0 });
          if (s.trail.length > TRAIL_MAX) s.trail.shift();
        }
      }
      for (const t of s.trail) t.age += dt;
      s.trail = s.trail.filter((t) => t.age < TRAIL_LIFE);

      if (this._checkSelfCollision(shell, s)) return;

      if (s.segments > s.best) s.best = s.segments;
      this._decayFx(s, dt);
    },

    _headSphereR(s) {
      return this._sphereR(s, SUN);
    },

    _checkSelfCollision(shell, s) {
      if (s.invincible > 0) return false;
      const pts = s.bodyPts;
      if (!pts || pts.length < 5) return false;

      const headR = this._headSphereR(s);
      const skip = Math.max(3, Math.ceil((headR * 2.1) / s.spacing));

      for (let i = skip; i < pts.length; i++) {
        const p = pts[i];
        const segR = this._sphereR(s, this._planetSpec(i));
        const hitR = (headR + segR) * 0.82;
        const dx = s.head.x - p.x, dy = s.head.y - p.y;
        if (dx * dx + dy * dy < hitR * hitR) {
          this._crash(shell, s.head.x, s.head.y);
          return true;
        }
      }

      // Head can slip between segment centers — also test each body link.
      for (let i = skip; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const specA = this._planetSpec(i);
        const specB = this._planetSpec(i + 1);
        const linkR = (this._sphereR(s, specA) + this._sphereR(s, specB)) * 0.42 + headR * 0.55;
        const abx = b.x - a.x, aby = b.y - a.y;
        const len2 = abx * abx + aby * aby;
        let t = 0.5;
        if (len2 > 1e-4) {
          t = Math.max(0, Math.min(1, ((s.head.x - a.x) * abx + (s.head.y - a.y) * aby) / len2));
        }
        const cx = a.x + abx * t, cy = a.y + aby * t;
        const dx = s.head.x - cx, dy = s.head.y - cy;
        if (dx * dx + dy * dy < linkR * linkR) {
          this._crash(shell, s.head.x, s.head.y);
          return true;
        }
      }

      return false;
    },

    _invincibleFlash(s, index) {
      const pulse = 0.5 + 0.5 * Math.sin(s.time * 11 + index * 0.85);
      const hue = (s.time * 110 + index * 47) % 360;
      return {
        color: this._hsla(hue, 88, 58, 0.92),
        core: this._hsla((hue + 55) % 360, 75, 78, 0.95 * pulse),
        pulse,
        hue,
      };
    },

    _crash(shell, x, y) {
      const s = this.state;
      s.over = true;
      s.linger = LINGER_SEC;
      s.crash = { x, y, t: 0 };
      this._spawnEmbers(s, x, y, 14, 1.0);
      if (s.segments > s.best) s.best = s.segments;
      // Length is the score — bigger is better. Prompt for initials if it's a
      // top-ten run (shell no-ops if it doesn't qualify or HighScores is absent).
      if (shell.recordScore) shell.recordScore(s.segments, { order: 'desc', label: 'LENGTH' });
    },

    _spawnEmbers(s, x, y, count, scale) {
      if (count <= 0) return;
      for (let i = 0; i < count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const spd = (40 + Math.random() * 120) * scale;
        s.embers.push({
          x, y,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd,
          life: EMBER_LIFE * (0.6 + Math.random() * 0.5),
          age: 0,
          r: (2 + Math.random() * 4) * scale,
        });
      }
    },

    _decayFx(s, dt) {
      for (const b of s.births) b.t += dt;
      s.births = s.births.filter((b) => b.t < BIRTH_GLOW_LIFE);
      if (s.crash) s.crash.t += dt;
      if (s.turnHalo > 0) s.turnHalo -= dt;
      for (const e of s.embers) {
        e.age += dt;
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        e.vx *= 0.96;
        e.vy *= 0.96;
      }
      s.embers = s.embers.filter((e) => e.age < e.life);
    },

    _pushPath(s, x, y) {
      const prev = s.path[s.path.length - 1];
      const d = prev ? prev.d + Math.hypot(x - prev.x, y - prev.y) : 0;
      s.path.push({ x, y, d });
      const maxArc = (s.segments + 10) * s.spacing;
      while (s.path.length > 2 && s.path[s.path.length - 1].d - s.path[0].d > maxArc) {
        s.path.shift();
      }
    },

    _pointAlongPath(s, distBehind) {
      const path = s.path;
      if (!path.length) return null;
      const end = path[path.length - 1];
      const target = end.d - distBehind;
      if (target <= path[0].d) return { x: path[0].x, y: path[0].y };
      let lo = 0, hi = path.length - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (path[mid].d <= target) lo = mid;
        else hi = mid;
      }
      const a = path[lo], b = path[hi];
      const seg = b.d - a.d;
      const t = seg > 1e-6 ? (target - a.d) / seg : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    },

    _rebuildBodyPts(s) {
      const pts = [];
      for (let i = 0; i < s.segments; i++) {
        const p = this._pointAlongPath(s, i * s.spacing);
        if (p) pts.push(p);
      }
      s.bodyPts = pts;
    },

    _applyDragSteer(shell, s, w, h, minSide, dt) {
      const dx = s.pointer.x - s.head.x;
      const dy = s.pointer.y - s.head.y;
      const dist2 = dx * dx + dy * dy;

      if (dist2 > 48 * 48) {
        let target = Math.atan2(dy, dx);
        if (shell.mode === 'mirror' && s.head.x > w / 2) {
          target = Math.PI - target;
        }
        let diff = target - s.head.angle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        const maxTurn = s.turnRate * dt * 1.85;
        s.head.angle += Math.max(-maxTurn, Math.min(maxTurn, diff));
      }

      const dist = Math.sqrt(dist2);
      const near = minSide * 0.07;
      const far = minSide * 0.38;
      const t = Math.max(0, Math.min(1, (dist - near) / (far - near)));
      const targetMult = 0.72 + t * 0.58;
      s.speedMult += (targetMult - s.speedMult) * Math.min(1, dt * 8);
    },

    _orbRadius(s) { return s.headR * 0.92; },
    _obstacleRadius(s) { return s.headR * 1.28; },   // obstacles are bigger than the power-up

    // Find a free spot for one orb, clear of the head, body, and already-placed
    // orbs in this cluster. Returns a fresh orb object (caller tags its kind).
    _placeOrb(s, w, h, placed) {
      const pad = s.headR * 3.5;
      const minDistHead = s.headR * 5;
      const minDistBody = s.headR * 2.2;
      const minDistOrb = s.headR * 5;
      for (let tries = 0; tries < 60; tries++) {
        const x = pad + Math.random() * (w - pad * 2);
        const y = pad + Math.random() * (h - pad * 2);
        const hdx = x - s.head.x, hdy = y - s.head.y;
        if (hdx * hdx + hdy * hdy < minDistHead * minDistHead) continue;
        let ok = true;
        for (const p of s.bodyPts) {
          const dx = x - p.x, dy = y - p.y;
          if (dx * dx + dy * dy < minDistBody * minDistBody) { ok = false; break; }
        }
        if (ok) for (const o of placed) {
          const dx = x - o.x, dy = y - o.y;
          if (dx * dx + dy * dy < minDistOrb * minDistOrb) { ok = false; break; }
        }
        if (!ok) continue;
        return { x, y, age: 0, hueSeed: Math.random() * 360 };
      }
      return { x: pad + Math.random() * (w - pad * 2), y: pad + Math.random() * (h - pad * 2), age: 0, hueSeed: Math.random() * 360 };
    },

    // A cluster: one collectible power-up + OBSTACLE_COUNT hazards.
    _spawnOrbs(shell, s, w, h) {
      const placed = [];
      const power = this._placeOrb(s, w, h, placed);
      power.kind = 'power'; power.morphed = false;
      s.orbs.push(power); placed.push(power);
      for (let i = 0; i < OBSTACLE_COUNT; i++) {
        const o = this._placeOrb(s, w, h, placed);
        o.kind = 'obstacle'; o.morphed = false;
        s.orbs.push(o); placed.push(o);
      }
    },

    _collectOrb(shell, s, orb) {
      s.invincible = INVINCIBLE_SEC;
      const idx = s.orbs.indexOf(orb);
      if (idx >= 0) s.orbs.splice(idx, 1);
      this._spawnEmbers(s, s.head.x, s.head.y, 16, 1.1);
    },

    _updateOrbs(shell, s, w, h, dt) {
      if (!s.orbs.length && s.time >= s.nextOrbAt) {
        this._spawnOrbs(shell, s, w, h);
        s.nextOrbAt = s.time + ORB_SPAWN_EVERY;
      }
      if (!s.orbs.length) return;

      for (const orb of s.orbs) orb.age += dt;
      s.orbs = s.orbs.filter((o) => o.age <= ORB_LIFE);
      // A power-up not grabbed in time sours into an obstacle — and swells:
      // _obstacleRadius is larger and the draw layer gives it a jagged shape.
      for (const orb of s.orbs) {
        if (orb.kind === 'power' && orb.age >= ORB_PICKUP_SEC) { orb.kind = 'obstacle'; orb.morphed = true; }
      }

      const headR = this._headSphereR(s);
      for (const orb of s.orbs) {
        const dx = s.head.x - orb.x, dy = s.head.y - orb.y;
        const dist2 = dx * dx + dy * dy;
        if (orb.kind === 'power') {
          const cr = this._orbRadius(s) * 1.15;
          if (dist2 < (headR + cr) * (headR + cr)) { this._collectOrb(shell, s, orb); break; }
        } else if (s.invincible <= 0) {
          const orR = this._obstacleRadius(s);
          if (dist2 < (headR + orR * 0.82) * (headR + orR * 0.82)) { this._crash(shell, s.head.x, s.head.y); return; }
        }
      }
    },

    _inputActive(s, action) {
      if (action === 'faster') return !!(s.keys['ArrowUp'] || s.keys['w'] || s.keys['W']);
      if (action === 'slower') return !!(s.keys['ArrowDown'] || s.keys['s'] || s.keys['S']);
      if (action === 'turnL') return !!(s.keys['ArrowLeft'] || s.keys['a'] || s.keys['A']);
      if (action === 'turnR') return !!(s.keys['ArrowRight'] || s.keys['d'] || s.keys['D']);
      return false;
    },

    // ---- input ---------------------------------------------------------------
    onPointerMove(shell, x, y) {
      const s = this.state;
      if (!s) return;
      s.pointer.x = x;
      s.pointer.y = y;
    },
    onPointerDown(shell, x, y) {
      const s = this.state;
      if (!s) return;
      if (s.over && s.linger <= 0) { this.reset(shell); return; }
      s.pointer.down = true;
      s.pointer.x = x;
      s.pointer.y = y;
      if (!s.started && !s.over) this._start(shell);
    },
    onPointerUp(shell) {
      const s = this.state;
      if (!s) return;
      s.pointer.down = false;
    },
    _start(shell) {
      const s = this.state;
      if (!s || s.started || s.over) return;
      s.started = true;
      s.paused = false;
      shell.refreshControls();
    },
    onKeyDown(shell, e) {
      const s = this.state;
      if (!s) return;
      if (e.key === ' ') {
        e.preventDefault();
        if (s.over && s.linger <= 0) this.reset(shell);
        else if (!s.started) this._start(shell);
        else if (!s.over) { s.paused = !s.paused; shell.refreshControls(); }
        return;
      }
      const steerKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'W', 'A', 'S', 'D'];
      if (!steerKeys.includes(e.key)) return;
      e.preventDefault();
      s.keys[e.key] = true;
      if (!s.started && !s.over) this._start(shell);
      shell.refreshControls();
    },
    onKeyUp(shell, e) {
      const s = this.state;
      if (!s) return;
      s.keys[e.key] = false;
      shell.refreshControls();
    },

    _planetSpec(segmentIndex) {
      if (segmentIndex === 0) return SUN;
      const pIdx = (segmentIndex - 1) % PLANETS.length;
      const lap = Math.floor((segmentIndex - 1) / PLANETS.length);
      const base = PLANETS[pIdx];
      return {
        name: base.name,
        color: base.color,
        core: base.core || base.color,
        relR: base.relR,
        tint: base.tint,
        seed: base.seed + lap * 1.73,
        zoom: base.zoom + lap * 0.09,
        look: FRACTAL_LOOKS[(pIdx + lap) % 2],
        earth: base.earth,
        bands: base.bands,
        rings: base.rings,
      };
    },

    _sphereR(s, spec) {
      return s.headR * spec.relR;
    },

    // How many segments render as full fractal spheres. Under lowPerf the far
    // tail drops to the (much cheaper) body-spline links only — every sphere
    // costs a distance check per GL pixel per frame, so 48 of them is real
    // money on a struggling machine. 28 keeps the whole near body plump.
    _sphereLimit(shell) {
      return (shell && shell.lowPerf) ? 28 : MAX_SPHERES;
    },

    // ---- fractal spheres -----------------------------------------------------
    spheres(shell) {
      const s = this.state;
      if (!s) return [];
      const pts = s.bodyPts;
      if (!pts || !pts.length) return [];

      const out = [];
      const capture = (s.over && s.crash && s.crash.t < CRASH_FLASH_LIFE)
        ? Math.max(0, 1 - s.crash.t / CRASH_FLASH_LIFE) : 0;

      const shielded = s.invincible > 0;
      const limit = Math.min(pts.length, this._sphereLimit(shell));
      for (let i = 0; i < limit; i++) {
        const spec = this._planetSpec(i);
        const r = this._sphereR(s, spec);
        const born = s.births.some((b) => {
          const dx = b.x - pts[i].x, dy = b.y - pts[i].y;
          return dx * dx + dy * dy < r * r * 4 && b.t < 0.2;
        });
        const flash = shielded ? this._invincibleFlash(s, i) : null;
        // Under lowPerf, collapse the body's alternating Julia/Mandelbrot
        // looks to one: the shell issues a full-canvas shader pass PER look
        // (fractal-shell.js _renderGL groups), so {nova sun, stalks, bands}
        // is 3 passes; {nova, bands} is 2.
        const look = shielded ? 'nova'
          : ((shell.lowPerf && i > 0) ? 'bands' : spec.look);
        out.push({
          x: pts[i].x,
          y: pts[i].y,
          r,
          tint: shielded ? (i % 2) : spec.tint,
          look,
          seed: shielded ? spec.seed + s.time * 0.35 : spec.seed,
          zoom: spec.zoom + (flash ? flash.pulse * 0.08 : 0),
          hover: i === 0 && !s.over && !shell.reducedMotion,
          capture: shielded ? 0.35 + (flash ? flash.pulse * 0.45 : 0)
            : ((i === 0 && capture > 0) ? capture : (born ? 0.85 : 0)),
          frozen: s.over,
        });
      }

      // Orbs are gameplay, not decoration — they always render as spheres
      // (their looks, nova/bands, already fit the lowPerf pass set).
      for (const orb of s.orbs) {
        if (out.length >= MAX_SPHERES) break;
        const pulse = 0.5 + 0.5 * Math.sin(s.time * 9 + orb.hueSeed);
        const obstacle = orb.kind === 'obstacle';
        const rr = obstacle ? this._obstacleRadius(s) : this._orbRadius(s);
        out.push({
          x: orb.x,
          y: orb.y,
          r: rr * (obstacle ? (1.0 + pulse * 0.16) : (0.92 + pulse * 0.14)),
          tint: obstacle ? 0 : 1,
          look: obstacle ? 'bands' : 'nova',
          seed: 12.4 + orb.hueSeed * 0.01,
          zoom: obstacle ? (1.12 + pulse * 0.1) : (1.35 + pulse * 0.12),
          hover: !obstacle && !shell.reducedMotion,
          capture: obstacle ? 0.3 + pulse * 0.25 : 0.55 + pulse * 0.35,
          frozen: false,
        });
      }
      return out;
    },

    // ---- 2D layers -----------------------------------------------------------
    drawBackground(shell, ctx, w, h) {
      const s = this.state;
      ctx.fillStyle = '#04040a';
      ctx.fillRect(0, 0, w, h);

      const amb = ctx.createRadialGradient(w / 2, h * 0.1, 0, w / 2, h * 0.5, Math.max(w, h) * 0.85);
      amb.addColorStop(0, 'rgba(48, 28, 78, 0.38)');
      amb.addColorStop(0.5, 'rgba(16, 10, 28, 0.14)');
      amb.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = amb;
      ctx.fillRect(0, 0, w, h);

      this._drawStarGrid(shell, ctx, w, h);

      if (!s) return;
      this._drawTrail(shell, ctx, w, h);
      this._drawFloorSpots(shell, ctx, s);
    },

    _drawStarGrid(shell, ctx, w, h) {
      const s = this.state;
      const color = TEAM_COLORS[shell.theme][0];
      const len = s ? s.segments : 1;
      const pulse = 0.22 + 0.28 * Math.min(1, len / 45) + 0.06 * Math.sin((s ? s.gridPhase : 0) * 1.8);

      ctx.save();
      ctx.strokeStyle = this._rgba(color, pulse * 0.35);
      ctx.lineWidth = 1;

      // All grid lines share one style — batch them into a single stroke
      // (26 stroke calls -> 1; identical output).
      ctx.beginPath();
      for (let c = 0; c <= this.gridCols; c++) {
        const x = c * this.cellW;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let r = 0; r <= this.gridRows; r++) {
        const y = r * this.cellH;
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();

      // Per-cell twinkle dots (144 arc+fill calls/frame) are the priciest part
      // of the grid — pure decoration, so drop them once frame time is
      // sustained-high (shell.lowPerf); the grid lines above stay.
      if (!shell.lowPerf) {
        ctx.fillStyle = this._rgba(color, pulse * 0.55);
        for (let r = 0; r < this.gridRows; r++) {
          for (let c = 0; c < this.gridCols; c++) {
            const x = (c + 0.5) * this.cellW;
            const y = (r + 0.5) * this.cellH;
            const tw = 0.5 + 0.5 * Math.sin((s ? s.gridPhase : 0) * 2.1 + c * 0.7 + r * 1.1);
            ctx.globalAlpha = pulse * tw * 0.7;
            ctx.beginPath();
            ctx.arc(x, y, Math.min(this.cellW, this.cellH) * 0.04, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.restore();
    },

    _drawTrail(shell, ctx, w, h) {
      const s = this.state;
      if (!s || !s.trail.length) return;
      const color = TEAM_COLORS[shell.theme][0];

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      if (shell.lowPerf) {
        // One polyline, one stroke: up to 319 individually-styled segment
        // strokes cost more than everything else left on this layer under
        // software rasterization. Constant alpha loses the per-segment fade;
        // the trail still reads.
        ctx.strokeStyle = this._rgba(color, 0.16);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(s.trail[0].x, s.trail[0].y);
        for (let i = 1; i < s.trail.length; i++) ctx.lineTo(s.trail[i].x, s.trail[i].y);
        ctx.stroke();
      } else {
        for (let i = 1; i < s.trail.length; i++) {
          const a = s.trail[i - 1], b = s.trail[i];
          const fadeA = 1 - a.age / TRAIL_LIFE;
          const fadeB = 1 - b.age / TRAIL_LIFE;
          if (fadeA <= 0 && fadeB <= 0) continue;
          const alpha = Math.min(fadeA, fadeB) * 0.22;
          ctx.strokeStyle = this._rgba(color, alpha);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      // Up to TRAIL_MAX (320) per-point radial gradients is the single most
      // expensive loop in this file — skip the point glow under lowPerf and
      // keep just the (already-drawn) connecting line segments above, which
      // still read as a trail.
      if (!shell.lowPerf) {
        for (const t of s.trail) {
          const fade = 1 - t.age / TRAIL_LIFE;
          if (fade <= 0) continue;
          const g = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, 5);
          g.addColorStop(0, this._rgba(color, fade * 0.55));
          g.addColorStop(1, this._rgba(color, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(t.x, t.y, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    },

    _drawFloorSpots(shell, ctx, s) {
      const pts = s.bodyPts;
      if (!pts || !pts.length) return;
      if (shell.lowPerf) return;  // ambient floor glow — purely decorative, up to 24 gradients/frame
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const limit = Math.min(pts.length, MAX_SPHERES);
      for (let i = 0; i < limit; i += 2) {
        const spec = this._planetSpec(i);
        const flash = s.invincible > 0 ? this._invincibleFlash(s, i) : null;
        const spotColor = flash ? flash.color : spec.color;
        const p = pts[i];
        const pr = this._sphereR(s, spec) * 0.65;
        const g = ctx.createRadialGradient(p.x, p.y + pr * 0.35, 0, p.x, p.y + pr * 0.35, pr * 1.35);
        g.addColorStop(0, flash ? spotColor : this._rgba(spec.color, 0.14));
        g.addColorStop(0.55, flash ? this._hsla(flash.hue, 85, 60, 0.12) : this._rgba(spec.color, 0.05));
        g.addColorStop(1, this._rgba(spec.color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y + pr * 0.35, pr * 1.35, pr * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },

    _drawPlanetFeatures(shell, ctx, s) {
      const pts = s.bodyPts;
      if (!pts || !pts.length) return;
      const limit = Math.min(pts.length, this._sphereLimit(shell));

      for (let i = 0; i < limit; i++) {
        const spec = this._planetSpec(i);
        const flash = s.invincible > 0 ? this._invincibleFlash(s, i) : null;
        const p = pts[i];
        const r = this._sphereR(s, spec);

        // Under lowPerf the wash below (clip + radial gradient + fill, per
        // segment, per frame) is the last per-segment gradient still running —
        // a flat translucent disc keeps each planet's identity color for a
        // tiny fraction of the cost.
        if (shell.lowPerf) {
          ctx.save();
          ctx.globalAlpha = 0.5;
          ctx.fillStyle = flash ? flash.color : spec.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 0.96, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          continue;
        }

        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.clip();
        const wash = ctx.createRadialGradient(
          p.x - r * 0.28, p.y - r * 0.32, r * 0.08,
          p.x, p.y, r
        );
        if (flash) {
          wash.addColorStop(0, flash.core);
          wash.addColorStop(0.45, flash.color);
          wash.addColorStop(0.88, this._hsla((flash.hue + 90) % 360, 90, 52, 0.75));
          wash.addColorStop(1, this._hsla((flash.hue + 150) % 360, 85, 45, 0.35));
        } else {
          wash.addColorStop(0, this._rgba(spec.core, 0.82));
          wash.addColorStop(0.45, this._rgba(spec.color, 0.72));
          wash.addColorStop(0.88, this._rgba(spec.color, 0.55));
          wash.addColorStop(1, this._rgba(spec.color, 0.28));
        }
        ctx.fillStyle = wash;
        ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
        ctx.restore();

        // Halo glow + band/earth/ring embellishments — pure decoration on top
        // of the wash (lowPerf never reaches here; it took the flat-disc
        // branch above).
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const glow = ctx.createRadialGradient(p.x, p.y, r * 0.55, p.x, p.y, r * 1.35);
        if (flash) {
          glow.addColorStop(0, this._hsla(flash.hue, 90, 70, 0));
          glow.addColorStop(0.72, this._hsla((flash.hue + 40) % 360, 92, 62, 0.42 * flash.pulse));
          glow.addColorStop(1, this._hsla((flash.hue + 100) % 360, 85, 55, 0));
        } else {
          glow.addColorStop(0, this._rgba(spec.color, 0));
          glow.addColorStop(0.72, this._rgba(spec.color, 0.35));
          glow.addColorStop(1, this._rgba(spec.color, 0));
        }
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 1.35, 0, Math.PI * 2);
        ctx.fill();

        if (spec.bands) {
          ctx.strokeStyle = this._rgba('#6b3f18', 0.5);
          ctx.lineWidth = Math.max(1, r * 0.08);
          for (let b = -2; b <= 2; b++) {
            const y = p.y + b * r * 0.18;
            ctx.beginPath();
            ctx.ellipse(p.x, y, r * 0.82, r * 0.22, 0, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.strokeStyle = this._rgba('#e8c898', 0.4);
          ctx.lineWidth = Math.max(1, r * 0.05);
          for (let b = -1; b <= 1; b += 2) {
            const y = p.y + b * r * 0.1;
            ctx.beginPath();
            ctx.ellipse(p.x, y, r * 0.78, r * 0.16, 0, 0, Math.PI * 2);
            ctx.stroke();
          }
        }

        if (spec.earth) {
          const eg = ctx.createRadialGradient(p.x - r * 0.2, p.y + r * 0.1, 0, p.x - r * 0.2, p.y + r * 0.1, r * 0.55);
          eg.addColorStop(0, this._rgba('#4caf50', 0.65));
          eg.addColorStop(0.5, this._rgba('#2e8b57', 0.45));
          eg.addColorStop(1, this._rgba(spec.color, 0));
          ctx.fillStyle = eg;
          ctx.beginPath();
          ctx.arc(p.x - r * 0.15, p.y + r * 0.05, r * 0.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = this._rgba('#ffffff', 0.25);
          ctx.beginPath();
          ctx.arc(p.x + r * 0.22, p.y - r * 0.18, r * 0.14, 0, Math.PI * 2);
          ctx.fill();
        }

        if (spec.rings) {
          ctx.strokeStyle = this._rgba('#e8d9b0', 0.7);
          ctx.lineWidth = Math.max(1.2, r * 0.09);
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, r * 1.55, r * 0.42, 0.18, 0, Math.PI * 2);
          ctx.stroke();
          ctx.strokeStyle = this._rgba('#c9b888', 0.5);
          ctx.lineWidth = Math.max(1, r * 0.05);
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, r * 1.25, r * 0.34, 0.18, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }
    },

    drawForeground(shell, ctx, w, h) {
      const s = this.state;
      if (!s) return;
      const color = TEAM_COLORS[shell.theme][0];

      this._drawBodySpline(shell, ctx, s);
      this._drawPlanetFeatures(shell, ctx, s);
      this._drawBirthGlows(shell, ctx, s, color);
      this._drawEmbers(shell, ctx, s, color);
      this._drawHeadHalo(shell, ctx, s, color);
      this._drawOrbs(shell, ctx, s);
      this._drawInvincible(shell, ctx, s);
      this._drawDragGuide(shell, ctx, s, color);

      if (s.crash && s.crash.t < CRASH_FLASH_LIFE) {
        const t = s.crash.t / CRASH_FLASH_LIFE;
        const r = s.headR * (2 + t * 6);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createRadialGradient(s.crash.x, s.crash.y, 0, s.crash.x, s.crash.y, r);
        g.addColorStop(0, 'rgba(255, 240, 210, ' + (0.55 * (1 - t)) + ')');
        g.addColorStop(0.35, this._rgba(color, 0.35 * (1 - t)));
        g.addColorStop(1, this._rgba(color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(s.crash.x, s.crash.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // HUD
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = '300 ' + Math.round(Math.min(w, h) * 0.055) + 'px -apple-system, system-ui, sans-serif';
      // shadowBlur is one of the most expensive Canvas2D ops under software
      // rasterization — drop it once lowPerf trips; the text stays readable.
      if (!shell.lowPerf) {
        ctx.shadowColor = 'rgba(0,0,0,0.7)';
        ctx.shadowBlur = 6;
      }
      ctx.fillStyle = 'rgba(232,232,240,0.88)';
      ctx.fillText(this._fmtTime(s.time), w / 2, Math.min(w, h) * 0.03);

      ctx.font = '300 ' + Math.round(Math.min(w, h) * 0.038) + 'px -apple-system, system-ui, sans-serif';
      ctx.fillStyle = this._rgba(color, 0.9);
      const tailIdx = Math.min(s.segments - 1, MAX_SPHERES - 1);
      const tailName = this._planetSpec(tailIdx).name;
      let hud = 'Length ' + s.segments + '   ·   Tail: ' + tailName + '   ·   Best ' + s.best;
      if (s.invincible > 0) hud += '   ·   Shield ' + Math.ceil(s.invincible) + 's';
      ctx.fillText(hud, w / 2, Math.min(w, h) * 0.09);
      ctx.restore();

      if (s.over && s.linger > 0) {
        this._banner(ctx, w, h, color, 'Knotted', 'Your mandala lingers…');
      } else if (s.over) {
        this._banner(ctx, w, h, color, 'Serpent Bloom', 'Space for a rematch');
      } else if (s.paused) {
        this._banner(ctx, w, h, '#e8e8f0', 'Paused', 'Space to resume');
      } else if (!s.started) {
        this._subtitle(ctx, w, h, 'Drag or press Space to start');
      }
    },

    _drawBodySpline(shell, ctx, s) {
      const pts = s.bodyPts;
      if (!pts || pts.length < 2) return;

      const sphereCap = Math.min(pts.length, this._sphereLimit(shell));
      const hasSphere = (i) => i < sphereCap;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (let i = 1; i < pts.length; i++) {
        if (hasSphere(i) && hasSphere(i - 1)) continue;
        const spec = this._planetSpec(i);
        const flash = s.invincible > 0 ? this._invincibleFlash(s, i) : null;
        const alpha = 0.12 + 0.2 * (1 - i / pts.length);
        ctx.strokeStyle = flash ? this._hsla(flash.hue, 88, 58, alpha * 1.4 * flash.pulse) : this._rgba(spec.color, alpha);
        ctx.lineWidth = s.headR * (0.3 + 0.35 * (1 - i / pts.length));
        ctx.beginPath();
        ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
        ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
      ctx.restore();
    },

    _drawBirthGlows(shell, ctx, s, color) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const b of s.births) {
        const t = b.t / BIRTH_GLOW_LIFE;
        const pulse = 1 - t;
        const r = s.headR * (1.2 + t * 2.2);
        const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r);
        g.addColorStop(0, this._rgba(color, 0.45 * pulse));
        g.addColorStop(0.4, this._rgba(color, 0.15 * pulse));
        g.addColorStop(1, this._rgba(color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },

    _drawEmbers(shell, ctx, s, color) {
      if (!s.embers.length) return;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const e of s.embers) {
        const fade = 1 - e.age / e.life;
        ctx.fillStyle = this._rgba(color, fade * 0.75);
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r * fade, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },

    _orbHue(s, orb, t) {
      const cycle = (orb.hueSeed + s.time * (orb.age < ORB_PICKUP_SEC ? 140 : 60)) % 360;
      const flash = 0.55 + 0.45 * Math.sin(s.time * 14 + orb.hueSeed);
      const hue = (cycle + ORB_HUES[Math.floor(s.time * 2.2) % ORB_HUES.length] * 0.35) % 360;
      return { hue, flash: flash * (0.65 + 0.35 * Math.sin(t * 18)) };
    },

    _hsla(h, s, l, a) {
      return 'hsla(' + h + ',' + s + '%,' + l + '%,' + a + ')';
    },

    _drawOrbs(shell, ctx, s) {
      if (!s.orbs || !s.orbs.length) return;
      for (const orb of s.orbs) this._drawSingleOrb(shell, ctx, s, orb);
    },

    _drawSingleOrb(shell, ctx, s, orb) {
      const obstacle = orb.kind === 'obstacle';
      const r = obstacle ? this._obstacleRadius(s) : this._orbRadius(s);
      const { hue, flash } = this._orbHue(s, orb, orb.age);
      const pulse = 0.5 + 0.5 * Math.sin(s.time * 10 + orb.hueSeed);
      // A just-soured power-up briefly pops bigger as it morphs.
      const morphPop = (obstacle && orb.morphed)
        ? 1 + 0.3 * Math.max(0, 1 - (orb.age - ORB_PICKUP_SEC) / 0.6) : 1;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // Fewer concentric gradient rings once frame time is sustained-high —
      // still reads as a glowing orb, just with less falloff detail.
      const rings = shell.lowPerf ? 1 : (obstacle ? 3 : 5);
      for (let i = rings; i >= 0; i--) {
        const t = i / rings;
        const rr = r * morphPop * (1.35 + t * (obstacle ? 1.1 : 1.8) + pulse * 0.25);
        const g = ctx.createRadialGradient(orb.x, orb.y, r * 0.2, orb.x, orb.y, rr);
        if (obstacle) {
          g.addColorStop(0, this._hsla(4, 95, 58, flash * 0.55 * (1 - t * 0.5)));
          g.addColorStop(0.45, this._hsla(0, 90, 45, flash * 0.35 * (1 - t)));
          g.addColorStop(1, this._hsla(0, 80, 30, 0));
        } else {
          const h = (hue + i * 38) % 360;
          g.addColorStop(0, this._hsla(h, 92, 68, flash * 0.5 * (1 - t * 0.35)));
          g.addColorStop(0.5, this._hsla((h + 55) % 360, 88, 55, flash * 0.28 * (1 - t * 0.6)));
          g.addColorStop(1, this._hsla((h + 120) % 360, 85, 45, 0));
        }
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(orb.x, orb.y, rr, 0, Math.PI * 2);
        ctx.fill();
      }

      if (obstacle) {
        // Non-linear (jagged star) outline so an obstacle reads differently from
        // the smooth, round power-up — and clearly bigger.
        const spikes = 9;
        const rot = s.time * 0.9 + orb.hueSeed;
        const outR = r * morphPop * (1.18 + pulse * 0.1);
        const inR = outR * 0.6;
        ctx.strokeStyle = this._hsla(0, 100, 68, 0.45 + pulse * 0.35);
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let k = 0; k <= spikes * 2; k++) {
          const ang = (k / (spikes * 2)) * Math.PI * 2 + rot;
          const rad = (k % 2 === 0) ? outR : inR;
          const px = orb.x + Math.cos(ang) * rad, py = orb.y + Math.sin(ang) * rad;
          if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      } else {
        const remain = ORB_PICKUP_SEC - orb.age;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '600 ' + Math.round(r * 0.95) + 'px -apple-system, system-ui, sans-serif';
        ctx.fillStyle = this._hsla(hue, 30, 96, 0.55 + pulse * 0.25);
        ctx.fillText(String(Math.max(1, Math.ceil(remain))), orb.x, orb.y + r * 0.05);
      }
      ctx.restore();
    },

    _drawInvincible(shell, ctx, s) {
      if (s.invincible <= 0) return;
      const pts = s.bodyPts;
      if (!pts || !pts.length) return;
      const t = s.invincible / INVINCIBLE_SEC;
      const limit = Math.min(pts.length, this._sphereLimit(shell));

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < limit; i++) {
        const flash = this._invincibleFlash(s, i);
        const p = pts[i];
        const r = this._sphereR(s, this._planetSpec(i));
        const ringR = r * (1.12 + flash.pulse * 0.22);
        ctx.strokeStyle = this._hsla((flash.hue + 30) % 360, 92, 72, 0.5 * t * flash.pulse);
        ctx.lineWidth = Math.max(1.5, r * 0.12);
        ctx.beginPath();
        ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    },

    _drawHeadHalo(shell, ctx, s, color) {
      if (s.turnHalo <= 0) return;
      const pts = s.bodyPts;
      if (!pts || !pts.length) return;
      const h = pts[0];
      const t = s.turnHalo / TURN_HALO_LIFE;
      const r = s.headR * (1.8 + (1 - t) * 0.8);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(h.x, h.y, s.headR * 0.5, h.x, h.y, r);
      g.addColorStop(0, this._rgba(color, 0));
      g.addColorStop(0.55, this._rgba(color, 0.22 * t));
      g.addColorStop(1, this._rgba(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },

    _drawDragGuide(shell, ctx, s, color) {
      if (!s.pointer.down || !s.started || s.over || s.paused) return;
      const head = s.bodyPts && s.bodyPts[0];
      if (!head) return;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = this._rgba(color, 0.28);
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 8]);
      ctx.beginPath();
      ctx.moveTo(head.x, head.y);
      ctx.lineTo(s.pointer.x, s.pointer.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = this._rgba(color, 0.55);
      ctx.beginPath();
      ctx.arc(s.pointer.x, s.pointer.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },

    _subtitle(ctx, w, h, text) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
      ctx.shadowBlur = Math.round(h * 0.03);
      ctx.fillStyle = 'rgba(232,232,240,0.7)';
      ctx.font = '300 ' + Math.round(h * 0.034) + 'px -apple-system, system-ui, sans-serif';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(text, w / 2, h * 0.52);
      ctx.restore();
    },

    _banner(ctx, w, h, color, title, subtitle) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
      ctx.shadowBlur = Math.round(h * 0.03);
      ctx.fillStyle = color;
      ctx.font = '300 ' + Math.round(h * 0.085) + 'px -apple-system, system-ui, sans-serif';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(title, w / 2, h * 0.48);
      ctx.fillStyle = 'rgba(232,232,240,0.7)';
      ctx.font = '300 ' + Math.round(h * 0.034) + 'px -apple-system, system-ui, sans-serif';
      ctx.fillText(subtitle, w / 2, h * 0.55);
      ctx.restore();
    },

    _fmtTime(t) {
      const sec = Math.max(0, Math.floor(t));
      const m = Math.floor(sec / 60);
      const r = sec % 60;
      return m + ':' + String(r).padStart(2, '0');
    },

    _rgba(hex, a) {
      const n = parseInt(hex.slice(1), 16);
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    },
  };

  window.SerpentGame = SerpentGame;
})();