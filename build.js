/* Build a shell-based game into a single self-contained <slug>.html at the
   repo root (engine CSS/JS + game JS inlined). Checkers is NOT built this way
   — it's already a standalone file.

   Usage:  node build.js [slug]        (default slug: pong) */
const fs = require('fs');
const path = require('path');

// Registry of shell-based games: slug -> { title, global }.
const GAMES = {
  pong: { title: 'Radioactive Pong', global: 'PongGame' },
  serpent: { title: 'Serpent Bloom', global: 'SerpentGame' },
  tictactoe: { title: 'Clauck Tac Toe', global: 'TicTacToeGame' },
  'grok-tictactoe': { title: 'Grok Tac Toe', global: 'GrokTicTacToeGame' },
  connect4: { title: 'Connect 4', global: 'Connect4Game' },
};

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const slug = process.argv[2] || 'pong';

// `node build.js hub` — the hub (index.html) is hand-authored and served as-is
// (engine/ is NOT deployed alongside it), so the shared high-score store
// must be INLINED into it. This regenerates the inline block from the canonical
// engine/highscores.js between the <!-- highscores:begin/end --> markers.
if (slug === 'hub') {
  const hs = read('engine/highscores.js');
  const re = /<!-- highscores:begin[\s\S]*?highscores:end -->/;
  const block = '<!-- highscores:begin — inlined from engine/highscores.js by '
    + '`node build.js hub`; edit the source there, not here -->\n<script>\n'
    + hs + '</script>\n<!-- highscores:end -->';
  // Both hand-authored pages (the hub + the dedicated /scores page) inline the
  // shared store, since engine/ is not deployed.
  for (const name of ['index.html', 'scores.html']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, 'utf8');
    if (!re.test(html)) { console.error('hub: markers not found in ' + name); process.exit(1); }
    fs.writeFileSync(file, html.replace(re, block));
    console.log('Rebuilt ' + name + ' high-score inline block (' + hs.length + ' bytes).');
  }
  process.exit(0);
}

const g = GAMES[slug];
if (!g) { console.error(`Unknown game '${slug}'. Known: ${Object.keys(GAMES).join(', ')}`); process.exit(1); }

const css = read('engine/fractal-shell.css');
const highScoresJs = read('engine/highscores.js');
const shellJs = read('engine/fractal-shell.js');
const gameJs = read(`games/${slug}.js`);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<title>${g.title}</title>
<link rel="icon" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" />
<link rel="apple-touch-icon" href="https://motisorkin.com/apple-touch-icon.png" />
<meta property="og:site_name" content="Moti Sorkin" />
<meta property="og:title" content="${g.title} — Moti Sorkin" />
<style>
${css}
</style>
</head>
<body>
<div id="app"></div>
<script>
${highScoresJs}
</script>
<script>
${shellJs}
</script>
<script>
${gameJs}
</script>
<script>
  window.addEventListener('DOMContentLoaded', function () {
    new FractalShell().mount(window.${g.global}, document.getElementById('app'));
  });
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(root, `${slug}.html`), html);
console.log(`Built ${slug}.html (${html.length} bytes) — title "${g.title}"`);
