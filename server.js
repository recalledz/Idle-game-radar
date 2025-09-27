import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(morgan('tiny'));
app.use(express.json());
app.use(express.static('public'));

const RAWG_KEY = process.env.RAWG_KEY;
const PORT = process.env.PORT || 5173;
const BASE_URL = 'https://api.rawg.io/api/games';

// Common shorthand -> RAWG platform IDs
const PLATFORM_ID_MAP = {
  pc: 4,
  windows: 4,
  win: 4,
  ps5: 187,
  'playstation5': 187,
  ps4: 18,
  'playstation4': 18,
  xbox: 1,
  'xbox-one': 1,
  xsx: 186,
  'xbox-series-x': 186,
  switch: 7,
  nintendo: 7,
  ios: 3,
  iphone: 3,
  android: 21,
  mobile: [3,21],
  mac: 5,
  linux: 6,
  steamdeck: 4
};

function resolvePlatforms(input) {
  if (!input) return null;
  // Allow numeric ids or names; comma-separated
  const parts = String(input).split(',').map(s => s.trim()).filter(Boolean);
  const ids = [];
  for (const p of parts) {
    if (/^\d+$/.test(p)) { ids.push(Number(p)); continue; }
    const key = p.toLowerCase();
    const val = PLATFORM_ID_MAP[key];
    if (Array.isArray(val)) ids.push(...val);
    else if (val) ids.push(val);
  }
  // dedupe
  const uniq = [...new Set(ids)];
  return uniq.length ? uniq : null;
}

// --- simple JSON "db" ---
const DEFAULT_DB = {
  preferences: {
    weights: { rating: 0.5, tagLike: 4, tagSkip: -2, recency: 0.1 },
    likes: {},
    skips: {},
    hiddenSlugs: {}
  }
};

const FALLBACK_DATA_DIR = path.join(process.env.TMPDIR || '/tmp', 'idle-game-radar');

let DATA_DIR = process.env.DATA_DIR || path.resolve('data');
let DAILY_DIR = path.join(DATA_DIR, 'daily');
let DB_FILE = path.join(DATA_DIR, 'db.json');
let STORAGE_MODE = 'disk';
let MEMORY_DB = null;

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_DB));
}

function tryInitDirectory(baseDir) {
  fs.mkdirSync(baseDir, { recursive: true });
  const dailyDir = path.join(baseDir, 'daily');
  fs.mkdirSync(dailyDir, { recursive: true });
  const dbFile = path.join(baseDir, 'db.json');
  if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, JSON.stringify(DEFAULT_DB, null, 2));
  }
  DATA_DIR = baseDir;
  DAILY_DIR = dailyDir;
  DB_FILE = dbFile;
  STORAGE_MODE = 'disk';
  MEMORY_DB = null;
}

function ensureData() {
  const candidates = [DATA_DIR];
  if (!candidates.includes(FALLBACK_DATA_DIR)) {
    candidates.push(FALLBACK_DATA_DIR);
  }

  for (const dir of candidates) {
    try {
      tryInitDirectory(dir);
      return;
    } catch (err) {
      console.warn(`Failed to initialise data directory at ${dir}: ${err.code || err.message}`);
    }
  }

  console.warn('Falling back to in-memory preference store. Changes will not persist.');
  STORAGE_MODE = 'memory';
  MEMORY_DB = cloneDefault();
}
ensureData();

function readDB() {
  if (STORAGE_MODE === 'memory') return MEMORY_DB;
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (err) {
    console.warn(`Failed to read DB file, switching to in-memory store: ${err.code || err.message}`);
    STORAGE_MODE = 'memory';
    MEMORY_DB = cloneDefault();
    return MEMORY_DB;
  }
}

function writeDB(db) {
  if (STORAGE_MODE === 'memory') {
    MEMORY_DB = db;
    return;
  }
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.warn(`Failed to write DB file, switching to in-memory store: ${err.code || err.message}`);
    STORAGE_MODE = 'memory';
    MEMORY_DB = db;
  }
}

function scoreGame(game, prefs) {
  const w = prefs.weights || {};
  const rating = (game.rating ?? 0);
  let s = rating * 20 * (w.rating ?? 0.5);

  const tags = new Set([...(game.tags||[]), ...(game.genres||[])]);
  for (const t of tags) {
    const key = String(t).toLowerCase();
    if (prefs.likes[key]) s += (w.tagLike ?? 4) * (1 + Math.log10(1 + prefs.likes[key]));
    if (prefs.skips[key]) s += (w.tagSkip ?? -2) * (1 + Math.log10(1 + prefs.skips[key]));
  }

  if (game.released) {
    try {
      const days = Math.max(0, (Date.now() - new Date(game.released).getTime()) / 86400000);
      const rec = Math.max(0, 30 - days) / 30;
      s += rec * 10 * (w.recency ?? 0.1);
    } catch {}
  }

  return Math.round(s);
}

async function rawgFetch(params) {
  if (!RAWG_KEY) {
    const err = new Error('RAWG_KEY missing');
    err.status = 500;
    err.data = {
      error: 'rawg_key_missing',
      detail: 'RAWG_KEY missing',
      _note: 'Set the RAWG_KEY environment variable before fetching from RAWG.'
    };
    throw err;
  }
  // Strip undefined or null
  const clean = Object.fromEntries(Object.entries(params).filter(([_,v]) => v !== undefined && v !== null && v !== ''));
  const url = BASE_URL;
  const query = { key: RAWG_KEY, ...clean };
  const { data } = await axios.get(url, { params: query });
  return { ...data, _debug: { url, query } };
}

// Health/debug endpoints
app.get('/api/health', (req, res) => {
  res.json({ ok: true, RAWG_KEY_present: Boolean(RAWG_KEY) });
});

app.get('/api/debug', async (req, res) => {
  const pf = resolvePlatforms(req.query.platforms);
  const now = new Date();
  const end = now.toISOString().split('T')[0];
  const start = new Date(now.getTime() - Number(req.query.daysBack || 3) * 86400000).toISOString().split('T')[0];
  res.json({
    exampleParams: {
      dates: `${start},${end}`,
      platforms: pf ? pf.join(',') : '(omitted)',
      tags: req.query.tags || '(none)',
      ordering: req.query.ordering || '-rating',
      page_size: req.query.pageSize || 30
    },
    RAWG_KEY_present: Boolean(RAWG_KEY)
  });
});

// Fetch live games with filters
app.get('/api/games', async (req, res) => {
  try {
    const {
      daysBack = '3',
      platforms = '',
      tags = '',
      ordering = '-rating',
      pageSize = '30',
      minRating = '0',
      hideSeen = 'true'
    } = req.query;

    const now = new Date();
    const end = now.toISOString().split('T')[0];
    const start = new Date(now.getTime() - Number(daysBack) * 86400000).toISOString().split('T')[0];

    const platformIds = resolvePlatforms(platforms);

    const params = {
      dates: `${start},${end}`,
      ordering,
      page_size: pageSize
    };
    if (platformIds) params.platforms = platformIds.join(',');
    if (tags) params.tags = tags;

    const data = await rawgFetch(params);
    const db = readDB();
    const prefs = db.preferences;
    const min = Number(minRating) || 0;

    const mapped = (data?.results || []).map(g => ({
      id: g.id,
      slug: g.slug,
      name: g.name,
      released: g.released,
      rating: g.rating,
      ratings_count: g.ratings_count,
      platforms: (g.platforms||[]).map(p => p.platform?.name).filter(Boolean),
      tags: (g.tags||[]).map(t => t.name),
      genres: (g.genres||[]).map(gn => gn.name),
      background_image: g.background_image
    }));

    const filtered = mapped.filter(g => (g.rating || 0) >= min)
      .filter(g => hideSeen !== 'true' || !prefs.hiddenSlugs[g.slug]);

    const scored = filtered.map(g => ({ ...g, _score: scoreGame(g, prefs) }))
                           .sort((a,b) => b._score - a._score);

    res.json({ range: { start, end }, count: scored.length, results: scored, _debug: data?._debug });
  } catch (e) {
    const status = e.status || e.response?.status || 500;
    const data = (e.data && typeof e.data === 'object')
      ? { ...e.data }
      : (e.response?.data && typeof e.response.data === 'object')
        ? { ...e.response.data }
        : null;
    const detail = data?.detail || e.message || 'fetch_failed';
    const payload = data || {};
    if (!payload.error) payload.error = 'fetch_failed';
    if (!payload.detail) payload.detail = detail;
    console.error(payload);
    res.status(status).json(payload);
  }
});

app.get('/api/preferences', (req, res) => {
  const db = readDB();
  res.json(db.preferences);
});

app.post('/api/preferences', (req, res) => {
  const db = readDB();
  const { weights, likeTags = [], skipTags = [] } = req.body || {};

  if (weights && typeof weights === 'object') {
    db.preferences.weights = { ...db.preferences.weights, ...weights };
  }
  for (const t of likeTags) {
    const k = String(t).toLowerCase();
    db.preferences.likes[k] = (db.preferences.likes[k] || 0) + 1;
  }
  for (const t of skipTags) {
    const k = String(t).toLowerCase();
    db.preferences.skips[k] = (db.preferences.skips[k] || 0) + 1;
  }
  writeDB(db);
  res.json({ ok: true, preferences: db.preferences });
});

app.post('/api/seen', (req, res) => {
  const { slug, hide = true } = req.body || {};
  if (!slug) return res.status(400).json({ error: 'missing_slug' });
  const db = readDB();
  if (hide) db.preferences.hiddenSlugs[slug] = true;
  else delete db.preferences.hiddenSlugs[slug];
  writeDB(db);
  res.json({ ok: true });
});

app.post('/api/daily/run', async (req, res) => {
  try {
    if (STORAGE_MODE !== 'disk') {
      return res.status(503).json({
        error: 'storage_unavailable',
        detail: 'Daily snapshots are disabled because persistent storage is unavailable in this environment.'
      });
    }
    const { daysBack = 1, platforms = '', tags = '', pageSize = 60 } = req.body || {};
    const now = new Date();
    const end = now.toISOString().split('T')[0];
    const start = new Date(now.getTime() - Number(daysBack) * 86400000).toISOString().split('T')[0];
    const platformIds = resolvePlatforms(platforms);
    const params = { dates: `${start},${end}`, ordering: '-rating', page_size: pageSize };
    if (platformIds) params.platforms = platformIds.join(',');
    if (tags) params.tags = tags;

    const data = await rawgFetch(params);
    const db = readDB();
    const prefs = db.preferences;
    const mapped = (data?.results || []).map(g => ({
      id: g.id, slug: g.slug, name: g.name, released: g.released,
      rating: g.rating, ratings_count: g.ratings_count,
      platforms: (g.platforms||[]).map(p => p.platform?.name).filter(Boolean),
      tags: (g.tags||[]).map(t => t.name),
      genres: (g.genres||[]).map(gn => gn.name),
      background_image: g.background_image
    }));
    const scored = mapped.map(g => ({ ...g, _score: scoreGame(g, prefs) }))
                         .sort((a,b) => b._score - a._score);

    const stamp = end;
    const file = path.join(DAILY_DIR, `${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify({ stamp, start, end, results: scored, _debug: data?._debug }, null, 2));

    res.json({ ok: true, saved: file, count: scored.length, top5: scored.slice(0,5) });
  } catch (e) {
    const status = e.status || e.response?.status || 500;
    const data = (e.data && typeof e.data === 'object')
      ? { ...e.data }
      : (e.response?.data && typeof e.response.data === 'object')
        ? { ...e.response.data }
        : null;
    const detail = data?.detail || e.message || 'daily_failed';
    const payload = data || {};
    if (!payload.error) payload.error = 'daily_failed';
    if (!payload.detail) payload.detail = detail;
    console.error(payload);
    res.status(status).json(payload);
  }
});

const dailyStatic = express.static(DAILY_DIR);
app.use('/data/daily', (req, res, next) => {
  if (STORAGE_MODE !== 'disk') {
    return res.status(503).json({
      error: 'storage_unavailable',
      detail: 'Daily exports are disabled because persistent storage is unavailable in this environment.'
    });
  }
  return dailyStatic(req, res, next);
});

app.listen(PORT, () => console.log(`Game Radar Pro running http://localhost:${PORT}`));
