// Progress sync through a private GitHub gist.
// State shape: { entries: { [n]: { s: status, t: ms } }, resetAt: ms }
// Merge is last-write-wins per puzzle; a reset wipes everything older than it.

const SYNC_KEY = 'polgar-m2-sync';
const FILE = 'polgar-mate-in-2-progress.json';
const API = 'https://api.github.com';

export function mergeStates(a, b) {
  const resetAt = Math.max(a.resetAt || 0, b.resetAt || 0);
  const entries = {};
  for (const src of [a.entries || {}, b.entries || {}]) {
    for (const [n, e] of Object.entries(src)) {
      if (e.t <= resetAt) continue;
      if (!entries[n] || e.t > entries[n].t) entries[n] = e;
    }
  }
  return { entries, resetAt };
}

const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
function sorted(s) {
  const entries = {};
  for (const k of Object.keys(s.entries || {}).sort()) entries[k] = s.entries[k];
  return { entries, resetAt: s.resetAt || 0 };
}

export function createSync({ getState, applyState, onStatus }) {
  let cfg = {};
  try {
    cfg = JSON.parse(localStorage.getItem(SYNC_KEY)) || {};
  } catch {}
  const saveCfg = () => {
    try {
      localStorage.setItem(SYNC_KEY, JSON.stringify(cfg));
    } catch {}
  };

  async function gh(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cfg.token}`,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (res.status === 401) throw new Error('GitHub rejected the token — check it has the "gist" scope.');
    if (res.status === 404) throw Object.assign(new Error('Gist not found.'), { notFound: true });
    if (!res.ok) throw new Error(`GitHub error ${res.status}`);
    return res.json();
  }

  async function findOrCreateGist() {
    for (let page = 1; page <= 10; page++) {
      const list = await gh(`/gists?per_page=100&page=${page}`);
      const hit = list.find((g) => g.files && g.files[FILE]);
      if (hit) return hit.id;
      if (list.length < 100) break;
    }
    const g = await gh('/gists', {
      method: 'POST',
      body: JSON.stringify({
        description: 'Polgár Mate in Two — puzzle progress (synced by the app)',
        public: false,
        files: { [FILE]: { content: JSON.stringify(getState()) } },
      }),
    });
    return g.id;
  }

  async function readRemote() {
    const g = await gh(`/gists/${cfg.gistId}`);
    const f = g.files[FILE];
    if (!f) return { entries: {}, resetAt: 0 };
    const text = f.truncated ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content;
    try {
      return JSON.parse(text);
    } catch {
      return { entries: {}, resetAt: 0 };
    }
  }

  let running = null;
  let again = false;

  async function run() {
    if (!cfg.token) return onStatus({ state: 'off' });
    if (!navigator.onLine) return onStatus({ state: 'offline', at: cfg.lastSync });
    onStatus({ state: 'syncing', at: cfg.lastSync });
    try {
      if (!cfg.gistId) {
        cfg.gistId = await findOrCreateGist();
        saveCfg();
      }
      let remote;
      try {
        remote = await readRemote();
      } catch (e) {
        if (!e.notFound) throw e;
        cfg.gistId = await findOrCreateGist(); // gist was deleted — start a new one
        saveCfg();
        remote = await readRemote();
      }
      const local = getState();
      const merged = mergeStates(local, remote);
      if (!same(merged, remote)) {
        await gh(`/gists/${cfg.gistId}`, {
          method: 'PATCH',
          body: JSON.stringify({ files: { [FILE]: { content: JSON.stringify(merged) } } }),
        });
      }
      if (!same(merged, local)) applyState(merged);
      cfg.lastSync = Date.now();
      saveCfg();
      onStatus({ state: 'ok', at: cfg.lastSync });
    } catch (e) {
      onStatus({ state: 'error', message: e.message || String(e), at: cfg.lastSync });
    }
  }

  function sync() {
    if (running) {
      again = true;
      return running;
    }
    running = run().finally(() => {
      running = null;
      if (again) {
        again = false;
        sync();
      }
    });
    return running;
  }

  let timer;
  const syncSoon = (ms = 1500) => {
    clearTimeout(timer);
    timer = setTimeout(sync, ms);
  };

  window.addEventListener('online', () => sync());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sync());

  return {
    get connected() {
      return !!cfg.token;
    },
    async connect(token) {
      cfg = { token: token.trim() };
      saveCfg();
      await sync();
    },
    disconnect() {
      cfg = {};
      saveCfg();
      onStatus({ state: 'off' });
    },
    sync,
    syncSoon,
  };
}
