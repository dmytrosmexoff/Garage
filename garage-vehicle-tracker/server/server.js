'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), mysql = require('mysql2/promise');

const PORT = +process.env.PORT || 3000;
const cfg = {
  host: process.env.DB_HOST || 'db', user: process.env.DB_USER || 'garage',
  password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'garage',
  waitForConnections: true, connectionLimit: 4, dateStrings: true, decimalNumbers: true,
  charset: 'UTF8MB4_UNICODE_CI'
};

const SCHEMA = [
`CREATE TABLE IF NOT EXISTS vehicles(
  id VARCHAR(32) NOT NULL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  type VARCHAR(16) NOT NULL,
  buy_date DATE NULL,
  buy_km INT NOT NULL DEFAULT 0,
  odo INT NOT NULL DEFAULT 0,
  currency VARCHAR(8) NOT NULL DEFAULT '¥',
  ins_end DATE NULL, ins_note VARCHAR(500) NOT NULL DEFAULT '',
  ti_end DATE NULL, ti_note VARCHAR(500) NOT NULL DEFAULT '',
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS parts(
  id VARCHAR(32) NOT NULL PRIMARY KEY,
  vehicle_id VARCHAR(32) NOT NULL,
  category VARCHAR(120) NOT NULL,
  name VARCHAR(200) NOT NULL,
  interval_km INT NOT NULL DEFAULT 0,
  interval_months INT NOT NULL DEFAULT 0,
  last_km INT NULL,
  last_date DATE NULL,
  note TEXT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  INDEX idx_parts_vehicle (vehicle_id),
  CONSTRAINT fk_parts_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS part_history(
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  part_id VARCHAR(32) NOT NULL,
  done_date DATE NULL,
  km INT NULL,
  cost DECIMAL(12,2) NULL,
  note TEXT NULL,
  INDEX idx_hist_part (part_id),
  CONSTRAINT fk_hist_part FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS mileage_log(
  vehicle_id VARCHAR(32) NOT NULL,
  log_date DATE NOT NULL,
  odo INT NOT NULL,
  trip INT NULL,
  PRIMARY KEY (vehicle_id, log_date),
  CONSTRAINT fk_log_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS meta(
  k VARCHAR(50) NOT NULL PRIMARY KEY,
  v VARCHAR(200) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

let pool = null, ready = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function initDb() {
  for (let i = 0; ; i++) {
    try {
      pool = mysql.createPool(cfg);
      await pool.query('SELECT 1');
      break;
    } catch (e) {
      console.log('MySQL is not ready yet:', e.code || e.message);
      try { if (pool) await pool.end(); } catch (_) {}
      await sleep(Math.min(5000, 1000 + i * 500));
    }
  }
  for (const q of SCHEMA) await pool.query(q);
  ready = true;
  console.log('Database ready');
}

// ---- sanitizers ----
const D = s => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null);
const I = x => { x = Math.round(+x); return Number.isFinite(x) ? x : 0; };
const IN = x => (x == null || x === '' ? null : I(x));
const T = (s, n) => String(s == null ? '' : s).slice(0, n);
const C = x => (x == null || x === '' || !Number.isFinite(+x) ? null : +(+x).toFixed(2));

async function getState() {
  const [vs] = await pool.query('SELECT * FROM vehicles ORDER BY sort_order, created_at');
  const [ps] = await pool.query('SELECT * FROM parts ORDER BY vehicle_id, sort_order');
  const [hs] = await pool.query('SELECT * FROM part_history ORDER BY part_id, done_date, id');
  const [ls] = await pool.query('SELECT * FROM mileage_log ORDER BY vehicle_id, log_date');
  const [m] = await pool.query("SELECT v FROM meta WHERE k='cur'");
  const hist = {}, parts = {}, logs = {};
  hs.forEach(h => (hist[h.part_id] = hist[h.part_id] || []).push({ d: h.done_date, km: h.km, cost: h.cost, note: h.note || '' }));
  ps.forEach(p => (parts[p.vehicle_id] = parts[p.vehicle_id] || []).push({
    id: p.id, cat: p.category, name: p.name, km: p.interval_km, mo: p.interval_months,
    lastKm: p.last_km, lastDate: p.last_date, note: p.note || '', hist: hist[p.id] || []
  }));
  ls.forEach(l => (logs[l.vehicle_id] = logs[l.vehicle_id] || []).push({ d: l.log_date, odo: l.odo, trip: l.trip }));
  return {
    cur: m[0] ? m[0].v : '',
    v: vs.map(v => ({
      id: v.id, name: v.name, type: v.type, buyDate: v.buy_date || '', buyKm: v.buy_km, odo: v.odo, cc: v.currency,
      docs: { ins: { end: v.ins_end || '', note: v.ins_note }, ti: { end: v.ti_end || '', note: v.ti_note } },
      items: parts[v.id] || [], log: logs[v.id] || []
    }))
  };
}

async function putState(s) {
  if (!s || !Array.isArray(s.v)) { const e = new Error('bad state'); e.status = 400; throw e; }
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const ids = s.v.map(v => T(v && v.id, 32)).filter(Boolean);
    if (ids.length) await c.query('DELETE FROM vehicles WHERE id NOT IN (?)', [ids]);
    else await c.query('DELETE FROM vehicles');
    let order = 0;
    for (const v of s.v) {
      const id = T(v && v.id, 32); if (!id) continue;
      const d = v.docs || {}, ins = d.ins || {}, ti = d.ti || {};
      await c.query(
        `INSERT INTO vehicles(id,name,type,buy_date,buy_km,odo,currency,ins_end,ins_note,ti_end,ti_note,sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE name=VALUES(name),type=VALUES(type),buy_date=VALUES(buy_date),buy_km=VALUES(buy_km),
           odo=VALUES(odo),currency=VALUES(currency),ins_end=VALUES(ins_end),ins_note=VALUES(ins_note),
           ti_end=VALUES(ti_end),ti_note=VALUES(ti_note),sort_order=VALUES(sort_order)`,
        [id, T(v.name, 200) || 'Без названия', T(v.type, 16) || 'other', D(v.buyDate), I(v.buyKm), I(v.odo),
         T(v.cc, 8) || '¥', D(ins.end), T(ins.note, 500), D(ti.end), T(ti.note, 500), order++]);
      await c.query('DELETE FROM parts WHERE vehicle_id=?', [id]);          // history is removed by cascade
      await c.query('DELETE FROM mileage_log WHERE vehicle_id=?', [id]);

      const items = (Array.isArray(v.items) ? v.items : []).filter(it => it && T(it.id, 32));
      if (items.length) await c.query(
        'INSERT INTO parts(id,vehicle_id,category,name,interval_km,interval_months,last_km,last_date,note,sort_order) VALUES ?',
        [items.map((it, i) => [T(it.id, 32), id, T(it.cat, 120) || 'Прочее', T(it.name, 200), I(it.km), I(it.mo),
                               IN(it.lastKm), D(it.lastDate), T(it.note, 4000), i])]);
      const hrows = [];
      items.forEach(it => (Array.isArray(it.hist) ? it.hist : []).forEach(h =>
        hrows.push([T(it.id, 32), D(h.d), IN(h.km), C(h.cost), T(h.note, 4000)])));
      if (hrows.length) await c.query('INSERT INTO part_history(part_id,done_date,km,cost,note) VALUES ?', [hrows]);

      const log = new Map();
      (Array.isArray(v.log) ? v.log : []).forEach(e => { if (e && D(e.d)) log.set(e.d, [id, e.d, I(e.odo), IN(e.trip)]); });
      if (log.size) await c.query('INSERT INTO mileage_log(vehicle_id,log_date,odo,trip) VALUES ?', [[...log.values()]]);
    }
    await c.query("INSERT INTO meta(k,v) VALUES('cur',?) ON DUPLICATE KEY UPDATE v=VALUES(v)", [T(s.cur, 32)]);
    await c.commit();
  } catch (e) {
    try { await c.rollback(); } catch (_) {}
    throw e;
  } finally { c.release(); }
}

// serialize writes
let chain = Promise.resolve();
const run = fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, fail) => {
  let b = '', n = 0;
  req.on('data', ch => { n += ch.length; if (n > 8e6) { fail(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else b += ch; });
  req.on('end', () => ok(b)); req.on('error', fail);
});
const INDEX = path.join(__dirname, 'public', 'index.html');

http.createServer(async (req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/api/health') return json(res, 200, { ok: true, db: ready });
    if (u === '/api/state') {
      if (!ready) return json(res, 503, { error: 'database is starting' });
      if (req.method === 'GET') return json(res, 200, await getState());
      if (req.method === 'PUT') {
        let data; try { data = JSON.parse(await readBody(req)); } catch (e) { if (e.status) throw e; return json(res, 400, { error: 'invalid json' }); }
        await run(() => putState(data));
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: 'method not allowed' });
    }
    if (u === '/' || u === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(INDEX).pipe(res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  } catch (e) {
    console.error(e);
    json(res, e.status || 500, { error: e.message });
  }
}).listen(PORT, '0.0.0.0', () => console.log('Listening on', PORT));

initDb().catch(e => { console.error(e); process.exit(1); });
const stop = () => { (pool ? pool.end() : Promise.resolve()).finally(() => process.exit(0)); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
