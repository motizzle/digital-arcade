/* ============================================================================
   Fractal Game Shell
   ----------------------------------------------------------------------------
   A reusable engine for games whose "pieces" are fractal-textured 3D spheres
   (Mandelbrot / Julia / Newton). Lifted from the Fractal Checkers engine.

   The shell owns everything generic:
     - the 3-layer canvas stack (bg 2D / WebGL spheres / ui 2D)
     - DOM chrome (header, control bar, mode switch, theme switch)
     - the WebGL fractal-sphere renderer (verbatim shader from checkers)
     - DPR / resize, reduced-motion handling, the animation loop
     - input plumbing (pointer + keyboard) forwarded to the game
     - favicon bake

   A GAME is a plain object implementing the interface documented in README.md:
     id, title, subtitle?, aspect?, modes[], controls[],
     reset(shell), resize(shell,w,h), update(shell,dt),
     drawBackground(shell,ctx,w,h), drawForeground(shell,ctx,w,h),
     spheres()  -> [{x,y,r,tint,look,seed,hover,zoom,frozen,capture}],
     onPointerMove/Down/Up(shell,x,y), onKeyDown/Up(shell,e)

   The game works entirely in CSS pixels. The shell handles DPR scaling and the
   WebGL y-flip when it uploads spheres to the GPU.
   ========================================================================== */
(function () {
  'use strict';

  // ---- Fractal type / coloring / trap / palette enums (verbatim, checkers:362) -
  const F_JULIA = 0, F_NEWTON3 = 1, F_NEWTON4 = 2, F_BURNINGSHIP = 3,
        F_MANDELBROT = 4, F_PHOENIX = 5, F_NOVA = 6;
  const C_ESCAPE = 0, C_TRAP = 1, C_TRAP_ESCAPE = 2, C_DE_GLOW = 3,
        C_NORMAL_3D = 4, C_NEWTON_BAS = 5, C_BANDS = 6, C_PICKOVER = 7;
  const T_POINT = 0, T_CIRCLE = 1, T_PICKOVER = 2;
  const PAL_WARM = 0, PAL_COOL = 1, PAL_ACID = 2;

  const MAX_DPR = 2;
  const FORCED_SSAA = 1;
  // Pixel budget for the fractal (WebGL) layer. Its shader cost is per-pixel
  // (up to 320 iterations each, ×4 with SSAA), so the backing store is capped
  // at ~720p and CSS-scaled up: fullscreen on a large display renders the
  // spheres at the same cost as a windowed board instead of shading 2–8M
  // pixels a frame (which made fullscreen unplayably slow). The 2D bg/ui
  // layers keep full DPR so text and lines stay crisp (until lowPerf latches —
  // then every layer shares the capped scale).
  const GL_MAX_PIXELS = 1280 * 720;
  // Don't cap a board that's only slightly over budget: a fractional
  // downscale forces the compositor to RESAMPLE the layer every frame
  // (expensive under software compositing — the kiosk) for almost no shader
  // savings. Serpent's 96vmin board on a 1080p screen is 1.17× budget; the
  // first cut of this cap resampled it every frame and made the game SLOWER
  // windowed than before the cap existed.
  const GL_BUDGET_TOLERANCE = 1.35;
  const MAX_PIECES = 64;        // shell supports many spheres (checkers); pong uses 1

  // ---- Built-in fractal "looks" a game can choose per sphere (checkers:382) ----
  // A game references these by key (e.g. sphere.look = 'bands').
  const PRESETS = {
    // Mandelbrot, banded coloring — flowing concentric bands.
    bands: {
      fractal: F_MANDELBROT, coloring: C_BANDS, palette: PAL_COOL,
      p: { zoomCx: -0.745, zoomCy: 0.113, zoomScale: 0.012, trapScale: 4.0, maxIter: 320 },
    },
    // Julia, Pickover-stalk coloring — luminous filaments on a tinted glow.
    stalks: {
      fractal: F_JULIA, coloring: C_PICKOVER, palette: PAL_ACID,
      p: { jCx: -0.4, jCy: 0.6, trapShape: T_PICKOVER, trapScale: 5.0, viewScale: 0.55, maxIter: 180 },
    },
    // Newton/Nova basins — kaleidoscopic root-coloring.
    nova: {
      fractal: F_NOVA, coloring: C_NEWTON_BAS, palette: PAL_ACID,
      p: { maxIter: 64, relax: 1.0 },
    },
  };

  const THEME_NAMES = ['Fire / Ice', 'Acid / Violet'];

  // ---- Shaders (verbatim from checkers.html:1256-1768) -------------------------
  const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = (aPos + 1.0) * 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

  const FRAG_SRC = `
#extension GL_OES_standard_derivatives : enable
#ifdef GL_FRAGMENT_PRECISION_HIGH
  precision highp float;
#else
  precision mediump float;
#endif

varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform int uPieceCount;
uniform vec4 uPiecesA[${MAX_PIECES}];
uniform vec4 uPiecesB[${MAX_PIECES}];
uniform float uPieceFrozen[${MAX_PIECES}];
uniform float uPieceSeedId[${MAX_PIECES}];

uniform int uFractalType;
uniform int uColoring;
uniform int uPalette;
uniform float uMaxIter;
uniform vec2 uJuliaC;
uniform vec2 uZoomCenter;
uniform float uZoomScale;
uniform int uTrapShape;
uniform vec2 uTrapPos;
uniform float uTrapScale;
uniform float uTrapRadius;
uniform float uRelax;
uniform int uSSAA;
uniform float uViewScale;
uniform int uTheme;

const float BAILOUT2 = 65536.0;
const int  MAX_ITER_HARD = 320;

vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  return a + b * cos(6.2831853 * (c * t + d));
}
vec3 paletteWarm(float t) { return palette(t, vec3(0.55,0.42,0.30), vec3(0.40,0.38,0.30), vec3(1.00,1.00,0.55), vec3(0.0,0.20,0.50)); }
vec3 paletteCool(float t) { return palette(t, vec3(0.50,0.50,0.50), vec3(0.50,0.50,0.50), vec3(1.00,1.00,1.00), vec3(0.0,0.33,0.67)); }
vec3 paletteAcid(float t) { return palette(t, vec3(0.50,0.50,0.50), vec3(0.45,0.40,0.42), vec3(1.40,0.80,0.20), vec3(0.50,0.20,0.25)); }

vec3 teamPalette(float t, float playerTint) {
  vec3 a, b, c, d;
  if (uTheme == 0) {
    if (playerTint > 0.0) {
      a = vec3(0.55, 0.08, 0.05); b = vec3(1.00, 0.40, 0.05);
      c = vec3(1.00, 0.85, 0.20); d = vec3(1.00, 0.65, 0.45);
    } else {
      a = vec3(0.02, 0.12, 0.45); b = vec3(0.10, 0.55, 1.00);
      c = vec3(0.20, 0.92, 1.00); d = vec3(0.50, 0.30, 1.00);
    }
  } else if (uTheme == 1) {
    if (playerTint > 0.0) {
      a = vec3(0.05, 0.30, 0.08); b = vec3(0.20, 0.85, 0.20);
      c = vec3(0.85, 1.00, 0.15); d = vec3(0.40, 1.00, 0.05);
    } else {
      a = vec3(0.20, 0.05, 0.45); b = vec3(0.70, 0.10, 1.00);
      c = vec3(1.00, 0.20, 0.85); d = vec3(1.00, 0.55, 0.85);
    }
  }
  t = fract(t); float s = t * 4.0;
  int idx = int(floor(s)); float f = smoothstep(0.0, 1.0, fract(s));
  vec3 k0, k1;
  if (idx == 0)      { k0 = a; k1 = b; }
  else if (idx == 1) { k0 = b; k1 = c; }
  else if (idx == 2) { k0 = c; k1 = d; }
  else               { k0 = d; k1 = a; }
  return mix(k0, k1, f);
}

float hash11(float p) {
  p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p);
}
float ign(vec2 px) {
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}

vec2 cMul(vec2 a, vec2 b) { return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
vec2 cDiv(vec2 a, vec2 b) {
  float d = dot(b, b);
  return vec2(a.x*b.x + a.y*b.y, a.y*b.x - a.x*b.y) / max(d, 1e-12);
}
vec2 cSqr(vec2 z) { return vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y); }

vec3 pickPalette(float t) {
  if (uPalette == ${PAL_WARM}) return paletteWarm(t);
  if (uPalette == ${PAL_COOL}) return paletteCool(t);
  return paletteAcid(t);
}

void updateTrap(inout float trapMin, inout vec2 trapPos, vec2 z, float seedT, float pieceTime) {
  if (uTrapShape == ${T_POINT}) {
    float d = dot(z - uTrapPos, z - uTrapPos);
    if (d < trapMin) { trapMin = d; trapPos = z; }
  } else if (uTrapShape == ${T_CIRCLE}) {
    float d = abs(length(z - uTrapPos) - uTrapRadius);
    if (d*d < trapMin) { trapMin = d*d; trapPos = z; }
  } else if (uTrapShape == ${T_PICKOVER}) {
    float dirSign = (seedT > 0.5) ? 1.0 : -1.0;
    float ang = pieceTime * 0.55 * dirSign + 0.32 * sin(pieceTime * 0.137) + seedT * 6.2832;
    float ca = cos(ang), sa = sin(ang);
    vec2 driftCenter = vec2(
      0.15 * sin(pieceTime * 0.073 + seedT * 6.28),
      0.15 * cos(pieceTime * 0.061 + seedT * 4.71)
    );
    vec2 zs = z - driftCenter;
    vec2 zr = vec2(zs.x * ca + zs.y * sa, -zs.x * sa + zs.y * ca);
    float d = min(abs(zr.x), abs(zr.y));
    if (d*d < trapMin) { trapMin = d*d; trapPos = z; }
  }
}

vec3 newtonRootColor(int rootIdx) {
  float t;
  if (uFractalType == ${F_NEWTON3} || uFractalType == ${F_NOVA}) {
    if (rootIdx == 0)      t = 0.05;
    else if (rootIdx == 1) t = 0.40;
    else                   t = 0.75;
  } else {
    if (rootIdx == 0)      t = 0.05;
    else if (rootIdx == 1) t = 0.30;
    else if (rootIdx == 2) t = 0.55;
    else                   t = 0.80;
  }
  return pickPalette(t);
}

struct NewtonResult { int rootIdx; float iters; float distLast; vec2 z; };
NewtonResult iterateNewton(vec2 z0, float seedT, float pieceTime) {
  vec2 z = z0;
  int rootIdx = -1;
  int N = int(uMaxIter);
  if (N > MAX_ITER_HARD) N = MAX_ITER_HARD;
  int iters = 0;
  float distLast = 1.0;
  float relax = uRelax + 0.07 * sin(pieceTime * 0.7 + seedT * 6.28);
  vec2 lissajousCenter = vec2(
    0.10 * sin(pieceTime * 0.029 + seedT * 6.28),
    0.08 * cos(pieceTime * 0.041 + seedT * 4.71)
  );
  vec2 novaC = (uFractalType == ${F_NOVA})
    ? lissajousCenter + vec2(
        0.30 * cos(pieceTime * 0.200 + seedT * 6.28) + 0.12 * cos(pieceTime * 0.117),
        0.30 * sin(pieceTime * 0.231 + seedT * 6.28) + 0.12 * sin(pieceTime * 0.151)
      )
    : vec2(0.0);
  for (int j = 0; j < MAX_ITER_HARD; j++) {
    if (j >= N) break;
    vec2 prev = z;
    if (uFractalType == ${F_NEWTON3} || uFractalType == ${F_NOVA}) {
      vec2 z2 = cSqr(z);
      vec2 z3 = cMul(z2, z);
      vec2 num = z3 - vec2(1.0, 0.0);
      vec2 den = 3.0 * z2;
      z = z - relax * cDiv(num, den) + novaC;
    } else {
      vec2 z2 = cSqr(z);
      vec2 z4 = cSqr(z2);
      vec2 num = z4 - vec2(1.0, 0.0);
      vec2 den = 4.0 * cMul(z2, z);
      z = z - relax * cDiv(num, den);
    }
    float d = length(z - prev);
    distLast = d;
    iters = j + 1;
    if (d < 1e-4) break;
  }
  if (uFractalType == ${F_NOVA}) {
    float ang = atan(z.y, z.x);
    if (ang < 0.0) ang += 6.2831853;
    ang = mod(ang + 1.0471975, 6.2831853);
    rootIdx = int(floor(ang / 2.0943951));
    if (rootIdx > 2) rootIdx = 2;
  } else {
    vec2 roots3[3];
    roots3[0] = vec2(1.0, 0.0);
    roots3[1] = vec2(-0.5,  0.8660254);
    roots3[2] = vec2(-0.5, -0.8660254);
    vec2 roots4[4];
    roots4[0] = vec2(1.0, 0.0);
    roots4[1] = vec2(0.0, 1.0);
    roots4[2] = vec2(-1.0, 0.0);
    roots4[3] = vec2(0.0, -1.0);
    float bestD = 1e10;
    if (uFractalType == ${F_NEWTON3}) {
      for (int k = 0; k < 3; k++) {
        float dd = length(z - roots3[k]);
        if (dd < bestD) { bestD = dd; rootIdx = k; }
      }
    } else {
      for (int k = 0; k < 4; k++) {
        float dd = length(z - roots4[k]);
        if (dd < bestD) { bestD = dd; rootIdx = k; }
      }
    }
  }
  return NewtonResult(rootIdx, float(iters), distLast, z);
}

struct EscapeResult { vec2 z; vec2 dz; float smoothIter; bool escaped; float trapMin; vec2 trapPos; };
EscapeResult iterateEscape(vec2 z0, vec2 c0, float seedT, float pieceTime) {
  vec2 z = z0;
  vec2 dz = vec2(1.0, 0.0);
  float m2 = dot(z, z);
  float smoothIter = uMaxIter;
  float trapMin = 1e10;
  vec2 trapPos = vec2(0.0);
  bool escaped = false;
  int N = int(uMaxIter);
  if (N > MAX_ITER_HARD) N = MAX_ITER_HARD;
  for (int j = 0; j < MAX_ITER_HARD; j++) {
    if (j >= N) break;
    if (uFractalType == ${F_JULIA} || uFractalType == ${F_MANDELBROT}) {
      dz = 2.0 * cMul(z, dz);
      if (uFractalType == ${F_MANDELBROT}) dz += vec2(1.0, 0.0);
    }
    if (uFractalType == ${F_JULIA}) {
      z = cSqr(z) + c0;
    } else if (uFractalType == ${F_MANDELBROT}) {
      z = cSqr(z) + c0;
    }
    m2 = dot(z, z);
    updateTrap(trapMin, trapPos, z, seedT, pieceTime);
    if (m2 > BAILOUT2) {
      smoothIter = float(j) - log2(log2(m2)) + 4.0;
      escaped = true;
      break;
    }
  }
  return EscapeResult(z, dz, smoothIter, escaped, trapMin, trapPos);
}

vec4 shadeAt(vec2 fc) {
  vec3 coreCol = vec3(0.0);
  float coreAlpha = 0.0;

  for (int i = 0; i < ${MAX_PIECES}; i++) {
    if (i >= uPieceCount) break;
    vec4 A = uPiecesA[i];
    vec4 B = uPiecesB[i];
    vec2 cPos = A.xy;
    float r = A.z;
    float playerTint = B.x;
    float hover = B.y;
    float zoom = B.z;
    float capture = B.w;

    float dist = length(fc - cPos);
    if (dist > r) continue;

    float seed = hash11(uPieceSeedId[i] + 0.137);
    vec2 sphereLocal = (fc - cPos) / r;

    float r2 = dot(sphereLocal, sphereLocal);
    float sphereZ = sqrt(max(1.0 - r2, 1e-4));
    vec2 local = sphereLocal / max(0.5 + 0.5 * sphereZ, 0.01);

    float frozen = uPieceFrozen[i];
    float pieceTime = mix(uTime, seed * 100.0, frozen);
    float effTime = pieceTime;

    float spinDir = (seed > 0.5) ? 1.0 : -1.0;
    float pieceAng = seed * 6.2832 + effTime * (0.04 + 0.06 * seed) * spinDir;
    float pCa = cos(pieceAng), pSa = sin(pieceAng);
    local = vec2(local.x * pCa - local.y * pSa, local.x * pSa + local.y * pCa);

    vec2 z0, c0;
    float seedB = fract(seed * 17.137 + 0.31);
    float pertAng = seedB * 6.2832;
    vec2 pert = vec2(cos(pertAng), sin(pertAng));

    if (uFractalType == ${F_JULIA}) {
      z0 = local * uViewScale * (1.55 / max(zoom, 0.4));
      if (hover > 0.5) {
        float n = max(dot(z0, z0), 0.0008);
        z0 = vec2(z0.x, -z0.y) / n;
      }
      int jIdx = int(floor(seed * 8.0));
      vec2 cBase;
      if (jIdx == 0)      cBase = vec2(-0.700,  0.270);
      else if (jIdx == 1) cBase = vec2(-0.400,  0.600);
      else if (jIdx == 2) cBase = vec2( 0.285,  0.010);
      else if (jIdx == 3) cBase = vec2(-0.835, -0.2321);
      else if (jIdx == 4) cBase = vec2( 0.355,  0.355);
      else if (jIdx == 5) cBase = vec2(-0.512,  0.521);
      else if (jIdx == 6) cBase = vec2( 0.420, -0.220);
      else                cBase = vec2(-1.135,  0.260);
      c0 = cBase + 0.050 * pert;
    } else if (uFractalType == ${F_MANDELBROT}) {
      z0 = vec2(0.0);
      int mIdx = int(floor(seed * 8.0));
      vec2 mCenter; float mScale;
      if (mIdx == 0)      { mCenter = vec2(-0.50,    0.00);    mScale = 1.40;  }
      else if (mIdx == 1) { mCenter = vec2(-0.745,   0.113);   mScale = 0.055; }
      else if (mIdx == 2) { mCenter = vec2( 0.282,   0.012);   mScale = 0.060; }
      else if (mIdx == 3) { mCenter = vec2(-1.40,    0.0);     mScale = 0.32;  }
      else if (mIdx == 4) { mCenter = vec2(-0.16,    1.04);    mScale = 0.32;  }
      else if (mIdx == 5) { mCenter = vec2(-0.7269,  0.1889);  mScale = 0.045; }
      else if (mIdx == 6) { mCenter = vec2(-0.0805,  0.6650);  mScale = 0.080; }
      else                { mCenter = vec2(-1.249,   0.04);    mScale = 0.110; }
      mCenter += pert * mScale * 0.50;
      vec2 zoomedLocal = local * (1.0 / max(zoom, 0.4));
      c0 = mCenter + zoomedLocal * mScale;
    } else {
      z0 = local * uViewScale * (1.6 / max(zoom, 0.4));
      c0 = vec2(0.0);
    }

    vec3 col = vec3(0.0);
    if (uFractalType == ${F_NEWTON3} || uFractalType == ${F_NEWTON4} || uFractalType == ${F_NOVA}) {
      NewtonResult R = iterateNewton(z0, seed, pieceTime);
      vec3 root = newtonRootColor(R.rootIdx);
      col = root;
      float boundary = smoothstep(0.55, 0.85, R.iters / uMaxIter);
      col = mix(col, vec3(0.02), boundary * 0.85);
    } else {
      EscapeResult E = iterateEscape(z0, c0, seed, pieceTime);
      if (uColoring == ${C_BANDS}) {
        float pieceShift = seed * 0.80;
        if (!E.escaped) {
          float interT = fract(0.35 + 0.12 * E.z.x + 0.08 * E.z.y
                              + effTime * 0.04 + pieceShift);
          col = teamPalette(interT, playerTint) * 0.90;
        } else {
          float bandFreq = max(uTrapScale, 0.5);
          float dirSign  = (seed > 0.5) ? 1.0 : -1.0;
          float modIter  = (E.smoothIter + effTime * 2.0 * dirSign + seed * 10.0) / bandFreq;
          float phase    = fract(modIter);
          float fw       = max(fwidth(modIter), 0.005);
          float band     = smoothstep(0.5 - fw, 0.5 + fw, phase);
          float bandIdx  = floor(modIter);
          float drift   = effTime * 0.013 + bandIdx * 0.20 + pieceShift;
          vec3 c1 = teamPalette(fract(drift),         playerTint);
          vec3 c2 = teamPalette(fract(drift + 0.50),  playerTint);
          col = mix(c1, c2, band);
        }
      } else if (uColoring == ${C_PICKOVER}) {
        float t = clamp(sqrt(E.trapMin) * uTrapScale, 0.0, 1.0);
        float fw = max(fwidth(t), 0.005);
        float stalk = smoothstep(0.14 - fw, 0.14 + fw, t);
        float pieceShift = seed * 0.85;
        float colorT = fract(E.smoothIter * 0.045 + effTime * 0.05 + pieceShift);
        vec3 stalkCol = teamPalette(colorT, playerTint);
        vec3 bg      = teamPalette(fract(colorT + 0.55), playerTint) * 0.20;
        col = mix(stalkCol, bg, stalk);
      } else {
        float t = clamp(E.smoothIter / uMaxIter, 0.0, 1.0);
        col = pickPalette(t);
      }
    }

    vec3 normal = vec3(sphereLocal.x, sphereLocal.y, sphereZ);
    vec3 lightDir = normalize(vec3(-0.35, 0.55, 0.85));
    vec3 viewDir  = vec3(0.0, 0.0, 1.0);
    vec3 halfVec  = normalize(lightDir + viewDir);

    float diffuse  = max(dot(normal, lightDir), 0.0);
    float specular = pow(max(dot(normal, halfVec), 0.0), 26.0);
    float rim = pow(1.0 - sphereZ, 2.5);

    vec3 teamSig = teamPalette(0.0, playerTint);

    col *= 0.30 + 0.70 * diffuse;
    col = max(col, teamSig * 0.12);

    if (capture > 0.0) {
      float pulse = 0.5 + 0.5 * sin(capture * 22.0);
      col = mix(col, vec3(1.0, 0.92, 0.75), capture * 0.7 * pulse);
    }

    col += specular * mix(teamSig, vec3(1.0), 0.75) * 0.65;

    float rimMix = rim * (0.45 + 0.65 * diffuse);
    col += rimMix * teamSig * 1.30;

    float discFw = max(fwidth(dist), 0.5);

    coreCol = col;
    coreAlpha = 1.0 - smoothstep(r - discFw, r + discFw, dist);
  }

  return vec4(coreCol, coreAlpha);
}

void main() {
  vec2 fc = vUv * uResolution;
  vec4 col;
  if (uSSAA == 1) {
    vec2 d = vec2(0.25);
    col = (shadeAt(fc + vec2(-d.x, -d.y))
         + shadeAt(fc + vec2( d.x, -d.y))
         + shadeAt(fc + vec2(-d.x,  d.y))
         + shadeAt(fc + vec2( d.x,  d.y))) * 0.25;
  } else if (uSSAA == 2) {
    col = vec4(0.0);
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        vec2 off = vec2(float(dx), float(dy)) * (1.0/3.0);
        col += shadeAt(fc + off);
      }
    }
    col /= 9.0;
  } else {
    col = shadeAt(fc);
  }
  vec3 rgb = col.rgb + (ign(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(rgb * col.a, col.a);
}
`;

  // ===========================================================================
  // FractalShell
  // ===========================================================================
  class FractalShell {
    constructor() {
      this.size = { w: 0, h: 0 };
      this.dpr = 1;
      this.glScale = 1;          // backing-store scale of the GL layer (≤ dpr; see GL_MAX_PIXELS)
      this.theme = 0;
      this.mode = null;
      this.time = 0;
      this.reducedMotion = false;
      this.lowPerf = false;      // latched by _trackFrameTime() once frame time is sustained-high
      this._frameMsAvg = null;
      this._slowFrames = 0;
      this._bakePending = true;
      this._bakeSphere = null;
      this._raf = null;
      this._startTime = null;
      this._lastTime = null;
    }

    // ---- public helpers a game can call --------------------------------------
    newGame() { if (this.game.reset) this.game.reset(this); }
    setMode(id) {
      if (this.mode === id) return;
      this.mode = id;
      this._refreshControls();
      this.newGame();
    }
    nextTheme() { this.theme = (this.theme + 1) % THEME_NAMES.length; this._refreshControls(); }
    requestBake(sphere) { this._bakePending = true; this._bakeSphere = sphere || null; }
    refreshControls() { this._refreshControls(); }

    // ---- mount ---------------------------------------------------------------
    mount(game, root) {
      this.game = game;
      this.mode = (game.modes && game.modes.length) ? game.modes[0].id : null;
      this.reducedMotion = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (window.matchMedia) {
        window.matchMedia('(prefers-reduced-motion: reduce)')
          .addEventListener('change', (e) => { this.reducedMotion = e.matches; });
      }

      this._buildDOM(root, game);
      this._initGL();
      this._wireInput();
      // Keep the stage fixed on phones: block page pan/rubber-band outside
      // form fields (high-score initials etc. still need normal touch).
      document.addEventListener('touchmove', (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('input, textarea, select, button, a, label')) return;
        e.preventDefault();
      }, { passive: false });
      window.addEventListener('resize', () => this._scheduleResize());
      // Device rotation: the viewport dimensions often report the OLD orientation
      // at the instant 'orientationchange'/'resize' fires, so a single measure
      // can size the canvas to the wrong (pre-rotation) box — the board then
      // renders squished/off, worst of all in fullscreen. Re-measure over the
      // next frames and once more after the relayout settles.
      window.addEventListener('orientationchange', () => this._reflow());
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => this._scheduleResize());
      }
      document.addEventListener('fullscreenchange', () => this._onFsChange());
      document.addEventListener('webkitfullscreenchange', () => this._onFsChange());
      this._resize();
      this.newGame();
      this._refreshControls();      // labels can now reflect live game state

      // No session identity yet (someone deep-linked into a game, or skipped
      // the hub): ask who's playing, same card as the high-score prompt. The
      // prompt opens after the first frame composites so it overlays a live
      // board. A skip is remembered for the session — never re-ask per game.
      const HS = window.HighScores;
      if (HS && HS.player && HS.setPlayer && !HS.player() && !this._nameSkipped()) {
        this._namePromptPending = true;
      }

      this._startTime = performance.now();
      this._lastTime = this._startTime;
      this._raf = requestAnimationFrame((t) => this._loop(t));
    }

    // ---- DOM -----------------------------------------------------------------
    _buildDOM(root, game) {
      root.innerHTML = '';

      // Back-to-arcade link (top-left). Same host serves the hub at "/".
      const back = document.createElement('a');
      back.className = 'arcade-back';
      back.href = '/';
      back.textContent = '‹ Arcade';
      root.appendChild(back);

      const header = document.createElement('header');
      const h1 = document.createElement('h1');
      h1.textContent = game.title || 'Fractal Game';
      header.appendChild(h1);
      if (game.subtitle) {
        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.textContent = game.subtitle;
        header.appendChild(sub);
      }
      root.appendChild(header);

      const main = document.createElement('main');
      const controls = document.createElement('div');
      controls.id = 'controls';
      this._controlsEl = controls;
      main.appendChild(controls);

      // Stage wraps the (optional) editable name bar + the canvas so they
      // share one width and stay aligned.
      const stage = document.createElement('div');
      stage.className = 'stage';
      stage.style.setProperty('--aspect', String(game.aspect || 1.6));
      if (game.stageMax != null) {
        stage.style.setProperty('--stage-max',
          typeof game.stageMax === 'number' ? game.stageMax + 'px' : String(game.stageMax));
      }
      if (game.players && game.players.length) this._buildNames(stage, game);

      const wrap = document.createElement('div');
      wrap.id = 'canvasWrap';
      this.wrap = wrap;
      for (const id of ['bgCanvas', 'glCanvas', 'uiCanvas']) {
        const c = document.createElement('canvas');
        c.id = id;
        wrap.appendChild(c);
      }

      stage.appendChild(wrap);
      main.appendChild(stage);

      if (game.hint) {
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = game.hint;
        main.appendChild(hint);
      }
      root.appendChild(main);

      this.glCanvas = wrap.querySelector('#glCanvas');
      this.uiCanvas = wrap.querySelector('#uiCanvas');
      this.bgCanvas = wrap.querySelector('#bgCanvas');
      this.ui = this.uiCanvas.getContext('2d');
      this.bg = this.bgCanvas.getContext('2d');

      // Favicon link.
      let link = document.getElementById('faviconLink');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        link.id = 'faviconLink';
        document.head.appendChild(link);
      }
      this.faviconLink = link;

      this._buildControls(game);
    }

    _buildControls(game) {
      const c = this._controlsEl;
      c.innerHTML = '';

      const newBtn = document.createElement('button');
      newBtn.textContent = 'New Game';
      newBtn.onclick = () => this.newGame();
      c.appendChild(newBtn);

      // Mode switch.
      if (game.modes && game.modes.length > 1) {
        const seg = document.createElement('div');
        seg.className = 'seg';
        seg.dataset.role = 'modes';
        for (const m of game.modes) {
          const b = document.createElement('button');
          b.textContent = m.label;
          b.dataset.mode = m.id;
          if (m.title) b.title = m.title;
          b.onclick = () => this.setMode(m.id);
          seg.appendChild(b);
        }
        c.appendChild(seg);
      }

      // Game-defined controls.
      this._dynamicButtons = [];
      if (game.controls) {
        for (const ctl of game.controls) {
          const b = document.createElement('button');
          b.onclick = () => { ctl.onClick(this); this._refreshControls(); };
          if (ctl.title) b.title = ctl.title;
          b._ctl = ctl;
          this._dynamicButtons.push(b);
          c.appendChild(b);
        }
      }

      // Theme switch.
      const themeBtn = document.createElement('button');
      themeBtn.dataset.role = 'theme';
      themeBtn.onclick = () => this.nextTheme();
      this._themeBtn = themeBtn;
      c.appendChild(themeBtn);

      // Fullscreen — in the control bar (not over the board). Canvas-wrap FS
      // on web; iOS Safari falls back to a CSS cover on the play area.
      const fsBtn = document.createElement('button');
      fsBtn.type = 'button';
      fsBtn.className = 'fs-btn';
      fsBtn.textContent = '⛶';
      fsBtn.title = 'Fullscreen';
      fsBtn.setAttribute('aria-label', 'Toggle fullscreen');
      fsBtn.addEventListener('click', (e) => { e.preventDefault(); this._toggleFullscreen(); });
      c.appendChild(fsBtn);
      this._fsBtn = fsBtn;

      this._refreshControls();
    }

    _refreshControls() {
      if (this._dynamicButtons) {
        for (const b of this._dynamicButtons) {
          const ctl = b._ctl;
          const lbl = ctl.label;
          b.textContent = (typeof lbl === 'function') ? lbl(this) : lbl;
          if (ctl.active) b.classList.toggle('active', !!ctl.active(this));
          else b.classList.remove('active');
        }
      }
      if (this._themeBtn) this._themeBtn.textContent = 'Theme: ' + THEME_NAMES[this.theme];
      const seg = this._controlsEl.querySelector('[data-role="modes"]');
      if (seg) {
        for (const b of seg.children) {
          b.classList.toggle('active', b.dataset.mode === this.mode);
        }
      }
      this._applyNameColors();
    }

    // ---- editable player names ----------------------------------------------
    // A player's defaultName may be a static string or (shell) => string, so a
    // game can label a seat by mode — e.g. the second seat is 'Computer' in 1P
    // and 'Player 2' in 2P. Defaults render as PLACEHOLDERS (the value stays
    // whatever a human typed), and playerName() falls back to the CURRENT
    // default, so switching modes relabels any seat nobody has typed over.
    _playerDefault(i) {
      const p = (this.game.players || [])[i];
      const d = p && p.defaultName;
      const v = (typeof d === 'function') ? d(this) : d;
      return v || ('Player ' + (i + 1));
    }

    _buildNames(stage, game) {
      this.playerNames = game.players.map(() => '');
      // Carry the arcade-wide identity into the first (human) player slot, so the
      // name you picked at the arcade lasts across every game. Per-game edits stay
      // local; the shared name is only changed from the hub or the name prompt.
      const arcadeName = (window.HighScores && window.HighScores.player) ? window.HighScores.player() : '';
      if (arcadeName) this.playerNames[0] = arcadeName;
      const bar = document.createElement('div');
      bar.id = 'playerNames';
      if (game.nameStyle === 'underline') bar.classList.add('name-underline');
      this._nameInputs = [];
      const n = game.players.length;
      game.players.forEach((p, i) => {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = this.playerNames[i];
        inp.placeholder = this._playerDefault(i);
        inp.maxLength = p.maxLength || 16;
        inp.spellcheck = false;
        inp.autocomplete = 'off';
        inp.setAttribute('aria-label', this._playerDefault(i) + ' name');
        if (n === 2 && i === 1) inp.classList.add('right');   // right-align the 2nd of two
        inp.addEventListener('input', () => { this.playerNames[i] = inp.value; });
        this._nameInputs.push(inp);
        bar.appendChild(inp);
      });
      stage.appendChild(bar);
      this._applyNameColors();
    }

    _applyNameColors() {
      if (!this._nameInputs) return;
      const players = this.game.players || [];
      this._nameInputs.forEach((inp, i) => {
        const c = players[i] && players[i].color;
        const col = (typeof c === 'function') ? c(this) : (c || '#e8e8f0');
        inp.style.color = col;
        inp.style.borderColor = (/^#[0-9a-f]{6}$/i.test(col)) ? col + '66' : col;
        // Defaults can be mode-dependent — keep placeholder/label current.
        inp.placeholder = this._playerDefault(i);
        inp.setAttribute('aria-label', this._playerDefault(i) + ' name');
      });
    }

    // Current display name for player i (falls back to the default if blank).
    playerName(i) {
      if (!this.playerNames) return 'Player ' + (i + 1);
      const n = (this.playerNames[i] || '').trim();
      return n || this._playerDefault(i);
    }

    // ---- WebGL ---------------------------------------------------------------
    _compile(src, type) {
      const gl = this.gl;
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('Shader:', gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    }

    _initGL() {
      const gl = this.glCanvas.getContext('webgl', {
        alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true,
      });
      this.gl = gl;
      if (!gl) { console.error('WebGL not available.'); return; }
      gl.getExtension('OES_standard_derivatives');
      const vs = this._compile(VERT_SRC, gl.VERTEX_SHADER);
      const fs = this._compile(FRAG_SRC, gl.FRAGMENT_SHADER);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error('Link:', gl.getProgramInfoLog(prog)); return;
      }
      this.glProgram = prog;
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1,
      ]), gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      this._aPos = aPos;
      this._attribBuffer = buf;

      const U = {};
      for (const name of [
        'uResolution', 'uTime', 'uPieceCount', 'uPiecesA', 'uPiecesB', 'uPieceFrozen', 'uPieceSeedId',
        'uFractalType', 'uColoring', 'uPalette', 'uMaxIter',
        'uJuliaC', 'uZoomCenter', 'uZoomScale',
        'uTrapShape', 'uTrapPos', 'uTrapScale', 'uTrapRadius',
        'uRelax', 'uSSAA', 'uViewScale', 'uTheme',
      ]) U[name] = gl.getUniformLocation(prog, name);
      this.U = U;

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    _setPreset(preset) {
      const gl = this.gl, U = this.U, p = preset.p;
      gl.uniform1i(U.uFractalType, preset.fractal);
      gl.uniform1i(U.uColoring, preset.coloring);
      gl.uniform1i(U.uPalette, preset.palette);
      gl.uniform1f(U.uMaxIter, p.maxIter ?? 160);
      gl.uniform2f(U.uJuliaC, p.jCx ?? 0, p.jCy ?? 0);
      gl.uniform2f(U.uZoomCenter, p.zoomCx ?? 0, p.zoomCy ?? 0);
      gl.uniform1f(U.uZoomScale, p.zoomScale ?? 1.5);
      gl.uniform1i(U.uTrapShape, p.trapShape ?? 0);
      gl.uniform2f(U.uTrapPos, p.trapPx ?? 0, p.trapPy ?? 0);
      gl.uniform1f(U.uTrapScale, p.trapScale ?? 1.0);
      gl.uniform1f(U.uTrapRadius, p.trapRadius ?? 0.5);
      gl.uniform1f(U.uRelax, p.relax ?? 1.0);
      gl.uniform1f(U.uViewScale, p.viewScale ?? 1.0);
    }

    // spheres in CSS px; this handles DPR scaling and the GL y-flip.
    _uploadSpheres(spheres) {
      const gl = this.gl, U = this.U;
      const A = new Float32Array(MAX_PIECES * 4);
      const B = new Float32Array(MAX_PIECES * 4);
      const F = new Float32Array(MAX_PIECES);
      const S = new Float32Array(MAX_PIECES);
      const n = Math.min(spheres.length, MAX_PIECES);
      const scale = this.glScale, H = this.size.h;   // GL layer's own backing scale, not dpr
      for (let i = 0; i < n; i++) {
        const s = spheres[i];
        A[i * 4 + 0] = s.x * scale;
        A[i * 4 + 1] = (H - s.y) * scale;     // GL origin bottom-left
        A[i * 4 + 2] = s.r * scale;
        A[i * 4 + 3] = 0.0;
        // tint 0 -> first palette half (Fire/Acid), 1 -> second (Ice/Violet)
        B[i * 4 + 0] = (s.tint ? -1.0 : 1.0);
        B[i * 4 + 1] = s.hover ? 1.0 : 0.0;
        B[i * 4 + 2] = s.zoom || 1.0;
        B[i * 4 + 3] = s.capture || 0.0;
        S[i] = (s.seed !== null && s.seed !== undefined) ? s.seed : i;
        F[i] = (s.frozen || this.reducedMotion) ? 1.0 : 0.0;
      }
      gl.uniform1i(U.uPieceCount, n);
      gl.uniform4fv(U.uPiecesA, A);
      gl.uniform4fv(U.uPiecesB, B);
      gl.uniform1fv(U.uPieceFrozen, F);
      gl.uniform1fv(U.uPieceSeedId, S);
    }

    _renderGL(spheres, time) {
      const gl = this.gl, U = this.U;
      if (!gl || !this.glProgram) return;
      gl.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.glProgram);
      gl.uniform2f(U.uResolution, this.glCanvas.width, this.glCanvas.height);
      gl.uniform1f(U.uTime, time);
      // SSAA quadruples the per-pixel shader cost — skip it when the machine
      // is sustained-slow, or when the layer is already CSS-upscaled (the
      // upscale blur swallows any sub-pixel AA anyway).
      gl.uniform1i(U.uSSAA, (this.lowPerf || this.glScale < this.dpr) ? 0 : FORCED_SSAA);
      gl.uniform1i(U.uTheme, this.theme);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._attribBuffer);
      gl.enableVertexAttribArray(this._aPos);
      gl.vertexAttribPointer(this._aPos, 2, gl.FLOAT, false, 0, 0);

      // Group spheres by look so each fractal preset is set once.
      const groups = {};
      for (const s of spheres) {
        const look = (s.look && PRESETS[s.look]) ? s.look : 'stalks';
        (groups[look] || (groups[look] = [])).push(s);
      }
      for (const look in groups) {
        this._setPreset(PRESETS[look]);
        this._uploadSpheres(groups[look]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    // Coalesce burst resize events (mobile URL bar, visualViewport) to one
    // measure per frame — redundant canvas dimension writes read as jumpy.
    _scheduleResize() {
      if (this._resizeRaf) return;
      this._resizeRaf = requestAnimationFrame(() => {
        this._resizeRaf = 0;
        this._resize();
      });
    }

    // ---- resize --------------------------------------------------------------
    _resize() {
      // In fullscreen the wrap IS the whole screen, but during the fullscreen
      // transition (and right after a rotation into landscape) the wrap's
      // getBoundingClientRect() frequently still reports the PRE-fullscreen box.
      // Sizing the canvas to that stale, small rect while CSS stretches it to
      // fill the screen is exactly what reads as "too zoomed in" in landscape
      // fullscreen. When fullscreen, measure the real visible viewport instead
      // so the court is drawn at the size it's actually displayed at.
      let w, h;
      if (this._isFullscreen()) {
        const vv = window.visualViewport;
        w = Math.round(window.innerWidth || (vv && vv.width) || 0);
        h = Math.round(window.innerHeight || (vv && vv.height) || 0);
      }
      if (!w || !h) {
        const rect = this.wrap.getBoundingClientRect();
        w = rect.width; h = rect.height;
      }
      const rect = { width: w, height: h };
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      // GL layer renders at a capped internal resolution and CSS-scales up —
      // but only when MEANINGFULLY over budget (see GL_BUDGET_TOLERANCE), so
      // boards near 1:1 keep the compositor on the cheap no-resample path.
      // Once lowPerf latches, the budget halves and the 2D layers join the
      // capped scale: backing pixels are the biggest lever on a machine that
      // is demonstrably struggling, and soft text beats a slideshow.
      const cssPx = Math.max(1, rect.width * rect.height);
      const budget = this.lowPerf ? GL_MAX_PIXELS * 0.55 : GL_MAX_PIXELS;
      const glScale = (cssPx * dpr * dpr <= budget * GL_BUDGET_TOLERANCE)
        ? dpr
        : Math.min(dpr, Math.sqrt(budget / cssPx));
      const uiScale = this.lowPerf ? glScale : dpr;
      const wR = Math.round(rect.width);
      const hR = Math.round(rect.height);
      const sig = wR + '|' + hR + '|' + glScale + '|' + uiScale;
      if (this._resizeSig === sig) return;
      this._resizeSig = sig;
      this.size.w = rect.width;
      this.size.h = rect.height;
      this.dpr = dpr;
      this.glScale = glScale;
      for (const c of [this.glCanvas, this.uiCanvas, this.bgCanvas]) {
        const s = (c === this.glCanvas) ? glScale : uiScale;
        c.width = Math.round(rect.width * s);
        c.height = Math.round(rect.height * s);
        c.style.width = rect.width + 'px';
        c.style.height = rect.height + 'px';
      }
      this.ui.setTransform(uiScale, 0, 0, uiScale, 0, 0);
      this.bg.setTransform(uiScale, 0, 0, uiScale, 0, 0);
      if (this.game.resize) this.game.resize(this, rect.width, rect.height);
    }

    // Re-measure across the next frames and after the rotation relayout settles,
    // so a stale (pre-rotation) viewport size can't stick.
    _reflow() {
      this._resize();
      requestAnimationFrame(() => this._resize());
      setTimeout(() => this._resize(), 300);
    }

    // ---- fullscreen ----------------------------------------------------------
    _fsElement() {
      return document.fullscreenElement || document.webkitFullscreenElement || null;
    }
    _isFullscreen() {
      return this._fsElement() === this.wrap || this.wrap.classList.contains('pseudo-fs');
    }
    _toggleFullscreen() {
      const el = this.wrap;
      if (this._isFullscreen()) {
        if (el.classList.contains('pseudo-fs')) { el.classList.remove('pseudo-fs'); this._onFsChange(); }
        else if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        return;
      }
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) {
        // Some browsers reject (e.g. iframe perms) — fall back to the CSS cover.
        Promise.resolve(req.call(el)).catch(() => { el.classList.add('pseudo-fs'); this._onFsChange(); });
      } else {
        el.classList.add('pseudo-fs'); this._onFsChange();      // iOS Safari path
      }
    }
    _onFsChange() {
      const on = this._isFullscreen();
      if (this._fsBtn) {
        this._fsBtn.textContent = on ? '⤡' : '⛶';
        this._fsBtn.title = on ? 'Exit fullscreen' : 'Fullscreen';
      }
      // Layout has changed. On mobile the new (fullscreen) viewport size can
      // land a few frames late, so re-measure now, next frame, and once more
      // after the transition settles — otherwise a stale size sticks and the
      // court renders zoomed.
      this._reflow();
    }

    // ---- high scores ---------------------------------------------------------
    // A game calls this once when a round ends with a numeric score. If it earns
    // a spot on the top-ten board (HighScores), prompt for initials and persist.
    // gameId defaults to game.id; order defaults to game.scoreOrder or 'desc'.
    recordScore(score, opts) {
      opts = opts || {};
      const HS = window.HighScores;
      if (!HS || this._hsOpen) return;
      const gameId = opts.gameId || (this.game && this.game.id);
      const order = opts.order || (this.game && this.game.scoreOrder) || 'desc';
      if (!gameId || typeof score !== 'number' || !isFinite(score)) return;
      if (!HS.qualifies(HS.load(gameId), score, order)) return;
      this._promptInitials(gameId, score, order, opts.label);
    }

    // A win-based game (tic-tac-toe, Connect 4) calls this once per win. It adds
    // a win to that player's running tally on the shared board — no prompt, the
    // player's name is already known. No-ops if HighScores isn't loaded.
    reportWin(info) {
      info = info || {};
      const HS = window.HighScores;
      if (!HS || !HS.bump) return;
      const gameId = info.game || (this.game && this.game.id);
      const name = info.player || (this.playerName ? this.playerName(0) : '');
      if (!gameId || !name) return;
      HS.bump(gameId, name, 1, { order: 'desc', maxLen: 12 });
    }

    // ---- "who's playing?" (per browser session) ------------------------------
    _nameSkipped() {
      try { return sessionStorage.getItem('arcade.player.skip') === '1'; } catch (e) { return false; }
    }
    _markNameSkipped() {
      try { sessionStorage.setItem('arcade.player.skip', '1'); } catch (e) {}
    }

    _promptName() {
      const HS = window.HighScores;
      if (this._nameOpen || this._hsOpen) return;
      this._nameOpen = true;

      const ov = document.createElement('div');
      ov.className = 'hs-overlay';
      // Swallow taps so the game's canvas doesn't serve/reset underneath us.
      ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click'].forEach(
        (ev) => ov.addEventListener(ev, (e) => e.stopPropagation()));

      const card = document.createElement('div');
      card.className = 'hs-card';

      const title = document.createElement('div');
      title.className = 'hs-title';
      title.textContent = "WHO'S PLAYING?";

      const form = document.createElement('form');
      form.className = 'hs-form';
      const inp = document.createElement('input');
      inp.className = 'hs-initials hs-name';
      inp.maxLength = 12;
      inp.placeholder = 'YOUR NAME';
      inp.value = (HS.lastPlayer ? HS.lastPlayer() : '');   // last visit's answer, editable
      inp.autocomplete = 'off'; inp.spellcheck = false;
      inp.setAttribute('aria-label', 'Your name');
      inp.addEventListener('input', () => {
        inp.value = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
      });
      const save = document.createElement('button');
      save.type = 'submit'; save.className = 'hs-save'; save.textContent = 'PLAY';
      form.appendChild(inp); form.appendChild(save);

      const skip = document.createElement('button');
      skip.type = 'button'; skip.className = 'hs-skip'; skip.textContent = 'skip';

      const close = (commit) => {
        if (!this._nameOpen) return;
        if (commit && inp.value) {
          const nm = HS.setPlayer(inp.value);
          if (this.playerNames) this.playerNames[0] = nm;
          if (this._nameInputs && this._nameInputs[0]) this._nameInputs[0].value = nm;
        } else {
          this._markNameSkipped();
        }
        this._nameOpen = false;
        ov.remove();
      };
      form.addEventListener('submit', (e) => { e.preventDefault(); close(true); });
      skip.addEventListener('click', () => close(false));

      card.appendChild(title); card.appendChild(form); card.appendChild(skip);
      ov.appendChild(card);
      this.wrap.appendChild(ov);
      setTimeout(() => { try { inp.focus(); inp.select(); } catch (e) {} }, 0);
    }

    _promptInitials(gameId, score, order, label) {
      const HS = window.HighScores;
      this._hsOpen = true;

      const ov = document.createElement('div');
      ov.className = 'hs-overlay';
      // Swallow taps so the game's canvas doesn't rematch/reset underneath us.
      ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click'].forEach(
        (ev) => ov.addEventListener(ev, (e) => e.stopPropagation()));

      const card = document.createElement('div');
      card.className = 'hs-card';

      const title = document.createElement('div');
      title.className = 'hs-title';
      title.textContent = 'NEW HIGH SCORE';

      const sc = document.createElement('div');
      sc.className = 'hs-score';
      sc.textContent = (label ? label + ' ' : '') + score;

      const form = document.createElement('form');
      form.className = 'hs-form';
      const inp = document.createElement('input');
      inp.className = 'hs-initials';
      // Prefill with the current player: prefer the name typed above the board
      // THIS game (kids swap chairs mid-session), then the session identity.
      // Still editable; with no name at all, fall back to 3-char initials.
      let pre = this.playerNames ? (this.playerNames[0] || '').trim() : '';
      pre = (pre || (HS.player ? HS.player() : '') || '')
        .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
      const maxLen = pre ? 12 : 3;
      if (pre) inp.classList.add('hs-name');
      inp.maxLength = maxLen; inp.placeholder = pre || 'AAA';
      inp.value = pre;
      inp.autocomplete = 'off'; inp.spellcheck = false;
      inp.setAttribute('aria-label', pre ? 'Your name' : 'Enter your initials');
      inp.addEventListener('input', () => {
        inp.value = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, maxLen);
      });
      const save = document.createElement('button');
      save.type = 'submit'; save.className = 'hs-save'; save.textContent = 'SAVE';
      form.appendChild(inp); form.appendChild(save);

      const skip = document.createElement('button');
      skip.type = 'button'; skip.className = 'hs-skip'; skip.textContent = 'skip';

      const close = (commit) => {
        if (this._hsOpen === false) return;
        if (commit) HS.submit(gameId, inp.value || pre || 'AAA', score, { order, maxLen });
        this._hsOpen = false;
        ov.remove();
      };
      form.addEventListener('submit', (e) => { e.preventDefault(); close(true); });
      skip.addEventListener('click', () => close(false));

      card.appendChild(title); card.appendChild(sc);
      card.appendChild(form); card.appendChild(skip);
      ov.appendChild(card);
      this.wrap.appendChild(ov);
      setTimeout(() => { try { inp.focus(); inp.select(); } catch (e) {} }, 0);
    }

    // ---- input ---------------------------------------------------------------
    _pointerPos(e) {
      const rect = this.wrap.getBoundingClientRect();
      const t = (e.touches && e.touches[0]) || e;
      return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    }
    _wireInput() {
      const g = this.game;
      const move = (e) => { if (g.onPointerMove) { const p = this._pointerPos(e); g.onPointerMove(this, p.x, p.y); } };
      const down = (e) => { if (g.onPointerDown) { const p = this._pointerPos(e); g.onPointerDown(this, p.x, p.y); } };
      const up = (e) => { if (g.onPointerUp) { const p = this._pointerPos(e); g.onPointerUp(this, p.x, p.y); } };
      this.uiCanvas.addEventListener('pointermove', move);
      // Touch is handled by touchstart below; skipping pointerdown for touch avoids
      // a duplicate down() on the same tap (which could rematch before END_LOCK).
      this.uiCanvas.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') return; down(e); });
      this.uiCanvas.addEventListener('pointerup', up);
      this.uiCanvas.addEventListener('pointercancel', up);
      this.uiCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); down(e); }, { passive: false });
      this.uiCanvas.addEventListener('touchmove', (e) => { e.preventDefault(); move(e); }, { passive: false });
      this.uiCanvas.addEventListener('touchend', up);
      this.uiCanvas.addEventListener('touchcancel', up);
      // Key PRESSES never reach the game while typing OR while a shell dialog
      // is up — otherwise Space during the high-score prompt serves/resets the
      // frozen game underneath it. Key RELEASES always pass: they only clear
      // held-key flags, and swallowing one leaves a paddle drifting forever.
      window.addEventListener('keydown', (e) => {
        if (this._isTyping(e) || this._hsOpen || this._nameOpen) return;
        if (g.onKeyDown) g.onKeyDown(this, e);
      });
      window.addEventListener('keyup', (e) => { if (g.onKeyUp) g.onKeyUp(this, e); });
    }
    _isTyping(e) {
      const t = e.target;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    }

    // ---- loop ----------------------------------------------------------------
    // Rolling average of real (unclamped) frame time. Games that draw a lot of
    // per-frame Canvas2D work (large/many gradients, shadowBlur) can check
    // `shell.lowPerf` and shed the expensive extras once the machine is
    // sustained-slow (e.g. software-only canvas compositing on a kiosk with
    // no GPU) instead of staying choppy indefinitely.
    //
    // lowPerf LATCHES for the rest of the page load. It used to recover after
    // a run of fast frames — but shedding is exactly what MAKES the frames
    // fast, so recovery re-armed the expensive path and the shell oscillated
    // smooth/molasses every few seconds. Degraded-but-steady wins on a kiosk;
    // a page reload (every game entry is a fresh page) re-arms full quality.
    _trackFrameTime(ms) {
      if (this.lowPerf) return;                              // latched
      this._frameMsAvg = this._frameMsAvg == null ? ms : (this._frameMsAvg * 0.92 + ms * 0.08);
      if (this._frameMsAvg > 42) {                           // sustained < ~24fps
        this._slowFrames = (this._slowFrames || 0) + 1;
        if (this._slowFrames > 45) {                         // ~2s of grind, not one hitch
          this.lowPerf = true;
          this._resize();     // re-apply canvas scales: halved GL budget, 2D layers join it
        }
      } else {
        this._slowFrames = 0;
      }
    }

    _loop(now) {
      const rawMs = now - this._lastTime;
      this._lastTime = now;
      // While a shell dialog (high-score entry / name prompt) is up, freeze
      // the scene on its last composited frame instead of re-rendering the
      // full fractal layer behind it every frame. On slow machines that
      // rendering starved the input pipeline — you typed and waited for the
      // character to appear. The canvases keep their contents (the GL context
      // uses preserveDrawingBuffer and the 2D layers just aren't cleared).
      if (this._hsOpen || this._nameOpen) {
        this._raf = requestAnimationFrame((t) => this._loop(t));
        return;
      }
      // Feed the perf tracker every REAL frame, including the very slow ones.
      // (The first cut only sampled frames under 50ms "to exclude tab-switch
      // gaps" — which meant a machine grinding at <20fps NEVER tripped lowPerf
      // and the adaptive shedding was dead exactly when it was needed. Only
      // genuine rAF gaps (>1s: hidden tab, app switch) are excluded now, and
      // samples are capped so one hitch can't poison the average.)
      if (rawMs < 1000) this._trackFrameTime(Math.min(rawMs, 250));
      let dt = rawMs / 1000;
      if (dt > 0.05) dt = 0.05;           // clamp big gaps for game logic
      this.time = (now - this._startTime) / 1000;
      const w = this.size.w, h = this.size.h;
      const g = this.game;

      if (g.update) g.update(this, dt);

      // bg layer
      this.bg.clearRect(0, 0, w, h);
      if (g.drawBackground) g.drawBackground(this, this.bg, w, h);

      // gl layer (fractal spheres)
      if (g.spheres) this._renderGL(g.spheres(this) || [], this.time);

      // ui layer
      this.ui.clearRect(0, 0, w, h);
      if (g.drawForeground) g.drawForeground(this, this.ui, w, h);

      // deferred name prompt — first frame has now composited behind it
      if (this._namePromptPending) {
        this._namePromptPending = false;
        this._promptName();
      }

      // favicon bake — after first frames composited
      if (this._bakePending && this.time > 1.2) {
        this._bakePending = false;
        this._bakeFavicon(this._bakeSphere);
      }

      this._raf = requestAnimationFrame((t) => this._loop(t));
    }

    _bakeFavicon(sphere) {
      try {
        sphere = sphere || (this.game.spheres && (this.game.spheres(this) || [])[0]);
        if (!sphere) return;
        const scale = this.glScale;                 // glCanvas backing scale (≤ dpr)
        const sx = (sphere.x - sphere.r) * scale;
        const sy = (sphere.y - sphere.r) * scale;   // no y-flip: reads composited DOM image
        const sw = sphere.r * 2 * scale;
        const size = 64;
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const cx = c.getContext('2d');
        cx.save();
        cx.beginPath(); cx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2); cx.clip();
        cx.drawImage(this.glCanvas, sx, sy, sw, sw, 0, 0, size, size);
        cx.restore();
        cx.lineWidth = 2;
        cx.strokeStyle = sphere.tint ? '#2cb1ff' : '#ff7a2c';
        cx.beginPath(); cx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2); cx.stroke();
        this.faviconLink.href = c.toDataURL('image/png');
      } catch (e) { /* bake is cosmetic; ignore failures */ }
    }
  }

  // Expose engine + constants for games.
  window.FractalShell = FractalShell;
  window.FractalShell.PRESETS = PRESETS;
  window.FractalShell.THEME_NAMES = THEME_NAMES;
})();
