/* ============================================================================
   Game template for the Fractal Shell.
   ----------------------------------------------------------------------------
   Copy this to games/<slug>.js, fill in the mechanics, then:
     1) create <slug>.html (copy pong's boot HTML; point the 2nd <script> at
        games/<slug>.js and mount window.<Name>Game),
     2) `node build.js <slug>`  -> <slug>.html bundle,
     3) add an entry to games.json so it shows in the arcade.

   The shell owns: the 3-layer canvas stack, the WebGL fractal-sphere renderer,
   theme switching, 1P/2P mode scaffolding, DPR/resize, reduced-motion, the
   loop, input plumbing, editable player names, and the favicon bake.
   A game only implements mechanics. Coordinates are CSS pixels; (0,0) is the
   top-left of the play area — the shell handles DPR + the WebGL y-flip.
   See README.md for the full interface.
   ========================================================================== */
(function () {
  'use strict';

  const TemplateGame = {
    id: 'template',
    title: 'New Game',
    subtitle: 'One-line description',
    aspect: 1.6,                         // play-area width / height
    hint: 'Controls hint shown under the board',

    modes: [
      { id: '1p', label: '1 Player' },
      { id: '2p', label: '2 Players' },
    ],

    // Editable, team-colored name fields above the board (optional).
    // defaultName may be a string or (shell) => string; defaults render as
    // placeholders. Seat 0 is the human — the arcade identity fills it.
    // Any non-human seat must default to 'Computer' (never 'Left'/'Right').
    players: [
      { defaultName: 'Player 1', color: '#ff7a2c' },
      { defaultName: (shell) => (shell.mode === '1p' ? 'Computer' : 'Player 2'), color: '#2cb1ff' },
    ],

    // Extra control-bar buttons (optional). `label` may be a (shell)=>string.
    controls: [],

    state: null,

    // ---- lifecycle ----
    reset(shell) { this.state = { /* build initial state from shell.size */ }; },
    resize(shell, w, h) { /* recompute geometry in CSS px */ },
    update(shell, dt) { /* advance mechanics; dt seconds (<= 0.05) */ },

    // 2D layers. bg = below the spheres (court/board); fg = above (pieces/HUD).
    drawBackground(shell, ctx, w, h) { ctx.fillStyle = '#04040a'; ctx.fillRect(0, 0, w, h); },
    drawForeground(shell, ctx, w, h) { /* paddles, score, overlays */ },

    // The fractal spheres to render this frame. look: 'stalks' (Julia),
    // 'bands' (Mandelbrot), 'nova' (Newton). tint: 0 -> theme color A, 1 -> B.
    spheres(shell) {
      return [/* { x, y, r, tint, look, seed, zoom, capture, frozen } */];
    },

    // ---- input (CSS px) ----
    onPointerMove(shell, x, y) {},
    onPointerDown(shell, x, y) {},
    onKeyDown(shell, e) {},
    onKeyUp(shell, e) {},
  };

  window.TemplateGame = TemplateGame;
})();
