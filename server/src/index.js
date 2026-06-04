import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createLog,
  createMap,
  createSession,
  createTag,
  createUser,
  deleteLog,
  deleteSession,
  deleteTag,
  getEdges,
  getLogById,
  getMapById,
  getSessionUser,
  getTagById,
  initializeDatabase,
  listLogs,
  listMaps,
  listTags,
  normalizeTagNames,
  updateLog,
  updateMap,
  updateTag,
  verifyUserCredentials
} from './db.js';
import { buildInsights, generateAdvice } from './insights.js';
import { suggestTags } from './recommend.js';
import { buildTagSimilarities } from './semantic.js';

initializeDatabase();

const app = express();
const port = Number(process.env.PORT ?? 3001);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.resolve(__dirname, '../../client/dist');
const COOKIE_NAME = 'nebula_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie ?? '');
  req.user = getSessionUser(cookies[COOKIE_NAME]);
  req.sessionToken = cookies[COOKIE_NAME] ?? '';
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'nebula-insight-server' });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) {
    res.status(401).json({ message: '请先登录' });
    return;
  }
  res.json({ user: req.user });
});

app.post('/api/auth/register', (req, res, next) => {
  try {
    const user = createUser(req.body.username, req.body.password);
    const session = createSession(user.id);
    setSessionCookie(res, session.token);
    res.status(201).json({ user });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', (req, res) => {
  const user = verifyUserCredentials(req.body.username, req.body.password);
  if (!user) {
    res.status(401).json({ message: '用户名或密码不正确' });
    return;
  }

  const session = createSession(user.id);
  setSessionCookie(res, session.token);
  res.json({ user });
});

app.post('/api/auth/logout', (req, res) => {
  deleteSession(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.use('/api', requireAuth);

app.get('/api/maps', (req, res) => {
  res.json(listMaps(req.user.id));
});

app.post('/api/maps', (req, res, next) => {
  try {
    const name = String(req.body.name ?? '').trim();
    if (!name) {
      res.status(400).json({ message: '星云图名称不能为空' });
      return;
    }
    res.status(201).json(createMap(name, String(req.body.description ?? ''), req.user.id));
  } catch (error) {
    next(error);
  }
});

app.patch('/api/maps/:id', (req, res, next) => {
  const mapId = Number(req.params.id);
  try {
    const updated = updateMap(mapId, req.user.id, {
      name: req.body.name,
      description: req.body.description
    });
    if (!updated) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.get('/api/maps/:id/graph', async (req, res, next) => {
  const mapId = Number(req.params.id);
  try {
    const map = getOwnedMap(mapId, req.user.id);
    if (!map) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }

    res.json({
      map,
      tags: listTags(mapId),
      logs: listLogs(mapId),
      edges: getEdges(mapId),
      tagSimilarities: await buildTagSimilarities(mapId)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/maps/:id/insights', async (req, res, next) => {
  const mapId = Number(req.params.id);
  try {
    if (!getOwnedMap(mapId, req.user.id)) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }
    res.json(await buildInsights(mapId));
  } catch (error) {
    next(error);
  }
});

app.post('/api/maps/:id/advice', async (req, res, next) => {
  const mapId = Number(req.params.id);
  try {
    if (!getOwnedMap(mapId, req.user.id)) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }
    res.json(await generateAdvice(mapId));
  } catch (error) {
    next(error);
  }
});

app.post('/api/logs', (req, res, next) => {
  try {
    const payload = normalizeLogPayload(req.body, { requireMapId: true });
    if (!getOwnedMap(payload.mapId, req.user.id)) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }
    res.status(201).json(createLog(payload));
  } catch (error) {
    next(error);
  }
});

app.put('/api/logs/:id', (req, res, next) => {
  try {
    const logId = Number(req.params.id);
    const existing = getLogById(logId);
    if (!existing || !getOwnedMap(existing.mapId, req.user.id)) {
      res.status(404).json({ message: '日志不存在' });
      return;
    }

    const payload = normalizeLogPayload(req.body, { requireMapId: false });
    const updated = updateLog(logId, payload);
    if (!updated) {
      res.status(404).json({ message: '日志不存在' });
      return;
    }
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/logs/:id', (req, res) => {
  const logId = Number(req.params.id);
  const existing = getLogById(logId);
  if (!existing || !getOwnedMap(existing.mapId, req.user.id)) {
    res.status(404).json({ message: '日志不存在' });
    return;
  }

  const deleted = deleteLog(logId);
  if (!deleted) {
    res.status(404).json({ message: '日志不存在' });
    return;
  }
  res.json({ ok: true });
});

app.post('/api/tags', (req, res, next) => {
  try {
    const mapId = Number(req.body.mapId);
    if (!getOwnedMap(mapId, req.user.id)) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }
    res.status(201).json(
      createTag({
        mapId,
        name: req.body.name,
        color: req.body.color
      })
    );
  } catch (error) {
    next(error);
  }
});

app.put('/api/tags/:id', (req, res, next) => {
  try {
    const tag = getOwnedTag(Number(req.params.id), req.user.id);
    if (!tag) {
      res.status(404).json({ message: '标签不存在' });
      return;
    }

    const updated = updateTag(tag.id, {
      name: req.body.name,
      color: req.body.color
    });
    if (!updated) {
      res.status(404).json({ message: '标签不存在' });
      return;
    }
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/tags/:id', (req, res, next) => {
  try {
    const tag = getOwnedTag(Number(req.params.id), req.user.id);
    if (!tag) {
      res.status(404).json({ message: '标签不存在' });
      return;
    }

    const result = deleteTag(tag.id);
    if (!result.deleted) {
      res.status(404).json({ message: '标签不存在' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/tags/suggest', async (req, res, next) => {
  const mapId = Number(req.body.mapId);
  const content = String(req.body.content ?? '');
  try {
    if (!getOwnedMap(mapId, req.user.id)) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }
    res.json(await suggestTags(mapId, content));
  } catch (error) {
    next(error);
  }
});

if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/.*/, (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use((error, req, res, next) => {
  console.error(error);
  res.status(400).json({ message: error.message ?? '服务器错误' });
});

app.listen(port, () => {
  console.log(`Nebula Insight API running at http://127.0.0.1:${port}`);
});

function requireAuth(req, res, next) {
  if (!req.user) {
    res.status(401).json({ message: '请先登录' });
    return;
  }
  next();
}

function getOwnedMap(mapId, userId) {
  if (!Number.isFinite(mapId)) {
    return null;
  }
  return getMapById(mapId, userId);
}

function getOwnedTag(tagId, userId) {
  if (!Number.isFinite(tagId)) {
    return null;
  }
  const tag = getTagById(tagId);
  if (!tag || !getOwnedMap(tag.mapId, userId)) {
    return null;
  }
  return tag;
}

function normalizeLogPayload(body, { requireMapId }) {
  const title = String(body.title ?? '').trim();
  const content = String(body.content ?? '').trim();
  const mapId = Number(body.mapId);
  const tagNames = normalizeTagNames(body.tagNames);

  if (requireMapId && (!Number.isFinite(mapId) || mapId <= 0)) {
    throw new Error('星云图 ID 无效');
  }
  if (!title) {
    throw new Error('标题不能为空');
  }
  if (!content) {
    throw new Error('内容不能为空');
  }
  if (tagNames.length === 0) {
    throw new Error('日志至少需要一个标签');
  }

  return { mapId, title, content, tagNames };
}

function parseCookies(header) {
  return Object.fromEntries(
    String(header)
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index === -1) {
          return [part, ''];
        }
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}
