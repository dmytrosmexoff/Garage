'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), mysql = require('mysql2/promise');

const PORT = +process.env.PORT || 3000;
const CONFIG_PATH = process.env.CONFIG_PATH || '/config/db.json';
// Параметры встроенной MySQL из docker-compose (используются как значения по умолчанию)
const ENV = { host: process.env.DB_HOST || 'db', port: +process.env.DB_PORT || 3306, user: process.env.DB_USER || 'garage',
              password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'garage' };

let cfg = null, pool = null, ready = false, connecting = false, lastError = '', gen = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { cfg = null; }

const SCHEMA = [
`CREATE TABLE IF NOT EXISTS users(
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  login VARCHAR(64) NOT NULL,
  pass_hash VARCHAR(300) NOT NULL,
  is_admin TINYINT NOT NULL DEFAULT 0,
  cur_vehicle VARCHAR(32) NOT NULL DEFAULT '',
  lang VARCHAR(5) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_login (login)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS sessions(
  token_hash CHAR(64) NOT NULL PRIMARY KEY,
  user_id INT NOT NULL,
  expires DATETIME NOT NULL,
  INDEX idx_s_user (user_id),
  CONSTRAINT fk_s_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS vehicles(
  id VARCHAR(32) NOT NULL PRIMARY KEY,
  user_id INT NULL,
  name VARCHAR(200) NOT NULL,
  type VARCHAR(16) NOT NULL,
  buy_date DATE NULL,
  buy_km INT NOT NULL DEFAULT 0,
  buy_price DECIMAL(14,2) NULL,
  odo INT NOT NULL DEFAULT 0,
  odo_offset INT NOT NULL DEFAULT 0,
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
  checks TEXT NULL,
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
  details TEXT NULL,
  photos TEXT NULL,
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
`CREATE TABLE IF NOT EXISTS panel_changes(
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vehicle_id VARCHAR(32) NOT NULL,
  change_date DATE NULL,
  old_km INT NOT NULL DEFAULT 0,
  new_km INT NOT NULL DEFAULT 0,
  true_km INT NOT NULL DEFAULT 0,
  note VARCHAR(500) NOT NULL DEFAULT '',
  INDEX idx_pc_vehicle (vehicle_id),
  CONSTRAINT fk_pc_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS photos(
  id VARCHAR(32) NOT NULL PRIMARY KEY,
  user_id INT NOT NULL,
  mime VARCHAR(40) NOT NULL,
  data MEDIUMBLOB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_photo_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS plans(
  id VARCHAR(32) NOT NULL PRIMARY KEY,
  vehicle_id VARCHAR(32) NOT NULL,
  item_id VARCHAR(32) NULL,
  title VARCHAR(200) NOT NULL DEFAULT '',
  url VARCHAR(1000) NOT NULL DEFAULT '',
  price DECIMAL(12,2) NULL,
  note TEXT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  INDEX idx_plans_vehicle (vehicle_id),
  CONSTRAINT fk_plans_vehicle FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

async function addCol(p, t, c, def) {
  const [r] = await p.query('SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?', [t, c]);
  if (!r[0].n) await p.query(`ALTER TABLE \`${t}\` ADD COLUMN \`${c}\` ${def}`);
}
async function initSchema(p) {
  for (const q of SCHEMA) await p.query(q);
  // обновление баз, созданных версией 1.0
  await addCol(p, 'vehicles', 'user_id', 'INT NULL');
  await addCol(p, 'vehicles', 'odo_offset', 'INT NOT NULL DEFAULT 0');
  await addCol(p, 'vehicles', 'buy_price', 'DECIMAL(14,2) NULL');
  await addCol(p, 'parts', 'checks', 'TEXT NULL');
  await addCol(p, 'part_history', 'photos', 'TEXT NULL');
  await addCol(p, 'users', 'lang', "VARCHAR(5) NOT NULL DEFAULT ''");
  await addCol(p, 'part_history', 'details', 'TEXT NULL');
}
const mkPool = c => mysql.createPool({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database,
  waitForConnections: true, connectionLimit: 4, connectTimeout: 8000, dateStrings: true, decimalNumbers: true, charset: 'UTF8MB4_UNICODE_CI' });

function errMsg(e) {
  const c = e && e.code;
  if (c === 'ER_ACCESS_DENIED_ERROR') return 'Неверный логин или пароль MySQL';
  if (c === 'ER_DBACCESS_DENIED_ERROR') return 'У пользователя нет прав на эту базу данных';
  if (c === 'ER_BAD_DB_ERROR') return 'База данных не найдена: нажмите «Создать пустую базу»';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'Адрес сервера не найден';
  if (c === 'ECONNREFUSED' || c === 'ETIMEDOUT' || c === 'EHOSTUNREACH') return 'Сервер MySQL недоступен (проверьте адрес и порт или подождите, пока он запустится)';
  return (e && e.message ? String(e.message) : 'Ошибка') + (c ? ' (' + c + ')' : '');
}

// фоновое подключение при старте, если настройки уже сохранены
async function connectLoop() {
  const my = ++gen; connecting = true; ready = false;
  if (pool) { const old = pool; pool = null; old.end().catch(() => {}); }
  for (let i = 0; my === gen; i++) {
    let p = null;
    try {
      p = mkPool(cfg); await p.query('SELECT 1'); await initSchema(p);
      if (my !== gen) { await p.end(); return; }
      pool = p; ready = true; connecting = false; lastError = ''; console.log('Database ready'); return;
    } catch (e) {
      lastError = errMsg(e); console.log('DB not ready:', lastError);
      if (p) p.end().catch(() => {});
      await sleep(Math.min(5000, 1500 + i * 500));
    }
  }
}

function cleanCfg(b) {
  if (b && b.builtin) return { ...ENV, builtin: true };
  const host = String(b && b.host || '').trim(), user = String(b && b.user || '').trim(), database = String(b && b.database || '').trim();
  const port = Math.round(+(b && b.port) || 3306);
  let password = String(b && b.password || '');
  if (!/^[A-Za-z0-9._:-]{1,255}$/.test(host)) throw httpErr(400, 'Укажите адрес сервера');
  if (!(port >= 1 && port <= 65535)) throw httpErr(400, 'Порт должен быть от 1 до 65535');
  if (!user || user.length > 64) throw httpErr(400, 'Укажите пользователя MySQL');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) throw httpErr(400, 'Имя базы: латинские буквы, цифры и _');
  if (!password && cfg && cfg.host === host && cfg.user === user) password = cfg.password; // оставить прежний пароль
  return { host, port, user, password, database, builtin: false };
}
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const noDb = c => ({ host: c.host, port: c.port, user: c.user, password: c.password, connectTimeout: 8000, charset: 'UTF8MB4_UNICODE_CI' });

async function testConn(c) {
  const conn = await mysql.createConnection(noDb(c));
  try { const [r] = await conn.query('SHOW DATABASES LIKE ?', [c.database]); return { dbExists: r.length > 0 }; }
  finally { await conn.end(); }
}
async function createDb(c) {
  const conn = await mysql.createConnection(noDb(c));
  try { await conn.query(`CREATE DATABASE IF NOT EXISTS \`${c.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); }
  finally { await conn.end(); }
  const p = mkPool(c);
  try { await p.query('SELECT 1'); await initSchema(p); } finally { await p.end(); }
}
async function activate(c) {
  const p = mkPool(c);
  try { await p.query('SELECT 1'); await initSchema(p); } catch (e) { p.end().catch(() => {}); throw e; }
  gen++;
  const old = pool; pool = p; cfg = c; ready = true; connecting = false; lastError = '';
  if (old) old.end().catch(() => {});
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c), { mode: 0o600 });
}

// ---- пользователи и сессии ----
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
const checkPw = (pw, stored) => {
  const [salt, h] = String(stored).split(':'); if (!salt || !h) return false;
  const x = crypto.scryptSync(pw, salt, 64), y = Buffer.from(h, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const fails = new Map();
async function newSession(res, uid) {
  const t = crypto.randomBytes(32).toString('hex');
  await pool.query('DELETE FROM sessions WHERE expires<NOW()');
  await pool.query('INSERT INTO sessions(token_hash,user_id,expires) VALUES (?,?,DATE_ADD(NOW(),INTERVAL 30 DAY))', [sha(t), uid]);
  res.setHeader('Set-Cookie', `gt=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
}
const tokenOf = req => { const m = /(?:^|;\s*)gt=([a-f0-9]{64})/.exec(req.headers.cookie || ''); return m ? m[1] : null; };
async function userOf(req) {
  if (!ready) return null;
  const t = tokenOf(req); if (!t) return null;
  const [r] = await pool.query('SELECT u.id,u.login,u.is_admin,u.lang FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>NOW()', [sha(t)]);
  return r[0] ? { id: r[0].id, login: r[0].login, admin: !!r[0].is_admin, lang: r[0].lang } : null;
}
const needUser = async req => { const u = await userOf(req); if (!u) throw httpErr(401, 'Нужно войти'); return u; };
const canSetup = async req => { if (!ready) return; const u = await userOf(req); if (!u || !u.admin) throw httpErr(403, 'Только администратор может менять настройки базы'); };

// ---- санитайзеры ----
const D = s => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null);
const I = x => { x = Math.round(+x); return Number.isFinite(x) ? x : 0; };
const IN = x => (x == null || x === '' ? null : I(x));
const T = (s, n) => String(s == null ? '' : s).slice(0, n);
const C = x => (x == null || x === '' || !Number.isFinite(+x) ? null : +(+x).toFixed(2));
const X = x => {
  if (!x || typeof x !== 'object') return null;
  const o = {};
  Object.keys(x).slice(0, 20).forEach(k => { const v = T(x[k], 200).trim(); if (v && /^[a-z_]{1,20}$/.test(k)) o[k] = v; });
  return Object.keys(o).length ? JSON.stringify(o) : null;
};
const parseJ = s => { try { const v = s ? JSON.parse(s) : []; return Array.isArray(v) ? v : []; } catch (_) { return []; } };
const PHJ = x => { const a = (Array.isArray(x) ? x : []).filter(i => /^[a-f0-9]{16,32}$/.test(i)).slice(0, 20); return a.length ? JSON.stringify(a) : null; };
const CKJ = x => { if (!Array.isArray(x)) return null; const a = x.slice(0, 50).map(c => ({ d: D(c && c.d) || '', km: I(c && c.km), ak: I(c && c.ak), am: I(c && c.am) })); return a.length ? JSON.stringify(a) : null; };
const parseX = s => { try { return s ? JSON.parse(s) : {}; } catch (_) { return {}; } };

async function getState(uid) {
  const [vs] = await pool.query('SELECT * FROM vehicles WHERE user_id=? ORDER BY sort_order, created_at', [uid]);
  const [u] = await pool.query('SELECT cur_vehicle FROM users WHERE id=?', [uid]);
  const ids = vs.map(v => v.id);
  const hist = {}, parts = {}, logs = {}, panels = {}, plans = {};
  if (ids.length) {
    const [ps] = await pool.query('SELECT * FROM parts WHERE vehicle_id IN (?) ORDER BY vehicle_id, sort_order', [ids]);
    const [hs] = await pool.query('SELECT h.* FROM part_history h JOIN parts p ON p.id=h.part_id WHERE p.vehicle_id IN (?) ORDER BY h.part_id, h.done_date, h.id', [ids]);
    const [ls] = await pool.query('SELECT * FROM mileage_log WHERE vehicle_id IN (?) ORDER BY vehicle_id, log_date', [ids]);
    const [pc] = await pool.query('SELECT * FROM panel_changes WHERE vehicle_id IN (?) ORDER BY vehicle_id, change_date, id', [ids]);
    hs.forEach(h => (hist[h.part_id] = hist[h.part_id] || []).push({ d: h.done_date, km: h.km, cost: h.cost, note: h.note || '', x: parseX(h.details), ph: parseJ(h.photos) }));
    ps.forEach(p => (parts[p.vehicle_id] = parts[p.vehicle_id] || []).push({
      id: p.id, cat: p.category, name: p.name, km: p.interval_km, mo: p.interval_months,
      lastKm: p.last_km, lastDate: p.last_date, note: p.note || '', checks: parseJ(p.checks), hist: hist[p.id] || [] }));
    ls.forEach(l => (logs[l.vehicle_id] = logs[l.vehicle_id] || []).push({ d: l.log_date, odo: l.odo, trip: l.trip }));
    const [pl] = await pool.query('SELECT * FROM plans WHERE vehicle_id IN (?) ORDER BY vehicle_id, sort_order', [ids]);
    pl.forEach(q => (plans[q.vehicle_id] = plans[q.vehicle_id] || []).push({ id: q.id, itemId: q.item_id || '', title: q.title, url: q.url, price: q.price, note: q.note || '' }));
    pc.forEach(p => (panels[p.vehicle_id] = panels[p.vehicle_id] || []).push({ d: p.change_date, old: p.old_km, nw: p.new_km, at: p.true_km, note: p.note }));
  }
  return {
    cur: u[0] ? u[0].cur_vehicle : '',
    v: vs.map(v => ({
      id: v.id, name: v.name, type: v.type, buyDate: v.buy_date || '', buyKm: v.buy_km, price: v.buy_price, odo: v.odo, off: v.odo_offset, cc: v.currency,
      docs: { ins: { end: v.ins_end || '', note: v.ins_note }, ti: { end: v.ti_end || '', note: v.ti_note } },
      items: parts[v.id] || [], log: logs[v.id] || [], panels: panels[v.id] || [], plans: plans[v.id] || []
    }))
  };
}

async function putState(uid, s) {
  if (!s || !Array.isArray(s.v)) throw httpErr(400, 'bad state');
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const ids = s.v.map(v => T(v && v.id, 32)).filter(Boolean);
    if (ids.length) {
      const [own] = await c.query('SELECT id,user_id FROM vehicles WHERE id IN (?)', [ids]);
      if (own.some(r => r.user_id != null && r.user_id !== uid)) throw httpErr(409, 'Конфликт идентификаторов, обновите страницу');
      await c.query('DELETE FROM vehicles WHERE user_id=? AND id NOT IN (?)', [uid, ids]);
    } else await c.query('DELETE FROM vehicles WHERE user_id=?', [uid]);
    let order = 0;
    for (const v of s.v) {
      const id = T(v && v.id, 32); if (!id) continue;
      const d = v.docs || {}, ins = d.ins || {}, ti = d.ti || {};
      await c.query(
        `INSERT INTO vehicles(id,user_id,name,type,buy_date,buy_km,buy_price,odo,odo_offset,currency,ins_end,ins_note,ti_end,ti_note,sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),name=VALUES(name),type=VALUES(type),buy_date=VALUES(buy_date),buy_km=VALUES(buy_km),buy_price=VALUES(buy_price),
           odo=VALUES(odo),odo_offset=VALUES(odo_offset),currency=VALUES(currency),ins_end=VALUES(ins_end),ins_note=VALUES(ins_note),
           ti_end=VALUES(ti_end),ti_note=VALUES(ti_note),sort_order=VALUES(sort_order)`,
        [id, uid, T(v.name, 200) || 'Без названия', T(v.type, 16) || 'other', D(v.buyDate), I(v.buyKm), C(v.price), I(v.odo), I(v.off),
         T(v.cc, 8) || '¥', D(ins.end), T(ins.note, 500), D(ti.end), T(ti.note, 500), order++]);
      await c.query('DELETE FROM parts WHERE vehicle_id=?', [id]);          // история удаляется каскадом
      await c.query('DELETE FROM mileage_log WHERE vehicle_id=?', [id]);
      await c.query('DELETE FROM panel_changes WHERE vehicle_id=?', [id]);
      await c.query('DELETE FROM plans WHERE vehicle_id=?', [id]);

      const items = (Array.isArray(v.items) ? v.items : []).filter(it => it && T(it.id, 32));
      if (items.length) await c.query(
        'INSERT INTO parts(id,vehicle_id,category,name,interval_km,interval_months,last_km,last_date,note,checks,sort_order) VALUES ?',
        [items.map((it, i) => [T(it.id, 32), id, T(it.cat, 120) || 'Прочее', T(it.name, 200), I(it.km), I(it.mo),
                               IN(it.lastKm), D(it.lastDate), T(it.note, 4000), CKJ(it.checks), i])]);
      const hrows = [];
      items.forEach(it => (Array.isArray(it.hist) ? it.hist : []).forEach(h =>
        hrows.push([T(it.id, 32), D(h.d), IN(h.km), C(h.cost), T(h.note, 4000), X(h.x), PHJ(h.ph)])));
      if (hrows.length) await c.query('INSERT INTO part_history(part_id,done_date,km,cost,note,details,photos) VALUES ?', [hrows]);

      const log = new Map();
      (Array.isArray(v.log) ? v.log : []).forEach(e => { if (e && D(e.d)) log.set(e.d, [id, e.d, I(e.odo), IN(e.trip)]); });
      if (log.size) await c.query('INSERT INTO mileage_log(vehicle_id,log_date,odo,trip) VALUES ?', [[...log.values()]]);
      const pcs = (Array.isArray(v.panels) ? v.panels : []).map(p => [id, D(p.d), I(p.old), I(p.nw), I(p.at), T(p.note, 500)]);
      const pls = (Array.isArray(v.plans) ? v.plans : []).filter(q => q && T(q.id, 32)).map((q, i) => [T(q.id, 32), id, T(q.itemId, 32) || null, T(q.title, 200), T(q.url, 1000), C(q.price), T(q.note, 4000), i]);
      if (pls.length) await c.query('INSERT INTO plans(id,vehicle_id,item_id,title,url,price,note,sort_order) VALUES ?', [pls]);
      if (pcs.length) await c.query('INSERT INTO panel_changes(vehicle_id,change_date,old_km,new_km,true_km,note) VALUES ?', [pcs]);
    }
    await c.query('UPDATE users SET cur_vehicle=? WHERE id=?', [T(s.cur, 32), uid]);
    await c.commit();
    const refs = [];   // удаляем старые неиспользуемые фото (младше суток не трогаем: их могли только что загрузить)
    s.v.forEach(v => (v.items || []).forEach(it => (it.hist || []).forEach(h => (Array.isArray(h.ph) ? h.ph : []).forEach(i => { if (/^[a-f0-9]{16,32}$/.test(i)) refs.push(i); }))));
    if (refs.length) await pool.query('DELETE FROM photos WHERE user_id=? AND created_at < DATE_SUB(NOW(), INTERVAL 1 DAY) AND id NOT IN (?)', [uid, refs]);
    else await pool.query('DELETE FROM photos WHERE user_id=? AND created_at < DATE_SUB(NOW(), INTERVAL 1 DAY)', [uid]);
  } catch (e) {
    try { await c.rollback(); } catch (_) {}
    throw e;
  } finally { c.release(); }
}

let chain = Promise.resolve();
const run = fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, fail) => {
  let b = '', n = 0;
  req.on('data', ch => { n += ch.length; if (n > 8e6) { fail(httpErr(413, 'Слишком большой запрос')); req.destroy(); } else b += ch; });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (_) { fail(httpErr(400, 'Некорректный JSON')); } });
  req.on('error', fail);
});
const readRaw = (req, max) => new Promise((ok, fail) => {
  const parts = []; let n = 0;
  req.on('data', ch => { n += ch.length; if (n > max) { fail(httpErr(413, 'Файл слишком большой')); req.destroy(); } else parts.push(ch); });
  req.on('end', () => ok(Buffer.concat(parts))); req.on('error', fail);
});
const STATIC = {
  '/i18n.js': ['i18n.js', 'application/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'application/javascript; charset=utf-8'],
  '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'], '/icon.svg': ['icon.svg', 'image/svg+xml']
};
const INDEX = path.join(__dirname, 'public', 'index.html');

async function route(req, res) {
  const u = req.url.split('?')[0], m = req.method;
  if (u === '/api/health') return json(res, 200, { ok: true, ready });
  if (u === '/api/status') {
    const user = await userOf(req);
    let hasUsers = false;
    if (ready) { const [r] = await pool.query('SELECT COUNT(*) n FROM users'); hasUsers = r[0].n > 0; }
    return json(res, 200, {
      configured: !!cfg, ready, connecting, error: lastError, hasUsers, user,
      defaults: { host: ENV.host, port: ENV.port, user: ENV.user, database: ENV.database },
      current: cfg ? { host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, builtin: !!cfg.builtin } : null
    });
  }
  if (m === 'POST' && u.startsWith('/api/setup/')) {
    await canSetup(req);
    const c = cleanCfg(await readBody(req)), act = u.slice(11);
    try {
      if (act === 'test') return json(res, 200, { ok: true, ...(await testConn(c)) });
      if (act === 'create-db') { await createDb(c); return json(res, 200, { ok: true }); }
      if (act === 'save') { await activate(c); return json(res, 200, { ok: true }); }
    } catch (e) { return json(res, 400, { error: errMsg(e) }); }
    return json(res, 404, { error: 'not found' });
  }
  if (m === 'POST' && u === '/api/auth/register') {
    if (!ready) throw httpErr(503, 'База данных не подключена');
    const b = await readBody(req), login = String(b.login || '').trim(), pw = String(b.password || '');
    if (login.length < 3 || login.length > 64) throw httpErr(400, 'Логин: от 3 до 64 символов');
    if (pw.length < 6) throw httpErr(400, 'Пароль: не короче 6 символов');
    const [cnt] = await pool.query('SELECT COUNT(*) n FROM users');
    const first = cnt[0].n === 0;
    try {
      const lang = ['ru', 'en', 'uk', 'ja'].includes(b.lang) ? b.lang : '';
      const [r] = await pool.query('INSERT INTO users(login,pass_hash,is_admin,lang) VALUES (?,?,?,?)', [login, hashPw(pw), first ? 1 : 0, lang]);
      if (first) await pool.query('UPDATE vehicles SET user_id=? WHERE user_id IS NULL', [r.insertId]); // данные версии 1.0
      await newSession(res, r.insertId);
      return json(res, 200, { user: { id: r.insertId, login, admin: first, lang } });
    } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw httpErr(409, 'Такой логин уже занят'); throw e; }
  }
  if (m === 'POST' && u === '/api/auth/login') {
    if (!ready) throw httpErr(503, 'База данных не подключена');
    const b = await readBody(req), login = String(b.login || '').trim(), key = login.toLowerCase(), f = fails.get(key);
    if (f && f.until > Date.now()) throw httpErr(429, 'Слишком много попыток, подождите минуту');
    const [r] = await pool.query('SELECT * FROM users WHERE login=?', [login]);
    if (!r[0] || !checkPw(String(b.password || ''), r[0].pass_hash)) {
      const n = (f ? f.n : 0) + 1; fails.set(key, { n, until: n >= 5 ? Date.now() + 60000 : 0 });
      throw httpErr(401, 'Неверный логин или пароль');
    }
    fails.delete(key);
    await newSession(res, r[0].id);
    return json(res, 200, { user: { id: r[0].id, login: r[0].login, admin: !!r[0].is_admin, lang: r[0].lang } });
  }
  if (m === 'POST' && u === '/api/auth/logout') {
    const t = tokenOf(req);
    if (t && ready) await pool.query('DELETE FROM sessions WHERE token_hash=?', [sha(t)]);
    res.setHeader('Set-Cookie', 'gt=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }
  if (m === 'POST' && u === '/api/auth/lang') {
    const user = await needUser(req), b = await readBody(req);
    if (['ru', 'en', 'uk', 'ja'].includes(b.lang)) await pool.query('UPDATE users SET lang=? WHERE id=?', [b.lang, user.id]);
    return json(res, 200, { ok: true });
  }
  if (m === 'POST' && u === '/api/photo') {
    if (!ready) throw httpErr(503, 'База данных не подключена');
    const user = await needUser(req), mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw httpErr(415, 'Нужно изображение JPEG, PNG или WebP');
    const buf = await readRaw(req, 8e6);
    if (!buf.length) throw httpErr(400, 'Пустой файл');
    const id = crypto.randomBytes(12).toString('hex');
    await pool.query('INSERT INTO photos(id,user_id,mime,data) VALUES (?,?,?,?)', [id, user.id, mime, buf]);
    return json(res, 200, { id });
  }
  const pm = /^\/api\/photo\/([a-f0-9]{16,32})$/.exec(u);
  if (m === 'GET' && pm) {
    if (!ready) throw httpErr(503, 'База данных не подключена');
    const user = await needUser(req);
    const [r] = await pool.query('SELECT mime,data FROM photos WHERE id=? AND user_id=?', [pm[1], user.id]);
    if (!r[0]) throw httpErr(404, 'Фото не найдено');
    res.writeHead(200, { 'Content-Type': r[0].mime, 'Cache-Control': 'private, max-age=31536000, immutable' });
    return res.end(r[0].data);
  }
  if (STATIC[u]) {
    const f = path.join(__dirname, 'public', STATIC[u][0]);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': STATIC[u][1], 'Cache-Control': STATIC[u][1].startsWith('image/png') ? 'public, max-age=86400' : 'no-cache' });
    return fs.createReadStream(f).pipe(res);
  }
  if (u === '/api/state') {
    if (!ready) throw httpErr(503, 'База данных не подключена');
    const user = await needUser(req);
    if (m === 'GET') return json(res, 200, await getState(user.id));
    if (m === 'PUT') { const data = await readBody(req); await run(() => putState(user.id, data)); return json(res, 200, { ok: true }); }
    throw httpErr(405, 'method not allowed');
  }
  if (u === '/' || u === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(INDEX).pipe(res);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
}

http.createServer((req, res) => {
  route(req, res).catch(e => { if (!e.status) console.error(e); if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : errMsg(e) }); });
}).listen(PORT, '0.0.0.0', () => console.log('Listening on', PORT));

if (cfg) connectLoop();
const stop = () => { (pool ? pool.end() : Promise.resolve()).finally(() => process.exit(0)); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
