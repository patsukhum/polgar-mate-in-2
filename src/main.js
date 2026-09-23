import { Chess } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import PUZZLES from './puzzles.js';
import { createSync } from './sync.js';

const STORE_KEY = 'polgar-m2-v1';
const $ = (s) => document.querySelector(s);

// ---------- persistence ----------
function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}
const saved = load();
// entries: n -> { s: 'clean' | 'solved' | 'revealed', t: timestamp } (timestamps drive sync merges)
let entries = saved.entries || {};
let resetAt = saved.resetAt || 0;
if (saved.progress && !saved.entries) {
  for (const [n, s] of Object.entries(saved.progress)) entries[n] = { s, t: 1 };
}
const progress = {}; // n -> status, derived from entries
function rebuildProgress() {
  for (const k of Object.keys(progress)) delete progress[k];
  for (const [n, e] of Object.entries(entries)) progress[n] = e.s;
}
rebuildProgress();
function setStatus(n, s) {
  entries[n] = { s, t: Date.now() };
  progress[n] = s;
}
let mode = saved.mode || 'order';
let idx = Math.max(0, PUZZLES.findIndex((p) => p.n === saved.current));
function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ entries, resetAt, mode, current: PUZZLES[idx].n }));
  } catch {}
}

// ---------- chess helpers ----------
function dests(chess) {
  const m = new Map();
  for (const mv of chess.moves({ verbose: true })) {
    if (!m.has(mv.from)) m.set(mv.from, []);
    m.get(mv.from).push(mv.to);
  }
  return m;
}
function hasMateInOne(chess) {
  for (const mv of chess.moves({ verbose: true })) {
    chess.move(mv);
    const mate = chess.isCheckmate();
    chess.undo();
    if (mate) return true;
  }
  return false;
}
function mateCount(chess) {
  let c = 0;
  for (const mv of chess.moves({ verbose: true })) {
    chess.move(mv);
    if (chess.isCheckmate()) c++;
    chess.undo();
  }
  return c;
}
// Black's reply: follow the book's main line when the user did, otherwise
// pick the stubbornest defense (fewest mating replies for White).
function chooseDefense(chess, userUci, p) {
  const replies = chess.moves({ verbose: true });
  if (userUci === p.line[0] && p.line[1]) {
    const r = replies.find((m) => uci(m) === p.line[1]);
    if (r) return r;
  }
  let best = null;
  let bestCount = Infinity;
  for (const r of replies) {
    chess.move(r);
    const c = mateCount(chess);
    chess.undo();
    if (c < bestCount) {
      best = r;
      bestCount = c;
    }
  }
  return best;
}
// For a wrong first move: a black reply after which White has no mate.
function findRefutation(chess) {
  const replies = chess.moves({ verbose: true });
  for (const r of replies) {
    chess.move(r);
    const ok = hasMateInOne(chess);
    chess.undo();
    if (!ok) return r;
  }
  return null;
}
const uci = (m) => m.from + m.to + (m.promotion || '');
const sq = (u) => [u.slice(0, 2), u.slice(2, 4)];

// ---------- state ----------
let chess;
let cg;
let phase; // 'first' | 'second' | 'done' | 'busy'
let mistakes = 0;
let hinted = false;
let replay = null; // { fens: [], moves: [], i }
let gen = 0; // bumps on each load so stale timers from a previous puzzle are ignored
const later = (fn, ms) => {
  const g = gen;
  setTimeout(() => g === gen && phase === 'busy' && fn(), ms);
};

const boardEl = $('#board');
cg = Chessground(boardEl, {
  orientation: 'white',
  animation: { enabled: true, duration: 220 },
  highlight: { lastMove: true, check: true },
  movable: { free: false, color: 'white', showDests: true, events: { after: onUserMove } },
  premovable: { enabled: false },
  draggable: { showGhost: true },
});

function syncBoard(extra = {}) {
  const turn = chess.turn() === 'w' ? 'white' : 'black';
  cg.set({
    fen: chess.fen(),
    turnColor: turn,
    check: chess.inCheck() ? turn : false,
    movable: {
      color: phase === 'first' || phase === 'second' ? 'white' : undefined,
      dests: phase === 'first' || phase === 'second' ? dests(chess) : new Map(),
    },
    ...extra,
  });
}

function loadPuzzle(i) {
  gen++;
  idx = (i + PUZZLES.length) % PUZZLES.length;
  const p = PUZZLES[idx];
  chess = new Chess(p.fen);
  phase = 'first';
  mistakes = 0;
  hinted = false;
  replay = null;
  cg.setAutoShapes([]);
  cg.setShapes([]);
  syncBoard({ lastMove: undefined });
  $('#pnum').textContent = '#' + p.n;
  $('#jump').value = p.n;
  const st = progress[p.n];
  $('#pstatus').textContent = st ? statusLabel(st) : '';
  $('#pstatus').className = 'pill ' + (st || '');
  setMsg('White to move and mate in two.', '');
  $('#solution').hidden = true;
  $('#btn-hint').disabled = false;
  $('#btn-reveal').disabled = false;
  $('#btn-retry').hidden = true;
  persist();
  renderProgress();
}

function statusLabel(s) {
  return { clean: 'Solved first try', solved: 'Solved', revealed: 'Solution viewed' }[s] || '';
}

function setMsg(html, kind) {
  const el = $('#msg');
  el.innerHTML = html;
  el.className = 'msg ' + (kind || '');
}

// ---------- promotion ----------
function needsPromotion(from, to) {
  return chess.moves({ verbose: true }).some((m) => m.from === from && m.to === to && m.promotion);
}
function askPromotion(to) {
  return new Promise((resolve) => {
    const dlg = $('#promo');
    dlg.hidden = false;
    const handler = (e) => {
      const b = e.target.closest('button[data-p]');
      if (!b) return;
      dlg.removeEventListener('click', handler);
      dlg.hidden = true;
      resolve(b.dataset.p);
    };
    dlg.addEventListener('click', handler);
  });
}

// ---------- user moves ----------
async function onUserMove(from, to) {
  let promotion;
  if (needsPromotion(from, to)) promotion = await askPromotion(to);
  let move;
  try {
    move = chess.move({ from, to, promotion });
  } catch {
    syncBoard();
    return;
  }
  const p = PUZZLES[idx];
  const u = uci(move);
  cg.setAutoShapes([]);

  if (phase === 'first') {
    const correct = p.keys.includes(u);
    if (correct && chess.isCheckmate()) return finish(true);
    if (!correct) return wrong(move, true);
    phase = 'busy';
    syncBoard({ lastMove: [from, to] });
    const reply = chooseDefense(chess, u, p);
    setMsg(`<b>${move.san}</b> — correct! Black replies…`, 'good');
    later(() => {
      chess.move(reply);
      phase = 'second';
      syncBoard({ lastMove: [reply.from, reply.to] });
      setMsg(`<b>${move.san}</b> is right. Black played <b>${reply.san}</b>. Now deliver mate.`, 'good');
    }, 450);
  } else if (phase === 'second') {
    if (chess.isCheckmate()) return finish(true);
    wrong(move, false);
  }
}

function wrong(move, isFirst) {
  mistakes++;
  phase = 'busy';
  syncBoard({ lastMove: [move.from, move.to] });
  let text = `<b>${move.san}</b> isn't it.`;
  if (isFirst && !chess.isGameOver()) {
    const ref = findRefutation(chess);
    if (ref) {
      text = `<b>${move.san}</b> doesn't force mate — Black defends with <b>${ref.san}</b>.`;
      later(() => {
        chess.move(ref);
        syncBoard({ lastMove: [ref.from, ref.to] });
      }, 350);
      later(() => {
        chess.undo();
        chess.undo();
        phase = 'first';
        syncBoard({ lastMove: undefined });
      }, 1700);
      setMsg(text + ' Try again.', 'bad');
      return;
    }
  } else if (!isFirst) {
    text = `<b>${move.san}</b> isn't mate.`;
  }
  setMsg(text + ' Try again.', 'bad');
  later(() => {
    chess.undo();
    phase = isFirst ? 'first' : 'second';
    syncBoard({ lastMove: undefined });
  }, 700);
}

function finish(solved) {
  const p = PUZZLES[idx];
  phase = 'done';
  syncBoard({ lastMove: chess.history({ verbose: true }).slice(-1).map((m) => [m.from, m.to])[0] });
  let result;
  if (solved) {
    result = mistakes === 0 && !hinted ? 'clean' : 'solved';
    setMsg(
      result === 'clean'
        ? '✓ Checkmate! Solved on the first try.'
        : `✓ Checkmate! Solved${mistakes ? ` after ${mistakes} mistake${mistakes > 1 ? 's' : ''}` : ''}${hinted ? ' with a hint' : ''}.`,
      'good',
    );
  } else {
    result = 'revealed';
    setMsg('Here is the book solution.', '');
  }
  // never downgrade an earlier first-try solve
  const prev = progress[p.n];
  const rank = { revealed: 0, solved: 1, clean: 2 };
  if (!prev || (solved && rank[result] > rank[prev])) setStatus(p.n, result);
  else if (!solved && prev === 'clean') setStatus(p.n, 'solved');
  $('#pstatus').textContent = statusLabel(progress[p.n]);
  $('#pstatus').className = 'pill ' + progress[p.n];
  $('#btn-hint').disabled = true;
  $('#btn-reveal').disabled = true;
  $('#btn-retry').hidden = false;
  persist();
  renderProgress();
  showSolution(p);
  sync.syncSoon();
}

// ---------- solution ----------
function formatBook(s) {
  const esc = s.replace(/\( /g, "(").replace(/ \)/g, ")").replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let out = '';
  let depth = 0;
  for (const tok of esc.split(/(\(|\)|\[[^\]]*\])/)) {
    if (tok === '(') {
      depth++;
      out += '<span class="var">(';
    } else if (tok === ')') {
      depth = Math.max(0, depth - 1);
      out += ')</span>';
    } else if (tok.startsWith('[')) {
      out += `<span class="cmt">${tok.slice(1, -1)}</span>`;
    } else out += tok;
  }
  while (depth-- > 0) out += '</span>';
  return out;
}

function showSolution(p) {
  $('#book').innerHTML = formatBook(p.book);
  $('#note').textContent = p.note || '';
  $('#note').hidden = !p.note;
  const c = new Chess(p.fen);
  const fens = [c.fen()];
  const moves = [];
  for (const u of p.line) {
    try {
      const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      moves.push(m);
      fens.push(c.fen());
    } catch {
      break;
    }
  }
  replay = { fens, moves, i: fens.length - 1, userFen: chess.fen() };
  $('#solution').hidden = false;
  renderReplay(false);
}

function renderReplay(apply = true) {
  if (!replay) return;
  const { fens, moves, i } = replay;
  if (apply) {
    const last = i > 0 ? [moves[i - 1].from, moves[i - 1].to] : undefined;
    const c = new Chess(fens[i]);
    cg.set({
      fen: fens[i],
      lastMove: last,
      turnColor: c.turn() === 'w' ? 'white' : 'black',
      check: c.inCheck() ? (c.turn() === 'w' ? 'white' : 'black') : false,
      movable: { color: undefined, dests: new Map() },
    });
  }
  const parts = moves.map((m, k) => {
    const num = k % 2 === 0 ? `${k / 2 + 1}.` : k === 0 ? '1…' : '';
    return `<button class="mv${k + 1 === i ? ' on' : ''}" data-i="${k + 1}">${num}${m.san}</button>`;
  });
  $('#line').innerHTML = parts.join(' ');
}

function step(d) {
  if (!replay) return;
  replay.i = Math.max(0, Math.min(replay.fens.length - 1, replay.i + d));
  renderReplay();
}

// ---------- navigation ----------
function nextIndex(dir = 1) {
  const n = PUZZLES.length;
  if (mode === 'random') {
    const pool = PUZZLES.map((_, k) => k).filter((k) => !progress[PUZZLES[k].n] && k !== idx);
    const src = pool.length ? pool : PUZZLES.map((_, k) => k);
    return src[Math.floor(Math.random() * src.length)];
  }
  for (let s = 1; s <= n; s++) {
    const k = (idx + dir * s + n) % n;
    const st = progress[PUZZLES[k].n];
    if (mode === 'order') return k;
    if (mode === 'unsolved' && !st) return k;
    if (mode === 'review' && (st === 'solved' || st === 'revealed')) return k;
  }
  return (idx + dir + n) % n;
}

function renderProgress() {
  const vals = Object.values(progress);
  const clean = vals.filter((v) => v === 'clean').length;
  const solved = vals.filter((v) => v === 'solved').length;
  const revealed = vals.filter((v) => v === 'revealed').length;
  const done = clean + solved;
  $('#stat-done').textContent = `${done} / ${PUZZLES.length}`;
  $('#stat-acc').textContent = vals.length ? Math.round((clean / vals.length) * 100) + '%' : '—';
  $('#stat-review').textContent = solved + revealed;
  $('#bar-clean').style.width = (clean / PUZZLES.length) * 100 + '%';
  $('#bar-solved').style.width = (solved / PUZZLES.length) * 100 + '%';
  $('#bar-revealed').style.width = (revealed / PUZZLES.length) * 100 + '%';
  const grid = $('#grid');
  if (!grid.childElementCount) {
    grid.innerHTML = PUZZLES.map((p, k) => `<button data-k="${k}" title="#${p.n}"></button>`).join('');
  }
  grid.querySelectorAll('button').forEach((b, k) => {
    b.className = (progress[PUZZLES[k].n] || '') + (k === idx ? ' cur' : '');
  });
}

// ---------- wire up ----------
$('#btn-next').onclick = () => loadPuzzle(nextIndex(1));
$('#btn-prev').onclick = () => loadPuzzle(mode === 'random' ? idx - 1 : nextIndex(-1));
$('#btn-retry').onclick = () => loadPuzzle(idx);
$('#btn-reveal').onclick = () => {
  if (phase === 'done') return;
  finish(false);
  replay.i = 0;
  renderReplay();
};
$('#btn-hint').onclick = () => {
  if (phase !== 'first' && phase !== 'second') return;
  hinted = true;
  const p = PUZZLES[idx];
  let target;
  if (phase === 'first') target = p.keys[0];
  else {
    const m = chess.moves({ verbose: true }).find((mv) => {
      chess.move(mv);
      const ok = chess.isCheckmate();
      chess.undo();
      return ok;
    });
    target = m && uci(m);
  }
  if (target) {
    cg.setAutoShapes([{ orig: sq(target)[0], brush: 'green' }]);
    setMsg('Hint: the highlighted piece moves.', '');
  }
};
$('#jump').onchange = (e) => {
  const k = PUZZLES.findIndex((p) => p.n === +e.target.value);
  if (k >= 0) loadPuzzle(k);
  else e.target.value = PUZZLES[idx].n;
};
$('#mode').value = mode;
$('#mode').onchange = (e) => {
  mode = e.target.value;
  persist();
  if (mode !== 'order' && mode !== 'random') {
    const st = progress[PUZZLES[idx].n];
    const fits = mode === 'unsolved' ? !st : st === 'solved' || st === 'revealed';
    if (!fits) loadPuzzle(nextIndex(1));
  }
};
$('#grid').onclick = (e) => {
  const b = e.target.closest('button[data-k]');
  if (b) {
    loadPuzzle(+b.dataset.k);
    $('#overview').open = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
};
$('#line').onclick = (e) => {
  const b = e.target.closest('button[data-i]');
  if (b && replay) {
    replay.i = +b.dataset.i;
    renderReplay();
  }
};
$('#r-start').onclick = () => step(-99);
$('#r-back').onclick = () => step(-1);
$('#r-fwd').onclick = () => step(1);
$('#r-end').onclick = () => step(99);
$('#btn-reset').onclick = () => {
  if (confirm('Clear all progress? This cannot be undone.')) {
    entries = {};
    resetAt = Date.now();
    rebuildProgress();
    persist();
    loadPuzzle(idx);
    sync.syncSoon(0);
  }
};
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select')) return;
  if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'n' || (e.key === 'Enter' && phase === 'done')) $('#btn-next').click();
});

// ---------- sync ----------
const sync = createSync({
  getState: () => ({ entries, resetAt }),
  applyState: (st) => {
    entries = st.entries;
    resetAt = st.resetAt;
    rebuildProgress();
    persist();
    renderProgress();
    const cur = progress[PUZZLES[idx].n];
    $('#pstatus').textContent = cur ? statusLabel(cur) : '';
    $('#pstatus').className = 'pill ' + (cur || '');
  },
  onStatus: renderSync,
});

function ago(t) {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
function renderSync(st) {
  const on = st.state !== 'off';
  $('#sync-setup').hidden = on;
  $('#sync-on').hidden = !on;
  const text = {
    off: '',
    syncing: 'Syncing…',
    ok: `Synced ${ago(st.at)}`,
    offline: `Offline — will sync when you're back online${st.at ? ` (last synced ${ago(st.at)})` : ''}`,
    error: `Sync failed: ${st.message}`,
  }[st.state];
  $('#sync-status').textContent = text;
  $('#sync-status').className = 'sync-status ' + st.state;
  $('#sync-dot').className = 'dot ' + st.state;
}
$('#sync-connect').onclick = async () => {
  const token = $('#sync-token').value.trim();
  if (!token) return $('#sync-token').focus();
  $('#sync-token').value = '';
  await sync.connect(token);
};
$('#sync-now').onclick = () => sync.sync();
$('#sync-off').onclick = () => {
  if (confirm('Stop syncing on this device? Your progress stays here and in the gist.')) sync.disconnect();
};

loadPuzzle(idx);
renderSync({ state: sync.connected ? 'syncing' : 'off' });
if (sync.connected) sync.sync();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
