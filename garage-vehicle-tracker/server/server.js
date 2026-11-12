'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), vm = require('vm'), zlib = require('zlib'), mysql = require('mysql2/promise');

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS settings(
  k VARCHAR(50) NOT NULL PRIMARY KEY,
  v TEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS checklists(
  id VARCHAR(32) NOT NULL PRIMARY KEY,
  user_id INT NOT NULL,
  vehicle_id VARCHAR(32) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  pin_hash CHAR(64) NOT NULL,
  lang VARCHAR(5) NOT NULL DEFAULT 'en',
  status VARCHAR(10) NOT NULL DEFAULT 'open',
  fails INT NOT NULL DEFAULT 0,
  snapshot MEDIUMTEXT NULL,
  entries MEDIUMTEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  UNIQUE KEY uq_cl_token (token_hash),
  INDEX idx_cl_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS push_subs(
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  ep_hash CHAR(64) NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh VARCHAR(200) NOT NULL,
  auth VARCHAR(100) NOT NULL,
  ua VARCHAR(200) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_push_ep (ep_hash),
  INDEX idx_push_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS custom_items(
  id VARCHAR(32) NOT NULL PRIMARY KEY,
  vtype VARCHAR(16) NOT NULL,
  category VARCHAR(120) NOT NULL,
  names TEXT NOT NULL,
  km INT NOT NULL DEFAULT 0,
  mo INT NOT NULL DEFAULT 0,
  archived TINYINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ci_type (vtype)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS checklist_requests(
  id VARCHAR(24) NOT NULL PRIMARY KEY,
  checklist_id VARCHAR(32) NOT NULL,
  user_id INT NOT NULL,
  kind VARCHAR(8) NOT NULL,
  item_key VARCHAR(40) NOT NULL DEFAULT '',
  name VARCHAR(200) NOT NULL DEFAULT '',
  cat VARCHAR(120) NOT NULL DEFAULT '',
  price DECIMAL(12,2) NULL,
  note TEXT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'pending',
  owner_note VARCHAR(300) NOT NULL DEFAULT '',
  pushed TINYINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at DATETIME NULL,
  INDEX idx_req_cl (checklist_id),
  INDEX idx_req_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS support_msgs(
  id VARCHAR(24) NOT NULL PRIMARY KEY,
  user_id INT NOT NULL,
  subject VARCHAR(120) NOT NULL DEFAULT '',
  body TEXT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'new',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sup_user (user_id),
  INDEX idx_sup_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS shop_ratings(
  id VARCHAR(24) NOT NULL PRIMARY KEY,
  user_id INT NOT NULL,
  checklist_id VARCHAR(32) NOT NULL,
  shop_link VARCHAR(500) NOT NULL DEFAULT '',
  mood TINYINT NOT NULL,
  comment TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rate_cl (checklist_id),
  INDEX idx_rate_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS admin_log(
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  admin_id INT NOT NULL,
  action VARCHAR(60) NOT NULL,
  target VARCHAR(200) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_log_time (created_at)
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
  await addCol(p, 'vehicles', 'unit', "VARCHAR(2) NOT NULL DEFAULT 'km'");
  await addCol(p, 'parts', 'checks', 'TEXT NULL');
  await addCol(p, 'part_history', 'photos', 'TEXT NULL');
  await addCol(p, 'users', 'lang', "VARCHAR(5) NOT NULL DEFAULT ''");
  await addCol(p, 'users', 'push_on', 'TINYINT NOT NULL DEFAULT 1');
  await addCol(p, 'users', 'push_days', "VARCHAR(20) NOT NULL DEFAULT '1,4'");
  await addCol(p, 'users', 'push_hour', 'TINYINT NOT NULL DEFAULT 9');
  await addCol(p, 'users', 'push_tz', "VARCHAR(60) NOT NULL DEFAULT 'UTC'");
  await addCol(p, 'users', 'push_last', 'DATE NULL');
  await addCol(p, 'users', 'push_docs', 'DATE NULL');
  await addCol(p, 'users', 'push_mode', "VARCHAR(8) NOT NULL DEFAULT 'weekly'");
  await addCol(p, 'users', 'push_mdays', "VARCHAR(120) NOT NULL DEFAULT ''");
  await addCol(p, 'parts', 'important', 'TINYINT NULL');
  await addCol(p, 'vehicles', 'eng', 'INT NULL');
  await addCol(p, 'vehicles', 'plate', "VARCHAR(20) NOT NULL DEFAULT ''");
  await addCol(p, 'vehicles', 'frame', "VARCHAR(40) NOT NULL DEFAULT ''");
  await addCol(p, 'vehicles', 'ti_last', 'DATE NULL');
  await addCol(p, 'users', 'last_login', 'DATETIME NULL');
  await addCol(p, 'users', 'display_name', "VARCHAR(60) NOT NULL DEFAULT ''");
  await addCol(p, 'users', 'avatar', "VARCHAR(20) NOT NULL DEFAULT ''");
  await addCol(p, 'users', 'blocked', 'TINYINT NOT NULL DEFAULT 0');
  await addCol(p, 'support_msgs', 'from_admin', 'TINYINT NOT NULL DEFAULT 0');
  await addCol(p, 'support_msgs', 'seen', 'TINYINT NOT NULL DEFAULT 0');
  await addCol(p, 'users', 'push_req_hour', "VARCHAR(16) NOT NULL DEFAULT ''");
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
      pool = p; ready = true; connecting = false; lastError = ''; console.log('Database ready'); afterReady(); return;
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
  afterReady();
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
  await pool.query('UPDATE users SET last_login=NOW() WHERE id=?', [uid]);
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

// ================= настройки, push, чек-листы мастера =================
let SET = {}
const LIM = () => ({ perDay: SET.msg_per_day !== undefined ? +SET.msg_per_day : 3, gap: SET.msg_gap_min !== undefined ? +SET.msg_gap_min : 10,
  open: SET.msg_open_max !== undefined ? +SET.msg_open_max : 5, ratingsOn: SET.ratings_on !== '0', minComment: +(SET.rating_min_comment || 0) });
const logAdmin = (adminId, action, target) => pool.query('INSERT INTO admin_log(admin_id,action,target) VALUES (?,?,?)', [adminId, action, String(target || '').slice(0, 200)]).catch(() => {});
const MOODS = [1, 2, 3];
function shopLinkOf(ent) {
  for (const e of Object.values(ent || {})) {
    if (e && e.review === 'accepted' && e.note) { const x = /https?:\/\/[^\s]+/.exec(e.note); if (x) return x[0].slice(0, 500); }
  }
  return '';
}
let webpush = null, tickStarted = false, I18N_TR = null;
async function loadSettings() { const [r] = await pool.query('SELECT k,v FROM settings'); SET = {}; r.forEach(x => { SET[x.k] = x.v; }); }
async function setSetting(k, v) { await pool.query('INSERT INTO settings(k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)', [k, String(v)]); SET[k] = String(v); }
const ipOf = req => String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '');
function trName(s, lang) {   // переводы названий деталей берём из i18n.js
  if (!I18N_TR) {
    try {
      const sb = { window: {}, document: { documentElement: {}, body: {} }, navigator: { language: 'en' }, localStorage: { getItem() { return null; }, setItem() {} }, console };
      vm.createContext(sb);
      vm.runInContext(fs.readFileSync(path.join(__dirname, 'public', 'i18n.js'), 'utf8') + ';this.trName=trName;', sb);
      I18N_TR = sb.trName;
    } catch (e) { I18N_TR = s2 => s2; }
  }
  return I18N_TR(s, lang === 'ru' ? 'ru' : lang);
}
const SRV = {
  ru: { over: 'просрочено', soon: 'скоро', left: n => `осталось ${n} дн.`, overd: n => `просрочено на ${n} дн.`, ins: 'Страховка', ti: 'Техосмотр', more: n => `…и ещё ${n}`, tire: a => `возраст шины ${a} г.`, test: 'Уведомления работают', done: v => `Мастер закончил работу: ${v}. Откройте приложение и подтвердите.` },
  en: { over: 'overdue', soon: 'due soon', left: n => `${n} d left`, overd: n => `overdue by ${n} d`, ins: 'Insurance', ti: 'Inspection', more: n => `…and ${n} more`, tire: a => `tyre age ${a} y`, test: 'Notifications are working', done: v => `The mechanic finished the work: ${v}. Open the app to review.` },
  uk: { over: 'прострочено', soon: 'незабаром', left: n => `залишилось ${n} дн.`, overd: n => `прострочено на ${n} дн.`, ins: 'Страховка', ti: 'Техогляд', more: n => `…і ще ${n}`, tire: a => `вік шини ${a} р.`, test: 'Сповіщення працюють', done: v => `Майстер завершив роботу: ${v}. Відкрийте застосунок і підтвердьте.` },
  ja: { over: '期限超過', soon: 'まもなく', left: n => `残り${n}日`, overd: n => `${n}日超過`, ins: '保険', ti: '車検・点検', more: n => `…ほか${n}件`, tire: a => `タイヤの経年${a}年`, test: '通知は正常に動作しています', done: v => `整備士が作業を完了しました：${v}。アプリを開いて確認してください。` }
};
const addMonthsStr = (d, m) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };
const IMPORTANT_RX = /масл|фильтр|свеч|грм|тормозная жидкость|тормозные шланги|антифриз|аккумулятор|шин[аы]|крыльчатка|ремень вариатора|приводной ремень|колодк|стоячий такелаж|огнетушител|сигнальные/i;
function ratioOf(p, odo) {
  let ak = 0, am = 0; parseJ(p.checks).forEach(c => { ak += c.ak || 0; am += c.am || 0; });
  const km = p.interval_km ? p.interval_km + ak : 0, mo = p.interval_months ? p.interval_months + am : 0;
  if (p.last_km == null && !p.last_date) return null;
  if (!km && !mo) return null;
  let r = 0;
  if (km && p.last_km != null) r = (odo - p.last_km) / km;
  if (mo && p.last_date) r = Math.max(r, (Date.now() - Date.parse(p.last_date)) / 2629800000 / mo);
  return r;
}
function tireAgeOf(name, details) {
  if (!/шин[аы]/i.test(name)) return null;
  const d = String((parseX(details) || {}).dot || '').replace(/\D/g, '').slice(-4);
  if (d.length < 4) return null;
  const wk = +d.slice(0, 2), yr = 2000 + (+d.slice(2));
  if (wk < 1 || wk > 53) return null;
  return (Date.now() - Date.UTC(yr, 0, 1 + 7 * (wk - 1))) / 31557600000;
}
async function digestFor(uid, lang, today, inclDocs, minR = 0.9) {
  const T = SRV[lang] || SRV.en;
  const cr = (await pool.query('SELECT names FROM custom_items'))[0];
  const CN = {}; cr.forEach(x => { const n = parseObj(x.names); if (n.ru) CN[n.ru] = n; });
  const nameOf = (s2, l) => (CN[s2] ? (CN[s2][l] || CN[s2].ru) : trName(s2, l));
  const [vs] = await pool.query('SELECT id,name,odo,ins_end,ti_end FROM vehicles WHERE user_id=? ORDER BY sort_order', [uid]);
  if (!vs.length) return { lines: [], docs: false };
  const ids = vs.map(v => v.id);
  const [ps] = await pool.query('SELECT p.*,(SELECT h.details FROM part_history h WHERE h.part_id=p.id ORDER BY h.done_date DESC,h.id DESC LIMIT 1) AS lastdet FROM parts p WHERE p.vehicle_id IN (?)', [ids]);
  const rows = []; let docs = false;
  vs.forEach(v => {
    ps.filter(p => p.vehicle_id === v.id).forEach(p => {
      const imp = p.important === 1 ? true : p.important === 0 ? false : IMPORTANT_RX.test(p.name);
      if (!imp) return;
      let r = ratioOf(p, v.odo); const age = tireAgeOf(p.name, p.lastdet);
      if (age != null && age >= 5) r = Math.max(r == null ? 0 : r, age >= 6 ? 1 : 0.9);
      if (r == null || r < minR) return;
      rows.push({ r, text: `${v.name}: ${nameOf(p.name, lang)} — ${r >= 1 ? T.over : T.soon}${age != null && age >= 5 ? ' (' + T.tire(age.toFixed(1)) + ')' : ''}` });
    });
    if (inclDocs) [['ins', v.ins_end], ['ti', v.ti_end]].forEach(([k, end]) => {
      if (!end || end > addMonthsStr(today, 3)) return;
      const n = Math.round((Date.parse(end) - Date.parse(today)) / 864e5); docs = true;
      rows.push({ r: 5, text: `${v.name}: ${T[k]} — ${n < 0 ? T.overd(-n) : T.left(n)}` });
    });
  });
  rows.sort((a, b) => b.r - a.r);
  const lines = rows.slice(0, 6).map(x => x.text);
  if (rows.length > 6) lines.push(T.more(rows.length - 6));
  return { lines, docs };
}
function localParts(tz) {
  const mk = z => new Intl.DateTimeFormat('en-GB', { timeZone: z, weekday: 'short', hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' });
  let f; try { f = mk(tz || 'UTC'); } catch (e) { f = mk('UTC'); }
  const p = {}; f.formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, dow: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday], hour: +p.hour };
}
async function sendPush(uid, payload) {
  if (!webpush) return 0;
  const [subs] = await pool.query('SELECT * FROM push_subs WHERE user_id=?', [uid]);
  let n = 0;
  for (const s of subs) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 86400 }); n++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await pool.query('DELETE FROM push_subs WHERE id=?', [s.id]); else console.log('push error', e.statusCode || e.message); }
  }
  return n;
}
async function digestTick() {
  if (!ready || !webpush) return;
  const [us] = await pool.query('SELECT u.id,u.lang,u.push_mode,u.push_days,u.push_mdays,u.push_hour,u.push_tz,u.push_last,u.push_docs FROM users u WHERE u.push_on=1 AND EXISTS(SELECT 1 FROM push_subs s WHERE s.user_id=u.id)');
  for (const u of us) {
    try {
      const lt = localParts(u.push_tz);
      if (u.push_last === lt.date) continue;
      const monthly = u.push_mode === 'monthly';
      if (monthly) { if (!String(u.push_mdays || '').split(',').includes(String(+lt.date.slice(8)))) continue; }
      else if (!String(u.push_days || '').split(',').includes(String(lt.dow))) continue;
      if (lt.hour < u.push_hour || lt.hour > u.push_hour + 4) continue;
      const inclDocs = !u.push_docs || (Date.parse(lt.date) - Date.parse(u.push_docs)) / 864e5 >= 6.5;
      const d = await digestFor(u.id, u.lang || 'en', lt.date, inclDocs, monthly ? 1 : 0.9);
      if (inclDocs && d.docs) await pool.query('UPDATE users SET push_last=?, push_docs=? WHERE id=?', [lt.date, lt.date, u.id]);
      else await pool.query('UPDATE users SET push_last=? WHERE id=?', [lt.date, u.id]);
      if (d.lines.length) await sendPush(u.id, { title: 'Garage Journal', body: d.lines.join('\n'), url: './', tag: 'digest' });
    } catch (e) { console.log('digest error', e.message); }
  }
}
async function initPush() {
  try { webpush = require('web-push'); } catch (e) { console.log('web-push is not installed'); return; }
  if (!SET.vapid_pub || !SET.vapid_priv) { const k = webpush.generateVAPIDKeys(); await setSetting('vapid_pub', k.publicKey); await setSetting('vapid_priv', k.privateKey); }
  webpush.setVapidDetails(SET.public_url && SET.public_url.startsWith('https') ? SET.public_url : 'mailto:garage@example.com', SET.vapid_pub, SET.vapid_priv);
}
async function afterReady() {
  try {
    await loadSettings(); await initPush();
    if (!tickStarted) { tickStarted = true; setInterval(() => { digestTick().catch(e => console.log(e.message)); reqTick().catch(() => {}); }, 10 * 60 * 1000); setTimeout(() => digestTick().catch(() => {}), 20000); }
  } catch (e) { console.log('afterReady', e.message); }
}
// ---- чек-листы для мастера ----
const KEY_RX = /^[A-Za-z0-9_-]{1,32}$/, PH_RX = /^[a-f0-9]{16,32}$/;
const nm4=x=>{if(!x||typeof x!=='object')return null;const o={};['ru','en','uk','ja'].forEach(k=>{const v=T(x[k],200).trim();if(v)o[k]=v});return Object.keys(o).length?o:null};
const VT=['moto','car','moped','boat','sail','jet','other'];
async function catalogRows(all){
  const [r]=await pool.query(all?'SELECT * FROM custom_items ORDER BY created_at':'SELECT * FROM custom_items WHERE archived=0 ORDER BY created_at');
  return r.map(x=>({id:x.id,vtype:x.vtype,cat:x.category,names:parseObj(x.names),km:x.km,mo:x.mo,archived:!!x.archived}));
}
function cleanSnapshot(s, lang) {
  s = s || {}; const v = s.vehicle || {};
  return {
    lang: ['ru', 'en', 'uk', 'ja'].includes(lang) ? lang : 'en',
    vehicle: { name: T(v.name, 200), type: T(v.type, 16), odo: I(v.odo), unit: ['km', 'mi', 'h'].includes(v.unit) ? v.unit : 'km', cc: T(v.cc, 8) },
    note: T(s.note, 1500), date: D(s.date) || new Date().toISOString().slice(0, 10),
    items: (Array.isArray(s.items) ? s.items : []).slice(0, 150).filter(it => it && KEY_RX.test(String(it.key))).map(it => ({
      key: String(it.key), name: T(it.name, 200), cat: T(it.cat, 120), kind: ['must', 'opt', 'nod', 'extra', 'custom'].includes(it.kind) ? it.kind : 'extra',
      why: T(it.why, 400), prev: T(it.prev, 300), names: nm4(it.names),
      ex: (Array.isArray(it.ex) ? it.ex : []).slice(0, 8).filter(e => e && /^[a-z]{1,12}$/.test(String(e.k))).map(e => ({ k: String(e.k), label: T(e.label, 60), ph: T(e.ph, 40) }))
    }))
  };
}
function cleanEntry(e, snap) {
  e = e || {};
  const x = {}; Object.keys(e.x && typeof e.x === 'object' ? e.x : {}).slice(0, 12).forEach(k => { const v = T(e.x[k], 200).trim(); if (v && /^[a-z]{1,12}$/.test(k)) x[k] = v; });
  return {
    state: ['done', 'skip'].includes(e.state) ? e.state : '', date: D(e.date) || '', km: IN(e.km), cost: C(e.cost), x, note: T(e.note, 2000).trim(),
    ph: (Array.isArray(e.ph) ? e.ph : []).filter(i => PH_RX.test(String(i))).slice(0, 10), review: 'pending'
  };
}
async function masterLoad(token, pin, needOpen) {
  if (!/^[a-f0-9]{24}$/.test(String(token))) throw httpErr(404, 'Ссылка не найдена');
  const [r] = await pool.query('SELECT * FROM checklists WHERE token_hash=?', [sha(token)]);
  const c = r[0]; if (!c) throw httpErr(404, 'Ссылка не найдена');
  if (['closed', 'accepted'].includes(c.status)) return { c, closed: true };
  if (c.fails >= 5) throw httpErr(423, 'Слишком много попыток: ссылка заблокирована');
  if (sha(token + ':' + String(pin || '')) !== c.pin_hash) {
    await pool.query('UPDATE checklists SET fails=fails+1 WHERE id=?', [c.id]);
    const e = httpErr(401, 'Неверный PIN-код'); e.left = Math.max(0, 4 - c.fails); throw e;
  }
  if (c.fails) await pool.query('UPDATE checklists SET fails=0 WHERE id=?', [c.id]);
  if (needOpen && c.status !== 'open') throw httpErr(409, 'Работа уже отправлена владельцу');
  return { c, closed: false };
}
const parseObj = s => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; } };

const SRV2 = {
  ru: { free: n => `Мастер изменил пункт (бесплатно): ${n}. Откройте приложение и подтвердите.`, hourly: n => `Мастер ждёт вашего ответа по работам: ${n}. Откройте приложение.` },
  en: { free: n => `The mechanic changed an item (free): ${n}. Open the app to confirm.`, hourly: n => `The mechanic is waiting for your reply on ${n} request(s). Open the app.` },
  uk: { free: n => `Майстер змінив пункт (безкоштовно): ${n}. Відкрийте застосунок і підтвердьте.`, hourly: n => `Майстер чекає вашої відповіді за роботами: ${n}. Відкрийте застосунок.` },
  ja: { free: n => `整備士が項目を変更しました（無料）：${n}。アプリで確認してください。`, hourly: n => `整備士があなたの回答を待っています（${n}件）。アプリを開いてください。` }
};
async function reqPushOne(rid) {
  const [r] = await pool.query('SELECT q.name,q.user_id,u.lang,u.push_on FROM checklist_requests q JOIN users u ON u.id=q.user_id WHERE q.id=?', [rid]);
  if (!r[0]) return;
  await pool.query('UPDATE checklist_requests SET pushed=1 WHERE id=?', [rid]);
  if (!r[0].push_on) return;
  const L = SRV2[r[0].lang] || SRV2.en;
  await sendPush(r[0].user_id, { title: 'Garage Journal', body: L.free(r[0].name), url: './', tag: 'req-' + rid });
}
async function reqTick() {
  if (!ready || !webpush) return;
  const [us] = await pool.query("SELECT DISTINCT u.id,u.lang,u.push_tz,u.push_req_hour FROM users u JOIN checklist_requests q ON q.user_id=u.id WHERE u.push_on=1 AND q.status='pending' AND q.price>0 AND EXISTS(SELECT 1 FROM push_subs s WHERE s.user_id=u.id)");
  for (const u of us) {
    try {
      const lt = localParts(u.push_tz), key = lt.date + ' ' + lt.hour;
      if (lt.hour < 9 || lt.hour > 18 || u.push_req_hour === key) continue;
      const [c] = await pool.query("SELECT COUNT(*) n FROM checklist_requests WHERE user_id=? AND status='pending' AND price>0", [u.id]);
      const L = SRV2[u.lang] || SRV2.en;
      await sendPush(u.id, { title: 'Garage Journal', body: L.hourly(c[0].n), url: './', tag: 'reqh' });
      await pool.query('UPDATE users SET push_req_hour=? WHERE id=?', [key, u.id]);
    } catch (e) { console.log('req tick', e.message); }
  }
}

async function route2(req, res, u, m) {
  // страница мастера
  if (m === 'GET' && /^\/m\/[a-f0-9]{24}$/.test(u)) {
    sendFile(req, res, path.join(__dirname, 'public', 'master.html'), 'text/html; charset=utf-8', 'no-cache', { 'Referrer-Policy': 'no-referrer' }); return true;
  }
  const mm = /^\/api\/m\/([a-f0-9]{24})\/(info|open|entry|finish|photo|remove|add)(?:\/([a-f0-9]{16,32}))?$/.exec(u);
  if (mm) {
    if (!ready) throw httpErr(503, 'База данных не подключена');
    const token = mm[1], act = mm[2];
    if (act === 'info') {
      const [r] = await pool.query('SELECT c.status, v.name, v.type FROM checklists c JOIN vehicles v ON v.id=c.vehicle_id WHERE c.token_hash=?', [sha(token)]);
      if (!r[0]) throw httpErr(404, 'Ссылка не найдена');
      json(res, 200, { name: r[0].name, type: r[0].type, status: r[0].status }); return true;
    }
    if (act === 'photo' && m === 'GET') {
      const { c, closed } = await masterLoad(token, req.headers['x-pin'], false);
      if (closed) throw httpErr(410, 'Ссылка закрыта');
      const [p] = await pool.query('SELECT mime,data FROM photos WHERE id=? AND user_id=? AND created_at>=?', [mm[3] || '', c.user_id, c.created_at]);
      if (!p[0]) throw httpErr(404, 'Фото не найдено');
      res.writeHead(200, { 'Content-Type': p[0].mime, 'Cache-Control': 'private, max-age=3600' }); res.end(p[0].data); return true;
    }
    if (act === 'photo' && m === 'POST') {
      const { c, closed } = await masterLoad(token, req.headers['x-pin'], true);
      if (closed) throw httpErr(410, 'Ссылка закрыта');
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw httpErr(415, 'Нужно изображение');
      const [cnt] = await pool.query('SELECT COUNT(*) n FROM photos WHERE user_id=? AND created_at>=?', [c.user_id, c.created_at]);
      if (cnt[0].n >= 60) throw httpErr(429, 'Слишком много фото');
      const buf = await readRaw(req, 8e6); if (!buf.length) throw httpErr(400, 'Пустой файл');
      const id = crypto.randomBytes(12).toString('hex');
      await pool.query('INSERT INTO photos(id,user_id,mime,data) VALUES (?,?,?,?)', [id, c.user_id, mime, buf]);
      json(res, 200, { id }); return true;
    }
    if (m !== 'POST') throw httpErr(405, 'method not allowed');
    const b = await readBody(req);
    const lockedOf = c => Object.values(parseObj(c.entries)).some(e => e && e.state === 'done');
    if (act === 'remove' || act === 'add') {
      const { c, closed } = await masterLoad(token, b.pin, true);
      if (closed) throw httpErr(410, 'Ссылка закрыта');
      const price = C(b.price), note = T(b.note, 2000).trim();
      if (price > 0 && !note) throw httpErr(400, 'Напишите комментарий: за платную работу нужно объяснение');
      const snap = parseObj(c.snapshot), ent = parseObj(c.entries);
      let kind, key = '', name, cat = 'Прочее';
      if (act === 'remove') {
        key = String(b.key || '');
        const it = (snap.items || []).find(i => i.key === key);
        if (!it) throw httpErr(400, 'Позиция не найдена');
        if (ent[key] && ent[key].state === 'done') throw httpErr(409, 'Работа уже отмечена как сделанная');
        kind = 'remove'; name = T(it.name, 200); cat = T(it.cat, 120) || 'Прочее';
      } else {
        name = T(b.item && b.item.name, 200).trim();
        if (!name) throw httpErr(400, 'Введите название');
        kind = 'add';
      }
      const id = crypto.randomBytes(12).toString('hex');
      await pool.query('INSERT INTO checklist_requests(id,checklist_id,user_id,kind,item_key,name,cat,price,note) VALUES (?,?,?,?,?,?,?,?,?)', [id, c.id, c.user_id, kind, key, name, cat, price, note]);
      if (!(price > 0)) reqPushOne(id).catch(() => {});
      json(res, 200, { ok: true, request: { id, kind, name, price, status: 'pending', note } }); return true;
    }
    if (act === 'open') {
      const { c, closed } = await masterLoad(token, b.pin, false);
      if (closed) { json(res, 200, { status: c.status }); return true; }
      const [vr] = await pool.query('SELECT name,type,eng,plate,frame,ti_last,ins_end FROM vehicles WHERE id=?', [c.vehicle_id]);
      const [rr] = await pool.query('SELECT id,kind,name,cat,price,note,status,owner_note FROM checklist_requests WHERE checklist_id=? ORDER BY created_at', [c.id]);
      json(res, 200, { status: c.status, snapshot: parseObj(c.snapshot), entries: parseObj(c.entries), requests: rr,
        vehicle: vr[0] ? { name: vr[0].name, type: vr[0].type, eng: vr[0].eng, plate: vr[0].plate || '', frame: vr[0].frame || '', tiLast: vr[0].ti_last, insEnd: vr[0].ins_end } : {} }); return true;
    }
    if (act === 'entry') {
      const { c, closed } = await masterLoad(token, b.pin, true);
      if (closed) throw httpErr(410, 'Ссылка закрыта');
      const snap = parseObj(c.snapshot), key = String(b.key || '');
      if (!(snap.items || []).some(i => i.key === key)) throw httpErr(400, 'Неизвестная позиция');
      if (b.entry && b.entry.state === 'skip' && !T(b.entry.note, 2000).trim()) throw httpErr(400, 'Напишите, почему работа не сделана');
      const ent = parseObj(c.entries); ent[key] = cleanEntry(b.entry, snap);
      await pool.query('UPDATE checklists SET entries=? WHERE id=?', [JSON.stringify(ent), c.id]);
      json(res, 200, { ok: true }); return true;
    }
    if (act === 'finish') {
      const { c, closed } = await masterLoad(token, b.pin, true);
      if (closed) throw httpErr(410, 'Ссылка закрыта');
      await pool.query("UPDATE checklists SET status='done', finished_at=NOW() WHERE id=?", [c.id]);
      const snap = parseObj(c.snapshot), [us] = await pool.query('SELECT lang,push_on FROM users WHERE id=?', [c.user_id]);
      const L = SRV[(us[0] && us[0].lang)] || SRV.en;
      if (us[0] && us[0].push_on) sendPush(c.user_id, { title: 'Garage Journal', body: L.done((snap.vehicle || {}).name || ''), url: './#inbox', tag: 'master' }).catch(() => {});
      json(res, 200, { ok: true }); return true;
    }
  }
  // настройки администратора
  if (u === '/api/admin/settings') {
    const user = await needUser(req); if (!user.admin) throw httpErr(403, 'Только администратор');
    if (m === 'GET') { json(res, 200, { publicUrl: SET.public_url || '', redirect: SET.redirect === '1', regOpen: SET.reg_open === '1' }); return true; }
    if (m === 'PUT') {
      const b = await readBody(req); let url = '';
      if (b.publicUrl) { try { const x = new URL(String(b.publicUrl).trim()); if (!/^https?:$/.test(x.protocol)) throw 0; url = x.origin; } catch (_) { throw httpErr(400, 'Некорректный адрес. Пример: https://auto.example.com'); } }
      await setSetting('public_url', url); await setSetting('redirect', b.redirect && url ? '1' : '0'); await setSetting('reg_open', b.regOpen ? '1' : '0');
      await initPush(); json(res, 200, { ok: true, publicUrl: url }); return true;
    }
  }
  // чек-листы владельца
  if (u === '/api/checklist' && m === 'POST') {
    const user = await needUser(req), b = await readBody(req);
    const [vv] = await pool.query('SELECT id FROM vehicles WHERE id=? AND user_id=?', [T(b.vehicleId, 32), user.id]);
    if (!vv[0]) throw httpErr(400, 'Транспорт не найден');
    const snap = cleanSnapshot(b.snapshot, b.lang);
    if (!snap.items.length) throw httpErr(400, 'Пустой чек-лист');
    const id = crypto.randomBytes(12).toString('hex'), token = crypto.randomBytes(12).toString('hex'), pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    await pool.query("UPDATE checklists SET status='closed' WHERE user_id=? AND vehicle_id=? AND status='open'", [user.id, vv[0].id]);
    await pool.query('INSERT INTO checklists(id,user_id,vehicle_id,token_hash,pin_hash,lang,status,snapshot,entries) VALUES (?,?,?,?,?,?,?,?,?)', [id, user.id, vv[0].id, sha(token), sha(token + ':' + pin), snap.lang, 'open', JSON.stringify(snap), '{}']);
    json(res, 200, { id, token, pin, publicUrl: SET.public_url || '' }); return true;
  }
  if (u === '/api/checklists' && m === 'GET') {
    const user = await needUser(req);
    const [r] = await pool.query('SELECT id,vehicle_id,status,created_at,finished_at,entries,snapshot FROM checklists WHERE user_id=? ORDER BY created_at DESC LIMIT 30', [user.id]);
    json(res, 200, r.map(c => { const e = parseObj(c.entries), s = parseObj(c.snapshot); return { id: c.id, vehicleId: c.vehicle_id, status: c.status, created: c.created_at, finished: c.finished_at, done: Object.values(e).filter(x => x.state === 'done').length, total: (s.items || []).length, vehicle: (s.vehicle || {}).name || '' }; })); return true;
  }
  const cm = /^\/api\/checklist\/([a-f0-9]{24})(?:\/(decide|edit))?$/.exec(u);
  if (cm) {
    const user = await needUser(req);
    const [r] = await pool.query('SELECT * FROM checklists WHERE id=? AND user_id=?', [cm[1], user.id]);
    const c = r[0]; if (!c) throw httpErr(404, 'Чек-лист не найден');
    if (m === 'POST' && cm[2] === 'edit') {
      const b = await readBody(req), ent = parseObj(c.entries), snap = parseObj(c.snapshot);
      if (c.status !== 'open') throw httpErr(409, 'Лист уже закрыт для изменений');
      if (Object.values(ent).some(e => e && e.state === 'done')) throw httpErr(409, 'Список зафиксирован: работа уже начата');
      snap.items = snap.items || [];
      if (b.remove) snap.items = snap.items.filter(i => i.key !== String(b.remove));
      if (b.add && T(b.add.name, 200).trim()) snap.items.push({ key: 'o' + crypto.randomBytes(4).toString('hex'), name: T(b.add.name, 200).trim(), names: null, cat: T(b.add.cat, 120) || 'Прочее', kind: 'custom', why: '', prev: '', ex: [] });
      await pool.query("UPDATE checklists SET snapshot=? WHERE id=?", [JSON.stringify(snap), c.id]);
      json(res, 200, { ok: true }); return true;
    }
    if (m === 'GET' && !cm[2]) { json(res, 200, { id: c.id, vehicleId: c.vehicle_id, status: c.status, finished: c.finished_at, snapshot: parseObj(c.snapshot), entries: parseObj(c.entries) }); return true; }
    if (m === 'POST' && cm[2] === 'decide') {
      const b = await readBody(req), ent = parseObj(c.entries);
      (Array.isArray(b.accepted) ? b.accepted : []).forEach(k => { if (ent[k]) ent[k].review = 'accepted'; });
      Object.keys(b.rejected && typeof b.rejected === 'object' ? b.rejected : {}).forEach(k => { if (ent[k]) { ent[k].review = 'rejected'; ent[k].ownerNote = T(b.rejected[k], 300); } });
      const status = b.action === 'reopen' ? 'open' : b.action === 'close' ? 'closed' : 'accepted';
      await pool.query('UPDATE checklists SET entries=?, status=?, fails=0 WHERE id=?', [JSON.stringify(ent), status, c.id]);
      json(res, 200, { ok: true, status }); return true;
    }
  }
  if (u === '/api/requests' && m === 'GET') {
    const user = await needUser(req);
    const [r] = await pool.query("SELECT q.id,q.kind,q.name,q.cat,q.price,q.note,q.created_at,c.id AS cid,c.vehicle_id,c.snapshot FROM checklist_requests q JOIN checklists c ON c.id=q.checklist_id WHERE q.user_id=? AND q.status='pending' ORDER BY q.created_at", [user.id]);
    json(res, 200, r.map(x => ({ id: x.id, kind: x.kind, name: x.name, cat: x.cat, price: x.price, note: x.note, created: x.created_at, checklistId: x.cid, vehicleId: x.vehicle_id, vehicleName: (parseObj(x.snapshot).vehicle || {}).name || '' }))); return true;
  }
  const rqm = /^\/api\/requests\/([a-f0-9]{24})$/.exec(u);
  if (rqm && m === 'POST') {
    const user = await needUser(req), b = await readBody(req);
    const [r] = await pool.query("SELECT q.*, c.snapshot, c.status AS cstatus FROM checklist_requests q JOIN checklists c ON c.id=q.checklist_id WHERE q.id=? AND q.user_id=?", [rqm[1], user.id]);
    const q = r[0]; if (!q) throw httpErr(404, 'Запрос не найден');
    if (q.status !== 'pending') throw httpErr(409, 'Запрос уже обработан');
    const ownerNote = T(b.ownerNote, 300);
    if (b.action === 'reject') {
      await pool.query("UPDATE checklist_requests SET status='rejected', owner_note=?, decided_at=NOW() WHERE id=?", [ownerNote, q.id]);
      json(res, 200, { ok: true, status: 'rejected' }); return true;
    }
    if (b.action !== 'accept') throw httpErr(400, 'Неизвестное действие');
    if (q.cstatus === 'closed') throw httpErr(409, 'Лист уже закрыт');
    const snap = parseObj(q.snapshot); snap.items = snap.items || [];
    if (q.kind === 'remove') {
      const before = snap.items.length; snap.items = snap.items.filter(i => i.key !== q.item_key);
      if (snap.items.length === before) throw httpErr(409, 'Позиция уже удалена из листа');
    } else {
      snap.items.push({ key: 'r' + q.id.slice(0, 10), name: q.name, names: null, cat: q.cat || 'Прочее', kind: 'custom', why: q.note || '', prev: '', ex: [] });
    }
    await pool.query("UPDATE checklists SET snapshot=? WHERE id=?", [JSON.stringify(snap), q.checklist_id]);
    await pool.query("UPDATE checklist_requests SET status='accepted', owner_note=?, decided_at=NOW() WHERE id=?", [ownerNote, q.id]);
    json(res, 200, { ok: true, status: 'accepted' }); return true;
  }
  // push
  if (u === '/api/push/key' && m === 'GET') { await needUser(req); json(res, 200, { enabled: !!webpush && !!SET.vapid_pub, publicKey: SET.vapid_pub || '' }); return true; }
  if (u === '/api/push/prefs') {
    const user = await needUser(req);
    if (m === 'GET') {
      const [r] = await pool.query('SELECT push_on,push_days,push_hour,push_tz,push_mode,push_mdays FROM users WHERE id=?', [user.id]);
      const [n] = await pool.query('SELECT COUNT(*) n FROM push_subs WHERE user_id=?', [user.id]);
      json(res, 200, { on: !!r[0].push_on, days: r[0].push_days, hour: r[0].push_hour, tz: r[0].push_tz, mode: r[0].push_mode, mdays: r[0].push_mdays, devices: n[0].n }); return true;
    }
    if (m === 'PUT') {
      const b = await readBody(req);
      const days = String(b.days || '').split(',').filter(d => /^[0-6]$/.test(d)).join(',') || '1,4';
      const mode = b.mode === 'monthly' ? 'monthly' : 'weekly';
      const mdays = [...new Set(String(b.mdays || '').split(',').map(x => +x).filter(x => x >= 1 && x <= 31))].sort((a, b2) => a - b2);
      if (mode === 'monthly' && (!mdays.length || mdays.length > 4)) throw httpErr(400, 'Выберите от 1 до 4 чисел месяца');
      await pool.query("UPDATE users SET push_on=?, push_mode=?, push_days=?, push_mdays=?, push_hour=?, push_tz=COALESCE(NULLIF(?,''),push_tz) WHERE id=?", [b.on ? 1 : 0, mode, days, mdays.join(','), Math.min(23, Math.max(0, I(b.hour))), T(b.tz, 60), user.id]);
      json(res, 200, { ok: true }); return true;
    }
  }
  if (u === '/api/push/subscribe' && m === 'POST') {
    const user = await needUser(req), b = await readBody(req), s = b.subscription || {};
    if (!s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) throw httpErr(400, 'Некорректная подписка');
    await pool.query('INSERT INTO push_subs(user_id,ep_hash,endpoint,p256dh,auth,ua) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),endpoint=VALUES(endpoint),p256dh=VALUES(p256dh),auth=VALUES(auth),ua=VALUES(ua)', [user.id, sha(String(s.endpoint)), String(s.endpoint).slice(0, 2000), T(s.keys.p256dh, 200), T(s.keys.auth, 100), T(req.headers['user-agent'], 200)]);
    if (b.tz) await pool.query('UPDATE users SET push_tz=? WHERE id=?', [T(b.tz, 60), user.id]);
    json(res, 200, { ok: true }); return true;
  }
  if (u === '/api/push/unsubscribe' && m === 'POST') {
    const user = await needUser(req), b = await readBody(req);
    await pool.query('DELETE FROM push_subs WHERE user_id=? AND ep_hash=?', [user.id, sha(String(b.endpoint || ''))]); json(res, 200, { ok: true }); return true;
  }
  if (u === '/api/admin/users' && m === 'GET') {
    const user = await needUser(req); if (!user.admin) throw httpErr(403, 'Только администратор');
    const [us] = await pool.query('SELECT id,login,is_admin,lang,created_at,last_login,blocked,display_name FROM users ORDER BY id');
    const [vs] = await pool.query('SELECT id,user_id,name,type,odo,unit FROM vehicles ORDER BY user_id, sort_order');
    const [oc] = await pool.query("SELECT COUNT(*) n FROM checklists WHERE status='open'");
    const [pr] = await pool.query("SELECT COUNT(*) n FROM checklist_requests WHERE status='pending'");
    json(res, 200, { me: user.id, users: us.map(x => ({ id: x.id, login: x.login, admin: !!x.is_admin, lang: x.lang || '', created: x.created_at,
      lastLogin: x.last_login, blocked: !!x.blocked, displayName: x.display_name || '',
      vehicles: vs.filter(v => v.user_id === x.id).map(v => ({ id: v.id, name: v.name, type: v.type, odo: v.odo, unit: v.unit || 'km' })) })),
      openSheets: oc[0].n, pendingRequests: pr[0].n }); return true;
  }
  const au = /^\/api\/admin\/users\/(\d+)(\/delete)?$/.exec(u);
  if (au && m === 'POST') {
    const user = await needUser(req); if (!user.admin) throw httpErr(403, 'Только администратор');
    const id = +au[1], b = await readBody(req);
    const [r] = await pool.query('SELECT id,login,is_admin FROM users WHERE id=?', [id]);
    if (!r[0]) throw httpErr(404, 'Пользователь не найден');
    if (au[2]) {
      if (id === user.id) throw httpErr(400, 'Нельзя удалить самого себя');
      await pool.query('DELETE FROM checklist_requests WHERE user_id=?', [id]);
      await pool.query('DELETE FROM checklists WHERE user_id=?', [id]);
      await pool.query('DELETE FROM photos WHERE user_id=?', [id]);
      await pool.query('DELETE FROM push_subs WHERE user_id=?', [id]);
      await pool.query('DELETE FROM shop_ratings WHERE user_id=?', [id]);
      await pool.query('DELETE FROM support_msgs WHERE user_id=?', [id]);
      await pool.query('DELETE FROM vehicles WHERE user_id=?', [id]);
      await pool.query('DELETE FROM users WHERE id=?', [id]);
      await logAdmin(user.id, 'delete_user', r[0].login);
      json(res, 200, { ok: true }); return true;
    }
    const sets = [], vals = [], changed = [];
    if (b.login !== undefined) {
      const login = String(b.login).trim();
      if (login.length < 3 || login.length > 64) throw httpErr(400, 'Логин: от 3 до 64 символов');
      sets.push('login=?'); vals.push(login); changed.push('login');
    }
    if (b.lang !== undefined) { sets.push('lang=?'); vals.push(['ru', 'en', 'uk', 'ja'].includes(b.lang) ? b.lang : ''); changed.push('lang'); }
    if (b.displayName !== undefined) { sets.push('display_name=?'); vals.push(T(b.displayName, 60).trim()); changed.push('name'); }
    if (b.admin !== undefined) {
      const makeAdmin = !!b.admin;
      if (!makeAdmin && r[0].is_admin) {
        const [c] = await pool.query('SELECT COUNT(*) n FROM users WHERE is_admin=1');
        if (c[0].n <= 1) throw httpErr(400, 'Нельзя снять права у последнего администратора');
      }
      sets.push('is_admin=?'); vals.push(makeAdmin ? 1 : 0); changed.push(makeAdmin ? 'admin+' : 'admin-');
    }
    if (b.blocked !== undefined) {
      if (id === user.id && b.blocked) throw httpErr(400, 'Нельзя заблокировать самого себя');
      sets.push('blocked=?'); vals.push(b.blocked ? 1 : 0); changed.push(b.blocked ? 'block' : 'unblock');
      if (b.blocked) await pool.query('DELETE FROM sessions WHERE user_id=?', [id]);
    }
    if (b.password) {
      const pw = String(b.password);
      if (pw.length < 6) throw httpErr(400, 'Пароль: не короче 6 символов');
      sets.push('pass_hash=?'); vals.push(hashPw(pw)); changed.push('password');
    }
    if (sets.length) {
      try { await pool.query(`UPDATE users SET ${sets.join(',')} WHERE id=?`, [...vals, id]); }
      catch (e) { if (e.code === 'ER_DUP_ENTRY') throw httpErr(409, 'Такой логин уже занят'); throw e; }
    }
    if (b.password) await pool.query('DELETE FROM sessions WHERE user_id=?', [id]);
    if (changed.length) await logAdmin(user.id, 'edit_user:' + changed.join(','), r[0].login);
    json(res, 200, { ok: true }); return true;
  }
  const ad = /^\/api\/admin\/users\/(\d+)\/detail$/.exec(u);
  if (ad && m === 'GET') {
    const user = await needUser(req); if (!user.admin) throw httpErr(403, 'Только администратор');
    const id = +ad[1];
    const [r] = await pool.query('SELECT id,login,is_admin,lang,created_at,last_login,blocked,display_name FROM users WHERE id=?', [id]);
    if (!r[0]) throw httpErr(404, 'Пользователь не найден');
    const [vs] = await pool.query('SELECT id,name,type,odo,unit FROM vehicles WHERE user_id=? ORDER BY sort_order', [id]);
    const [rt] = await pool.query('SELECT id,shop_link,mood,comment,created_at FROM shop_ratings WHERE user_id=? ORDER BY created_at DESC LIMIT 20', [id]);
    const [sp] = await pool.query('SELECT id,subject,body,status,created_at FROM support_msgs WHERE user_id=? ORDER BY created_at DESC LIMIT 20', [id]);
    const [oc] = await pool.query("SELECT COUNT(*) n FROM checklists WHERE user_id=? AND status='open'", [id]);
    json(res, 200, { user: { id: r[0].id, login: r[0].login, admin: !!r[0].is_admin, lang: r[0].lang || '', created: r[0].created_at, lastLogin: r[0].last_login, blocked: !!r[0].blocked, displayName: r[0].display_name || '' },
      vehicles: vs.map(v => ({ id: v.id, name: v.name, type: v.type, odo: v.odo, unit: v.unit || 'km' })), ratings: rt, support: sp, openSheets: oc[0].n }); return true;
  }
  const av = /^\/api\/admin\/vehicles\/([a-zA-Z0-9]{1,32})\/delete$/.exec(u);
  if (av && m === 'POST') {
    const user = await needUser(req); if (!user.admin) throw httpErr(403, 'Только администратор');
    const [v] = await pool.query('SELECT id FROM vehicles WHERE id=?', [av[1]]);
    if (!v[0]) throw httpErr(404, 'Транспорт не найден');
    await pool.query('DELETE FROM checklist_requests WHERE checklist_id IN (SELECT id FROM checklists WHERE vehicle_id=?)', [av[1]]);
    await pool.query('DELETE FROM checklists WHERE vehicle_id=?', [av[1]]);
    await pool.query('DELETE FROM vehicles WHERE id=?', [av[1]]);
    json(res, 200, { ok: true }); return true;
  }
  if (u === '/api/profile') {
    const user = await needUser(req);
    if (m === 'GET') {
      const [r] = await pool.query('SELECT login,lang,created_at,last_login,display_name,avatar FROM users WHERE id=?', [user.id]);
      const [vc] = await pool.query('SELECT COUNT(*) n FROM vehicles WHERE user_id=?', [user.id]);
      const [sp] = await pool.query('SELECT id,subject,body,status,created_at FROM support_msgs WHERE user_id=? ORDER BY created_at DESC LIMIT 20', [user.id]);
      const [rt] = await pool.query('SELECT r.id,r.shop_link,r.mood,r.comment,r.created_at,v.name AS vehicle FROM shop_ratings r JOIN checklists c ON c.id=r.checklist_id JOIN vehicles v ON v.id=c.vehicle_id WHERE r.user_id=? ORDER BY r.created_at DESC', [user.id]);
      const [d] = await pool.query("SELECT COUNT(*) n FROM support_msgs WHERE user_id=? AND created_at > NOW() - INTERVAL 1 DAY", [user.id]);
      const [o] = await pool.query("SELECT COUNT(*) n FROM support_msgs WHERE user_id=? AND status<>'closed'", [user.id]);
      const L = LIM();
      const shops = {};
      rt.forEach(x => { const k = x.shop_link || '—'; (shops[k] = shops[k] || { link: x.shop_link, sum: 0, n: 0 }); shops[k].sum += x.mood; shops[k].n++; });
      json(res, 200, { login: r[0].login, displayName: r[0].display_name || '', avatar: r[0].avatar || '', lang: r[0].lang || '', created: r[0].created_at, lastLogin: r[0].last_login,
        vehicles: vc[0].n, support: sp, ratings: rt, shops: Object.values(shops).map(x => ({ link: x.link, avg: +(x.sum / x.n).toFixed(2), n: x.n })),
        limits: { perDay: L.perDay, usedToday: d[0].n, gap: L.gap, open: L.open, openNow: o[0].n } }); return true;
    }
    if (m === 'POST') {
      const b = await readBody(req);
      const av = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'].includes(b.avatar) ? b.avatar : '';
      const lang = ['ru', 'en', 'uk', 'ja'].includes(b.lang) ? b.lang : '';
      await pool.query('UPDATE users SET display_name=?, avatar=?, lang=? WHERE id=?', [T(b.displayName, 60).trim(), av, lang, user.id]);
      json(res, 200, { ok: true }); return true;
    }
  }
  if (u === '/api/support' && m === 'POST') {
    const user = await needUser(req), b = await readBody(req), L = LIM();
    const subject = T(b.subject, 120).trim() || 'Сообщение', body = T(b.body, 2000).trim();
    if (!body) throw httpErr(400, 'Напишите сообщение');
    const [d] = await pool.query("SELECT COUNT(*) n FROM support_msgs WHERE user_id=? AND created_at > NOW() - INTERVAL 1 DAY", [user.id]);
    if (d[0].n >= L.perDay) throw httpErr(429, `Лимит: не больше ${L.perDay} сообщений в сутки`);
    const [g] = await pool.query('SELECT TIMESTAMPDIFF(MINUTE, MAX(created_at), NOW()) mins FROM support_msgs WHERE user_id=?', [user.id]);
    if (L.gap > 0 && g[0].mins !== null && g[0].mins < L.gap) throw httpErr(429, `Подождите ${L.gap - g[0].mins} мин. перед следующим сообщением`);
    const [o] = await pool.query("SELECT COUNT(*) n FROM support_msgs WHERE user_id=? AND status<>'closed'", [user.id]);
    if (o[0].n >= L.open) throw httpErr(429, `Открытых обращений может быть не больше ${L.open}. Дождитесь ответа.`);
    await pool.query('INSERT INTO support_msgs(id,user_id,subject,body) VALUES (?,?,?,?)', [crypto.randomBytes(12).toString('hex'), user.id, subject, body]);
    json(res, 200, { ok: true }); return true;
  }
  if (u === '/api/ratings' && m === 'GET') {
    const user = await needUser(req);
    const [cl] = await pool.query("SELECT c.id,c.entries,c.finished_at,v.name AS vehicle FROM checklists c JOIN vehicles v ON v.id=c.vehicle_id WHERE c.user_id=? AND c.status='accepted' AND c.id NOT IN (SELECT checklist_id FROM shop_ratings WHERE user_id=?) ORDER BY c.finished_at DESC LIMIT 30", [user.id, user.id]);
    const pending = cl.map(c => ({ checklistId: c.id, vehicle: c.vehicle, date: c.finished_at, link: shopLinkOf(parseObj(c.entries)) })).filter(x => x.link);
    json(res, 200, { pending, enabled: LIM().ratingsOn }); return true;
  }
  if (u === '/api/ratings' && m === 'POST') {
    const user = await needUser(req), b = await readBody(req), L = LIM();
    if (!L.ratingsOn) throw httpErr(403, 'Оценки выключены администратором');
    const mood = +b.mood; if (!MOODS.includes(mood)) throw httpErr(400, 'Выберите оценку');
    const comment = T(b.comment, 1000).trim();
    if (L.minComment > 0 && comment.length < L.minComment) throw httpErr(400, `Комментарий: минимум ${L.minComment} символов`);
    const [c] = await pool.query("SELECT id,entries FROM checklists WHERE id=? AND user_id=? AND status='accepted'", [T(b.checklistId, 32), user.id]);
    if (!c[0]) throw httpErr(404, 'Работа не найдена или ещё не принята');
    const link = shopLinkOf(parseObj(c[0].entries));
    if (!link) throw httpErr(400, 'Оценка доступна, когда у мастерской есть ссылка на карты');
    try { await pool.query('INSERT INTO shop_ratings(id,user_id,checklist_id,shop_link,mood,comment) VALUES (?,?,?,?,?,?)', [crypto.randomBytes(12).toString('hex'), user.id, c[0].id, link, mood, comment]); }
    catch (e) { if (e.code === 'ER_DUP_ENTRY') throw httpErr(409, 'Эта работа уже оценена'); throw e; }
    json(res, 200, { ok: true }); return true;
  }
  if (u === '/api/admin/overview' && m === 'GET') {
    const user = await needUser(req); if (!user.admin) throw httpErr(403, 'Только администратор');
    const q = async sql => (await pool.query(sql))[0][0].n;
    json(res, 200, { users: await q('SELECT COUNT(*) n FROM users'), vehicles: await q('SELECT COUNT(*) n FROM vehicles'),
      openSheets: await q("SELECT COUNT(*) n FROM checklists WHERE status='open'"), pendingRequests: await q("SELECT COUNT(*) n FROM checklist_requests WHERE status='pending'"),
      supportNew: await q("SELECT COUNT(*) n FROM support_msgs WHERE status='new'"), ratings: await q('SELECT COUNT(*) n FROM shop_ratings'),
      blocked: await q('SELECT COUNT(*) n FROM users WHERE blocked=1'), limits: LIM() }); return true;
  }
  if (u === '/api/admin/limits') {
    const user = await needUser(req); if (!user.admin) throw httpErr(403, 'Только администратор');
    if (m === 'GET') { json(res, 200, LIM()); return true; }
    if (m === 'PUT') {
      const b = await readBody(req);
      const perDay = Math.min(100, Math.max(0, I(b.perDay))), gap = Math.min(1440, Math.max(0, I(b.gap))), open = Math.min(50, Math.max(0, I(b.open)));
      await setSetting('msg_per_day', perDay); await setSetting('msg_gap_min', gap); await setSetting('msg_open_max', open);
      await setSetting('ratings_on', b.ratingsOn ? '1' : '0'); await setSetting('rating_min_comment', Math.min(500, Math.max(0, I(b.minComment))));
      await logAdmin(user.id, 'edit_limits', `perDay=${perDay} gap=${gap} open=${open} ratings=${b.ratingsOn ? 1 : 0}`);
      json(res, 200, { ok: true, limits: LIM() }); return true;
    }
  }
  if (u === '/api/admin/support' && m === 'GET') {
    const user = await needUser(req); if (!user.admin) throw httpErr(403, 'Только администратор');
    const [r] = await pool.query('SELECT s.id,s.subject,s.body,s.status,s.created_at,s.user_id,u.login FROM support_msgs s JOIN users u ON u.id=s.user_id ORDER BY (s.status="new") DESC, s.created_at DESC LIMIT 200');
    json(res, 200, r); return true;
  }
  const asp = /^\/api\/admin\/support\/([a-f0-9]{24})$/.exec(u);
  if (asp && m === 'POST') {
    const user = await needUser(req); if (!user.admin) throw httpErr(403, 'Только администратор');
    const b = await readBody(req), st = ['new', 'read', 'closed'].includes(b.status) ? b.status : 'read';
    await pool.query('UPDATE support_msgs SET status=? WHERE id=?', [st, asp[1]]);
    await logAdmin(user.id, 'support_' + st, asp[1]);
    json(res, 200, { ok: true }); return true;
  }
  if (u === '/api/admin/log' && m === 'GET') {
    const user = await needUser(req); if (!user.admin) throw httpErr(403, 'Только администратор');
    const [r] = await pool.query('SELECT l.action,l.target,l.created_at,u.login FROM admin_log l LEFT JOIN users u ON u.id=l.admin_id ORDER BY l.id DESC LIMIT 200');
    json(res, 200, r); return true;
  }
  if (u === '/api/support/thread' && m === 'GET') {
    const user = await needUser(req);
    const [r] = await pool.query('SELECT id,body,from_admin,created_at FROM support_msgs WHERE user_id=? ORDER BY created_at, id LIMIT 300', [user.id]);
    await pool.query('UPDATE support_msgs SET seen=1 WHERE user_id=? AND from_admin=1 AND seen=0', [user.id]);
    json(res, 200, r.map(x => ({ id: x.id, body: x.body, admin: !!x.from_admin, created: x.created_at }))); return true;
  }
  if (u === '/api/admin/threads' && m === 'GET') {
    const user = await needUser(req); if (!user.admin) throw httpErr(403, 'Только администратор');
    const [r] = await pool.query("SELECT u.id,u.login,u.display_name,MAX(s.created_at) last,SUM(CASE WHEN s.from_admin=0 AND s.status='new' THEN 1 ELSE 0 END) unread,COUNT(*) n FROM support_msgs s JOIN users u ON u.id=s.user_id GROUP BY u.id,u.login,u.display_name ORDER BY last DESC LIMIT 200");
    json(res, 200, r.map(x => ({ userId: x.id, login: x.login, name: x.display_name || '', last: x.last, unread: +x.unread || 0, count: +x.n }))); return true;
  }
  const th = /^\/api\/admin\/threads\/(\d+)(\/reply|\/close)?$/.exec(u);
  if (th) {
    const user = await needUser(req); if (!user.admin) throw httpErr(403, 'Только администратор');
    const uid = +th[1], act = th[2] || '';
    const [t] = await pool.query('SELECT id,login FROM users WHERE id=?', [uid]);
    if (!t[0]) throw httpErr(404, 'Пользователь не найден');
    if (!act && m === 'GET') {
      const [r] = await pool.query('SELECT id,body,from_admin,created_at FROM support_msgs WHERE user_id=? ORDER BY created_at, id LIMIT 300', [uid]);
      await pool.query("UPDATE support_msgs SET status='read' WHERE user_id=? AND from_admin=0 AND status='new'", [uid]);
      json(res, 200, { login: t[0].login, messages: r.map(x => ({ id: x.id, body: x.body, admin: !!x.from_admin, created: x.created_at })) }); return true;
    }
    if (act === '/reply' && m === 'POST') {
      const b = await readBody(req), body = T(b.body, 2000).trim();
      if (!body) throw httpErr(400, 'Напишите ответ');
      await pool.query("INSERT INTO support_msgs(id,user_id,subject,body,from_admin,status,seen) VALUES (?,?,?,?,1,'read',0)", [crypto.randomBytes(12).toString('hex'), uid, 'Поддержка', body]);
      await logAdmin(user.id, 'support_reply', t[0].login);
      const [pu] = await pool.query('SELECT push_on FROM users WHERE id=?', [uid]);
      if (pu[0] && pu[0].push_on) sendPush(uid, { title: 'Garage Journal · Поддержка', body: body.slice(0, 140), url: './#support', tag: 'support' }).catch(() => {});
      json(res, 200, { ok: true }); return true;
    }
    if (act === '/close' && m === 'POST') {
      await pool.query("UPDATE support_msgs SET status='closed' WHERE user_id=?", [uid]);
      await logAdmin(user.id, 'support_close', t[0].login);
      json(res, 200, { ok: true }); return true;
    }
  }
  if (u === '/api/catalog' && m === 'GET') { json(res, 200, await catalogRows(false)); return true; }
  if (u === '/api/admin/items') {
    const user = await needUser(req); if (!user.admin) throw httpErr(403, 'Только администратор');
    if (m === 'GET') { json(res, 200, await catalogRows(true)); return true; }
    if (m === 'POST') {
      const b = await readBody(req), vtype = String(b.vtype || '');
      if (!VT.includes(vtype)) throw httpErr(400, 'Выберите тип транспорта');
      const cat = T(b.cat, 120).trim() || 'Прочее', src = b.names || {}, ru = T(src.ru, 200).trim();
      if (!ru) throw httpErr(400, 'Укажите название на русском');
      const names = { ru, en: T(src.en, 200).trim() || ru, uk: T(src.uk, 200).trim() || ru, ja: T(src.ja, 200).trim() || ru };
      const km = Math.max(0, I(b.km)), mo = Math.max(0, I(b.mo)), id = crypto.randomBytes(12).toString('hex');
      await pool.query('INSERT INTO custom_items(id,vtype,category,names,km,mo) VALUES (?,?,?,?,?,?)', [id, vtype, cat, JSON.stringify(names), km, mo]);
      const [vs] = await pool.query('SELECT id FROM vehicles WHERE type=?', [vtype]);
      if (vs.length) await pool.query('INSERT INTO parts(id,vehicle_id,category,name,interval_km,interval_months,sort_order) VALUES ?',
        [vs.map(x => [crypto.randomBytes(12).toString('hex'), x.id, cat, ru, km, mo, 9999])]);
      json(res, 200, { ok: true, id, added: vs.length }); return true;
    }
    throw httpErr(405, 'method not allowed');
  }
  const ai = /^\/api\/admin\/items\/([a-f0-9]{24})$/.exec(u);
  if (ai && m === 'POST') {
    const user = await needUser(req); if (!user.admin) throw httpErr(403, 'Только администратор');
    const b = await readBody(req);
    await pool.query('UPDATE custom_items SET archived=? WHERE id=?', [b.archived ? 1 : 0, ai[1]]);
    json(res, 200, { ok: true }); return true;
  }
  if (u === '/api/push/test' && m === 'POST') {
    const user = await needUser(req), [r] = await pool.query('SELECT lang FROM users WHERE id=?', [user.id]);
    const n = await sendPush(user.id, { title: 'Garage Journal', body: (SRV[r[0].lang] || SRV.en).test, url: './', tag: 'test' });
    json(res, 200, { sent: n }); return true;
  }
  return false;
}

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
      lastKm: p.last_km, lastDate: p.last_date, note: p.note || '', checks: parseJ(p.checks), imp: p.important, hist: hist[p.id] || [] }));
    ls.forEach(l => (logs[l.vehicle_id] = logs[l.vehicle_id] || []).push({ d: l.log_date, odo: l.odo, trip: l.trip }));
    const [pl] = await pool.query('SELECT * FROM plans WHERE vehicle_id IN (?) ORDER BY vehicle_id, sort_order', [ids]);
    pl.forEach(q => (plans[q.vehicle_id] = plans[q.vehicle_id] || []).push({ id: q.id, itemId: q.item_id || '', title: q.title, url: q.url, price: q.price, note: q.note || '' }));
    pc.forEach(p => (panels[p.vehicle_id] = panels[p.vehicle_id] || []).push({ d: p.change_date, old: p.old_km, nw: p.new_km, at: p.true_km, note: p.note }));
  }
  return {
    cur: u[0] ? u[0].cur_vehicle : '',
    v: vs.map(v => ({
      id: v.id, name: v.name, type: v.type, buyDate: v.buy_date || '', eng: v.eng, plate: v.plate || '', frame: v.frame || '', tiLast: v.ti_last || '', buyKm: v.buy_km, price: v.buy_price, unit: v.unit || 'km', odo: v.odo, off: v.odo_offset, cc: v.currency,
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
        `INSERT INTO vehicles(id,user_id,name,type,buy_date,buy_km,buy_price,odo,odo_offset,currency,ins_end,ins_note,ti_end,ti_note,sort_order,unit)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),name=VALUES(name),type=VALUES(type),buy_date=VALUES(buy_date),buy_km=VALUES(buy_km),buy_price=VALUES(buy_price),
           odo=VALUES(odo),odo_offset=VALUES(odo_offset),currency=VALUES(currency),ins_end=VALUES(ins_end),ins_note=VALUES(ins_note),
           ti_end=VALUES(ti_end),ti_note=VALUES(ti_note),sort_order=VALUES(sort_order),unit=VALUES(unit)`,
        [id, uid, T(v.name, 200) || 'Без названия', T(v.type, 16) || 'other', D(v.buyDate), I(v.buyKm), C(v.price), I(v.odo), I(v.off),
         T(v.cc, 8) || '¥', D(ins.end), T(ins.note, 500), D(ti.end), T(ti.note, 500), order++, ['km', 'mi'].includes(v.unit) ? v.unit : 'km']);
      await c.query('UPDATE vehicles SET eng=?, plate=?, frame=?, ti_last=? WHERE id=? AND user_id=?', [IN(v.eng), T(v.plate, 20), T(v.frame, 40), D(v.tiLast), id, uid]);
      await c.query('DELETE FROM parts WHERE vehicle_id=?', [id]);          // история удаляется каскадом
      await c.query('DELETE FROM mileage_log WHERE vehicle_id=?', [id]);
      await c.query('DELETE FROM panel_changes WHERE vehicle_id=?', [id]);
      await c.query('DELETE FROM plans WHERE vehicle_id=?', [id]);

      const items = (Array.isArray(v.items) ? v.items : []).filter(it => it && T(it.id, 32));
      if (items.length) await c.query(
        'INSERT INTO parts(id,vehicle_id,category,name,interval_km,interval_months,last_km,last_date,note,checks,important,sort_order) VALUES ?',
        [items.map((it, i) => [T(it.id, 32), id, T(it.cat, 120) || 'Прочее', T(it.name, 200), I(it.km), I(it.mo),
                               IN(it.lastKm), D(it.lastDate), T(it.note, 4000), CKJ(it.checks), it.imp === true || it.imp === 1 ? 1 : it.imp === false || it.imp === 0 ? 0 : null, i])]);
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
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/master.js': ['master.js', 'application/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/master.css': ['master.css', 'text/css; charset=utf-8'],
  '/qr.js': ['qr.js', 'application/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'application/javascript; charset=utf-8'],
  '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'], '/icon.svg': ['icon.svg', 'image/svg+xml']
};
const INDEX = path.join(__dirname, 'public', 'index.html');

// Отдача статики: gzip для текста и ETag, чтобы браузер не скачивал файлы заново (ответ 304)
const FCACHE = new Map();
function sendFile(req, res, file, type, cache, extra) {
  let st; try { st = fs.statSync(file); } catch (_) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  let c = FCACHE.get(file);
  if (!c || c.mtime !== st.mtimeMs || c.size !== st.size) {
    const raw = fs.readFileSync(file), text = /^(text\/|application\/(javascript|manifest|json)|image\/svg)/.test(type);
    c = { mtime: st.mtimeMs, size: st.size, raw, etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20) + '"',
          gz: text && raw.length > 512 ? zlib.gzipSync(raw, { level: 9 }) : null };
    FCACHE.set(file, c);
  }
  const h = Object.assign({ 'Content-Type': type, 'Cache-Control': cache, ETag: c.etag, Vary: 'Accept-Encoding' }, extra || {});
  const inm = String(req.headers['if-none-match'] || '').split(',').map(x => x.trim().replace(/^W\//, ''));
  if (inm.includes(c.etag)) { res.writeHead(304, h); return res.end(); }
  const gz = c.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = gz ? c.gz : c.raw;
  if (gz) h['Content-Encoding'] = 'gzip';
  h['Content-Length'] = body.length;
  res.writeHead(200, h); res.end(req.method === 'HEAD' ? undefined : body);
}

async function route(req, res) {
  const u = req.url.split('?')[0], m = req.method;
  if (u === '/api/health') return json(res, 200, { ok: true, ready });
  if (u === '/api/status') {
    const user = await userOf(req);
    let hasUsers = false;
    if (ready) { const [r] = await pool.query('SELECT COUNT(*) n FROM users'); hasUsers = r[0].n > 0; }
    return json(res, 200, {
      configured: !!cfg, ready, connecting, error: lastError, hasUsers, user, publicUrl: SET.public_url || '', redirect: SET.redirect === '1' && !!SET.public_url, regOpen: SET.reg_open === '1',
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
    if (!first && SET.reg_open !== '1') throw httpErr(403, 'Регистрация закрыта администратором');
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
    const ik = 'ip|' + ipOf(req), fi = fails.get(ik);
    if ((f && f.until > Date.now()) || (fi && fi.until > Date.now())) throw httpErr(429, 'Слишком много попыток, подождите минуту');
    const [r] = await pool.query('SELECT * FROM users WHERE login=?', [login]);
    if (r[0] && r[0].blocked && checkPw(String(b.password || ''), r[0].pass_hash)) throw httpErr(403, 'Аккаунт заблокирован администратором');
    if (!r[0] || !checkPw(String(b.password || ''), r[0].pass_hash)) {
      const n = (f ? f.n : 0) + 1; fails.set(key, { n, until: n >= 5 ? Date.now() + 60000 : 0 });
      const ni = (fi && fi.t > Date.now() - 6e5 ? fi.n : 0) + 1; fails.set(ik, { n: ni, t: Date.now(), until: ni >= 30 ? Date.now() + 6e5 : 0 });
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
  if (await route2(req, res, u, m)) return;
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
    return sendFile(req, res, path.join(__dirname, 'public', STATIC[u][0]), STATIC[u][1], STATIC[u][1].startsWith('image/png') ? 'public, max-age=86400' : 'no-cache');
  }
  if (u === '/api/state') {
    if (!ready) throw httpErr(503, 'База данных не подключена');
    const user = await needUser(req);
    if (m === 'GET') return json(res, 200, await getState(user.id));
    if (m === 'PUT') { const data = await readBody(req); await run(() => putState(user.id, data)); return json(res, 200, { ok: true }); }
    throw httpErr(405, 'method not allowed');
  }
  if (u === '/' || u === '/index.html') {
    return sendFile(req, res, INDEX, 'text/html; charset=utf-8', 'no-cache');
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
}

http.createServer((req, res) => {
  route(req, res).catch(e => { if (!e.status) console.error(e); if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : errMsg(e) }); });
}).listen(PORT, '0.0.0.0', () => console.log('Listening on', PORT));

if (cfg) connectLoop();
const stop = () => { (pool ? pool.end() : Promise.resolve()).finally(() => process.exit(0)); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
