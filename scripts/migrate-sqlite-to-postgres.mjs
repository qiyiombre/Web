import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeDatabase, pool } from '../server/src/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultSqlitePath = path.resolve(__dirname, '../local-data/nebula-memory.sqlite');
const sqlitePath = process.argv[2] ? path.resolve(process.argv[2]) : defaultSqlitePath;

if (!existsSync(sqlitePath)) {
  console.error(`SQLite database not found: ${sqlitePath}`);
  process.exit(1);
}

await initializeDatabase();

const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
const client = await pool.connect();

try {
  await client.query('BEGIN');

  const users = rows('SELECT id, username, password_hash, password_salt, created_at FROM users ORDER BY id');
  for (const user of users) {
    await client.query(
      `INSERT INTO users (id, username, password_hash, password_salt, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         username = excluded.username,
         password_hash = excluded.password_hash,
         password_salt = excluded.password_salt,
         created_at = excluded.created_at`,
      [user.id, user.username, user.password_hash, user.password_salt, user.created_at]
    );
  }

  const maps = rows('SELECT id, user_id, name, description, created_at FROM nebula_maps ORDER BY id').filter((map) => map.user_id);
  for (const map of maps) {
    await client.query(
      `INSERT INTO nebula_maps (id, user_id, name, description, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         user_id = excluded.user_id,
         name = excluded.name,
         description = excluded.description,
         created_at = excluded.created_at`,
      [map.id, map.user_id, map.name, map.description, map.created_at]
    );
  }

  const logs = rows('SELECT id, map_id, title, content, created_at, updated_at FROM logs ORDER BY id');
  for (const log of logs) {
    await client.query(
      `INSERT INTO logs (id, map_id, title, content, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         map_id = excluded.map_id,
         title = excluded.title,
         content = excluded.content,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      [log.id, log.map_id, log.title, log.content, log.created_at, log.updated_at]
    );
  }

  const tags = rows('SELECT id, map_id, name, color, created_at FROM tags ORDER BY id');
  for (const tag of tags) {
    await client.query(
      `INSERT INTO tags (id, map_id, name, color, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         map_id = excluded.map_id,
         name = excluded.name,
         color = excluded.color,
         created_at = excluded.created_at`,
      [tag.id, tag.map_id, tag.name, tag.color, tag.created_at]
    );
  }

  const logTags = rows('SELECT log_id, tag_id, weight FROM log_tags ORDER BY log_id, tag_id');
  for (const edge of logTags) {
    await client.query(
      `INSERT INTO log_tags (log_id, tag_id, weight)
       VALUES ($1, $2, $3)
       ON CONFLICT (log_id, tag_id) DO UPDATE SET weight = excluded.weight`,
      [edge.log_id, edge.tag_id, edge.weight]
    );
  }

  const categoryStates = rows('SELECT map_id, initialized, updated_at FROM domain_category_state ORDER BY map_id');
  for (const state of categoryStates) {
    await client.query(
      `INSERT INTO domain_category_state (map_id, initialized, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (map_id) DO UPDATE SET
         initialized = excluded.initialized,
         updated_at = excluded.updated_at`,
      [state.map_id, state.initialized, state.updated_at]
    );
  }

  const categories = rows('SELECT id, map_id, name, color, keywords_json, sort_order, created_at, updated_at FROM domain_categories ORDER BY id');
  for (const category of categories) {
    await client.query(
      `INSERT INTO domain_categories (id, map_id, name, color, keywords_json, sort_order, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (map_id, name) DO UPDATE SET
         map_id = excluded.map_id,
         name = excluded.name,
         color = excluded.color,
         keywords_json = excluded.keywords_json,
         sort_order = excluded.sort_order,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      [
        category.id,
        category.map_id,
        category.name,
        category.color,
        category.keywords_json,
        category.sort_order,
        category.created_at,
        category.updated_at
      ]
    );
  }

  const caches = rows('SELECT cache_key, value_json, updated_at, last_used_at FROM ai_cache ORDER BY cache_key');
  for (const cache of caches) {
    await client.query(
      `INSERT INTO ai_cache (cache_key, value_json, updated_at, last_used_at)
       VALUES ($1, $2, $3::timestamptz, COALESCE($4::timestamptz, $3::timestamptz))
       ON CONFLICT (cache_key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at,
         last_used_at = excluded.last_used_at`,
      [cache.cache_key, cache.value_json, cache.updated_at, cache.last_used_at]
    );
  }

  for (const table of ['users', 'nebula_maps', 'logs', 'tags', 'domain_categories']) {
    await syncIdentitySequence(table);
  }

  await client.query('COMMIT');

  const summary = {};
  for (const table of ['users', 'nebula_maps', 'logs', 'tags', 'log_tags', 'domain_categories', 'ai_cache']) {
    summary[table] = {
      sqlite: countSqlite(table),
      postgres: await countPostgres(table)
    };
  }
  console.log(JSON.stringify({ ok: true, sqlitePath, summary }, null, 2));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  client.release();
  sqlite.close();
  await pool.end();
}

function rows(sql) {
  return sqlite.prepare(sql).all();
}

function countSqlite(table) {
  return sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

async function countPostgres(table) {
  const result = await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
  return result.rows[0].count;
}

async function syncIdentitySequence(table) {
  await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM ${table}), 1), true)`);
}
