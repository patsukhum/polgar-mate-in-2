import { build } from 'esbuild';
import fs from 'node:fs';
const cg = 'node_modules/@lichess-org/chessground/assets/';
const css = ['chessground.base.css', 'chessground.brown.css', 'chessground.cburnett.css']
  .map((f) => fs.readFileSync(cg + f, 'utf8')).join('\n');
const js = (await build({ entryPoints: ['src/main.js'], bundle: true, minify: true, format: 'iife', write: false, target: 'es2019' })).outputFiles[0].text;
let html = fs.readFileSync('src/index.html', 'utf8');
html = html.replace('/*CG_CSS*/', () => css).replace('/*APP_JS*/', () => js.replace(/<\/script/gi, '<\\/script'));
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/index.html', html);
for (const f of ['sw.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png']) if (fs.existsSync('src/' + f)) fs.copyFileSync('src/' + f, 'docs/' + f);
console.log('docs/index.html', (html.length / 1024).toFixed(0) + ' KB');
