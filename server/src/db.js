import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '../../local-data');
const configuredDbPath = process.env.NEBULA_DB_PATH;
const dbPath = configuredDbPath ? path.resolve(configuredDbPath) : path.join(dataDir, 'nebula-memory.sqlite');
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

export const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = MEMORY;
  PRAGMA foreign_keys = ON;
`);

export function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nebula_maps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      map_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (map_id) REFERENCES nebula_maps(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      map_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (map_id, name),
      FOREIGN KEY (map_id) REFERENCES nebula_maps(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS log_tags (
      log_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      PRIMARY KEY (log_id, tag_id),
      FOREIGN KEY (log_id) REFERENCES logs(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ai_cache (
      cache_key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  migrateMapsUserColumn();
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_nebula_maps_user_id ON nebula_maps(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_logs_map_id ON logs(map_id);
    CREATE INDEX IF NOT EXISTS idx_tags_map_id ON tags(map_id);
  `);

  seedIfEmpty();
  deleteExpiredSessions();
}

function migrateMapsUserColumn() {
  const columns = db.prepare('PRAGMA table_info(nebula_maps)').all();
  if (!columns.some((column) => column.name === 'user_id')) {
    db.exec('ALTER TABLE nebula_maps ADD COLUMN user_id INTEGER;');
  }

  const demo = ensureDemoUser();
  db.prepare('UPDATE nebula_maps SET user_id = ? WHERE user_id IS NULL').run(demo.id);
}

function seedIfEmpty() {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM nebula_maps').get();
  if (existing.count > 0) {
    return;
  }

  const demo = ensureDemoUser();
  createStarterMap(demo.id, '期末冲刺星云', '用于演示学习、生活与情绪之间的关系');
}

function ensureDemoUser() {
  const existing = db.prepare('SELECT id, username, created_at AS createdAt FROM users WHERE username = ?').get('demo');
  if (existing) {
    return existing;
  }

  const salt = randomBytes(16).toString('hex');
  const hash = hashPassword('demo123456', salt);
  const result = db
    .prepare('INSERT INTO users (username, password_hash, password_salt) VALUES (?, ?, ?)')
    .run('demo', hash, salt);
  return getUserById(Number(result.lastInsertRowid));
}

export function createUser(username, password) {
  const cleanUsername = normalizeUsername(username);
  validateCredentials(cleanUsername, password);

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUsername);
  if (existing) {
    throw new Error('用户名已存在');
  }

  const salt = randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const result = db
    .prepare('INSERT INTO users (username, password_hash, password_salt) VALUES (?, ?, ?)')
    .run(cleanUsername, hash, salt);
  return getUserById(Number(result.lastInsertRowid));
}

export function verifyUserCredentials(username, password) {
  const cleanUsername = normalizeUsername(username);
  const row = db
    .prepare('SELECT id, username, password_hash AS passwordHash, password_salt AS passwordSalt, created_at AS createdAt FROM users WHERE username = ?')
    .get(cleanUsername);
  if (!row || !password) {
    return null;
  }

  const expected = Buffer.from(row.passwordHash, 'hex');
  const actual = Buffer.from(hashPassword(password, row.passwordSalt), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  return publicUser(row);
}

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return { token, expiresAt };
}

export function getSessionUser(token) {
  if (!token) {
    return null;
  }

  const row = db
    .prepare(
      `SELECT u.id, u.username, u.created_at AS createdAt, s.expires_at AS expiresAt
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token);

  if (!row) {
    return null;
  }
  if (Number(row.expiresAt) <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return publicUser(row);
}

export function deleteSession(token) {
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
}

function deleteExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
}

function getUserById(id) {
  const row = db.prepare('SELECT id, username, created_at AS createdAt FROM users WHERE id = ?').get(id);
  return row ? publicUser(row) : null;
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    createdAt: row.createdAt
  };
}

function validateCredentials(username, password) {
  if (username.length < 3 || username.length > 32) {
    throw new Error('用户名需要 3 到 32 个字符');
  }
  if (String(password ?? '').length < 6 || String(password ?? '').length > 72) {
    throw new Error('密码需要 6 到 72 个字符');
  }
}

function normalizeUsername(username) {
  return String(username ?? '').trim().replace(/\s+/g, '_').slice(0, 32);
}

function hashPassword(password, salt) {
  return scryptSync(String(password), salt, 64).toString('hex');
}

export function createStarterMap(userId, name = '我的星云图', description = '我的个人行为观察星云') {
  const map = createMap(name, description, userId);
  const samples = [
    {
      title: 'Web 项目选题讨论',
      content: '今天重新梳理了 Web 期末项目，想做一个星云日志系统。重点要体现 Canvas 图形渲染、前后端分离和数据分析。',
      tags: ['Web', '项目', '学习']
    },
    {
      title: '算法复习效率不错',
      content: '晚上复习了动态规划和图算法，虽然一开始有点卡，但做完几道题后思路清晰了很多。',
      tags: ['算法', '学习', '复习']
    },
    {
      title: '熬夜赶作业',
      content: '昨晚为了赶 ddl 睡得很晚，今天精神不太好，下午学习效率明显下降。',
      tags: ['作业', '睡眠', '压力']
    },
    {
      title: '跑步之后状态变好',
      content: '傍晚跑了三公里，回来后心情明显轻松，写代码也顺了不少。',
      tags: ['运动', '情绪', '健康']
    },
    {
      title: '前端布局终于调通',
      content: 'Vue 组件和 Canvas 交互花了不少时间，但是看到节点能点击高亮之后很有成就感。',
      tags: ['前端', 'Web', '项目']
    },
    {
      title: '考试压力上来了',
      content: '这周好几门课都进入复习阶段，感觉时间有点紧，需要把任务拆小一点。',
      tags: ['考试', '压力', '复习']
    }
  ];

  for (const sample of samples) {
    createLog({
      mapId: map.id,
      title: sample.title,
      content: sample.content,
      tagNames: sample.tags
    });
  }

  return map;
}

export function createMap(name, description = '', userId) {
  const ownerId = Number(userId);
  if (!Number.isFinite(ownerId) || ownerId <= 0) {
    throw new Error('用户身份无效，请重新登录');
  }
  const stmt = db.prepare('INSERT INTO nebula_maps (user_id, name, description) VALUES (?, ?, ?)');
  const result = stmt.run(ownerId, name.trim(), description.trim());
  return getMapById(Number(result.lastInsertRowid), ownerId);
}

export function updateMap(id, userId, payload) {
  const map = getMapById(id, userId);
  if (!map) {
    return null;
  }
  const name = String(payload.name ?? map.name).trim();
  if (!name) {
    throw new Error('星云图名称不能为空');
  }
  const description = String(payload.description ?? map.description ?? '').trim();
  db.prepare('UPDATE nebula_maps SET name = ?, description = ? WHERE id = ? AND user_id = ?').run(
    name,
    description,
    id,
    userId
  );
  return getMapById(id, userId);
}

export function getMapById(id, userId) {
  if (Number.isFinite(Number(userId))) {
    const row = db
      .prepare('SELECT id, user_id AS userId, name, description, created_at AS createdAt FROM nebula_maps WHERE id = ? AND user_id = ?')
      .get(id, userId);
    return row ?? null;
  }

  const row = db.prepare('SELECT id, user_id AS userId, name, description, created_at AS createdAt FROM nebula_maps WHERE id = ?').get(id);
  return row ?? null;
}

export function listMaps(userId) {
  return db
    .prepare(
      'SELECT id, user_id AS userId, name, description, created_at AS createdAt FROM nebula_maps WHERE user_id = ? ORDER BY id DESC'
    )
    .all(userId);
}

export function listTags(mapId) {
  return db
    .prepare(`
      SELECT
        t.id,
        t.name,
        t.color,
        COUNT(lt.log_id) AS count
      FROM tags t
      LEFT JOIN log_tags lt ON lt.tag_id = t.id
      WHERE t.map_id = ?
      GROUP BY t.id
      ORDER BY count DESC, t.name ASC
    `)
    .all(mapId);
}

export function getTagById(id) {
  return db
    .prepare(
      `SELECT
        t.id,
        t.map_id AS mapId,
        t.name,
        t.color,
        COUNT(lt.log_id) AS count
       FROM tags t
       LEFT JOIN log_tags lt ON lt.tag_id = t.id
       WHERE t.id = ?
       GROUP BY t.id`
    )
    .get(id);
}

export function listLogs(mapId) {
  const logs = db
    .prepare(
      'SELECT id, map_id AS mapId, title, content, created_at AS createdAt, updated_at AS updatedAt FROM logs WHERE map_id = ? ORDER BY datetime(created_at) DESC'
    )
    .all(mapId);

  return logs.map((log) => ({
    ...log,
    tags: getTagsForLog(log.id)
  }));
}

export function getLogById(id) {
  const row = db
    .prepare('SELECT id, map_id AS mapId, title, content, created_at AS createdAt, updated_at AS updatedAt FROM logs WHERE id = ?')
    .get(id);
  if (!row) {
    return null;
  }
  return {
    ...row,
    tags: getTagsForLog(id)
  };
}

export function getTagsForLog(logId) {
  return db
    .prepare(
      `SELECT t.id, t.name, t.color
       FROM tags t
       JOIN log_tags lt ON lt.tag_id = t.id
       WHERE lt.log_id = ?
       ORDER BY t.name ASC`
    )
    .all(logId);
}

export function getEdges(mapId) {
  return db
    .prepare(
      `SELECT lt.log_id AS logId, lt.tag_id AS tagId, lt.weight
       FROM log_tags lt
       JOIN logs l ON l.id = lt.log_id
       WHERE l.map_id = ?`
    )
    .all(mapId);
}

export function getTagCooccurrence(mapId) {
  return db
    .prepare(
      `SELECT
        a.tag_id AS tagAId,
        b.tag_id AS tagBId,
        COUNT(*) AS count
       FROM log_tags a
       JOIN log_tags b ON a.log_id = b.log_id AND a.tag_id < b.tag_id
       JOIN logs l ON l.id = a.log_id
       WHERE l.map_id = ?
       GROUP BY a.tag_id, b.tag_id`
    )
    .all(mapId);
}

export function getAiCache(cacheKey) {
  const row = db.prepare('SELECT value_json AS valueJson FROM ai_cache WHERE cache_key = ?').get(cacheKey);
  if (!row) {
    return null;
  }
  try {
    return JSON.parse(row.valueJson);
  } catch {
    db.prepare('DELETE FROM ai_cache WHERE cache_key = ?').run(cacheKey);
    return null;
  }
}

export function setAiCache(cacheKey, value) {
  db.prepare(
    `INSERT INTO ai_cache (cache_key, value_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(cache_key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = datetime('now')`
  ).run(cacheKey, JSON.stringify(value));
}

export function createLog({ mapId, title, content, tagNames }) {
  const cleanTags = normalizeTagNames(tagNames);
  if (cleanTags.length === 0) {
    throw new Error('日志至少需要关联一个标签');
  }

  const result = db
    .prepare("INSERT INTO logs (map_id, title, content, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))")
    .run(mapId, title.trim(), content.trim());
  const logId = Number(result.lastInsertRowid);
  attachTagsToLog(mapId, logId, cleanTags);
  return getLogById(logId);
}

export function updateLog(id, { title, content, tagNames }) {
  const existing = getLogById(id);
  if (!existing) {
    return null;
  }

  const cleanTags = normalizeTagNames(tagNames);
  if (cleanTags.length === 0) {
    throw new Error('日志至少需要关联一个标签');
  }

  db.prepare("UPDATE logs SET title = ?, content = ?, updated_at = datetime('now') WHERE id = ?").run(title.trim(), content.trim(), id);
  db.prepare('DELETE FROM log_tags WHERE log_id = ?').run(id);
  attachTagsToLog(existing.mapId, id, cleanTags);
  return getLogById(id);
}

export function deleteLog(id) {
  const result = db.prepare('DELETE FROM logs WHERE id = ?').run(id);
  return result.changes > 0;
}

export function createTag({ mapId, name, color }) {
  const cleanName = normalizeTagName(name);
  const cleanColor = normalizeColor(color) ?? colorForTag(cleanName);
  if (!cleanName) {
    throw new Error('标签名称不能为空');
  }
  if (db.prepare('SELECT id FROM tags WHERE map_id = ? AND name = ?').get(mapId, cleanName)) {
    throw new Error('同一星云图下已有这个标签');
  }

  const result = db.prepare('INSERT INTO tags (map_id, name, color) VALUES (?, ?, ?)').run(mapId, cleanName, cleanColor);
  return getTagById(Number(result.lastInsertRowid));
}

export function updateTag(id, { name, color }) {
  const existing = getTagById(id);
  if (!existing) {
    return null;
  }

  const cleanName = normalizeTagName(name);
  const cleanColor = normalizeColor(color) ?? existing.color;
  if (!cleanName) {
    throw new Error('标签名称不能为空');
  }

  const duplicate = db.prepare('SELECT id FROM tags WHERE map_id = ? AND name = ? AND id <> ?').get(existing.mapId, cleanName, id);
  if (duplicate) {
    throw new Error('同一星云图下已有这个标签');
  }

  db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(cleanName, cleanColor, id);
  return getTagById(id);
}

export function deleteTag(id) {
  const existing = getTagById(id);
  if (!existing) {
    return { deleted: false, reason: 'not-found' };
  }

  const exclusive = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM logs l
       JOIN log_tags target ON target.log_id = l.id AND target.tag_id = ?
       LEFT JOIN log_tags other ON other.log_id = l.id AND other.tag_id <> ?
       WHERE other.tag_id IS NULL`
    )
    .get(id, id);

  if (exclusive.count > 0) {
    throw new Error(`不能删除「${existing.name}」，有 ${exclusive.count} 篇日志只关联了这个标签。请先给这些日志添加其他标签。`);
  }

  db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  return { deleted: true };
}

export function normalizeTagNames(tagNames) {
  return [...new Set((tagNames ?? []).map(normalizeTagName).filter(Boolean))].slice(0, 12);
}

function normalizeTagName(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
}

function normalizeColor(color) {
  const clean = String(color ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(clean) ? clean : null;
}

function attachTagsToLog(mapId, logId, tagNames) {
  for (const tagName of tagNames) {
    const tag = findOrCreateTag(mapId, tagName);
    db.prepare('INSERT OR IGNORE INTO log_tags (log_id, tag_id, weight) VALUES (?, ?, 1)').run(logId, tag.id);
  }
}

export function findOrCreateTag(mapId, name) {
  const cleanName = name.trim();
  const existing = db.prepare('SELECT id, name, color FROM tags WHERE map_id = ? AND name = ?').get(mapId, cleanName);
  if (existing) {
    return existing;
  }

  const color = colorForTag(cleanName);
  const result = db.prepare('INSERT INTO tags (map_id, name, color) VALUES (?, ?, ?)').run(mapId, cleanName, color);
  return { id: Number(result.lastInsertRowid), name: cleanName, color };
}

function colorForTag(name) {
  const palette = ['#62d6ff', '#f7d774', '#ff8fa3', '#8cf0b4', '#b99cff', '#ffb86b', '#7dd3fc', '#c4f36a'];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}
