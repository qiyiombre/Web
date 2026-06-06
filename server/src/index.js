import './env.js';
import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createDomainCategory,
  createLog,
  createMap,
  createSession,
  createTag,
  createUser,
  deleteDomainCategory,
  deleteLog,
  deleteSession,
  deleteTag,
  getEdges,
  getDomainCategoryById,
  getLogById,
  getMapById,
  getSessionUser,
  getTagById,
  initializeDatabase,
  listDomainCategories,
  listLogs,
  listMaps,
  listTags,
  normalizeTagNames,
  restoreLogSnapshot,
  restoreTagSnapshot,
  updateDomainCategory,
  updateLog,
  updateMap,
  updateTag,
  verifyUserCredentials
} from './db.js';
import { buildInsights, generateAdvice } from './insights.js';
import { searchTags, suggestTags } from './recommend.js';
import { buildTagGroups, buildTagSimilarities } from './semantic.js';

await initializeDatabase();

const app = express();
const port = Number(process.env.PORT ?? 3001);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.resolve(__dirname, '../../client/dist');
const COOKIE_NAME = 'nebula_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const secureCookies = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(
  asyncRoute(async (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie ?? '');
    req.user = await getSessionUser(cookies[COOKIE_NAME]);
    req.sessionToken = cookies[COOKIE_NAME] ?? '';
    next();
  })
);

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

app.post(
  '/api/auth/register',
  asyncRoute(async (req, res) => {
    const user = await createUser(req.body.username, req.body.password);
    const session = await createSession(user.id);
    setSessionCookie(res, session.token);
    res.status(201).json({ user });
  })
);

app.post(
  '/api/auth/login',
  asyncRoute(async (req, res) => {
    const user = await verifyUserCredentials(req.body.username, req.body.password);
    if (!user) {
      res.status(401).json({ message: '用户名或密码不正确' });
      return;
    }

    const session = await createSession(user.id);
    setSessionCookie(res, session.token);
    res.json({ user });
  })
);

app.post(
  '/api/auth/logout',
  asyncRoute(async (req, res) => {
    await deleteSession(req.sessionToken);
    clearSessionCookie(res);
    res.json({ ok: true });
  })
);

app.use('/api', requireAuth);

app.get(
  '/api/maps',
  asyncRoute(async (req, res) => {
    res.json(await listMaps(req.user.id));
  })
);

app.post(
  '/api/maps',
  asyncRoute(async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    if (!name) {
      res.status(400).json({ message: '星云图名称不能为空' });
      return;
    }
    res.status(201).json(await createMap(name, String(req.body.description ?? ''), req.user.id));
  })
);

app.patch(
  '/api/maps/:id',
  asyncRoute(async (req, res) => {
    const mapId = Number(req.params.id);
    const updated = await updateMap(mapId, req.user.id, {
      name: req.body.name,
      description: req.body.description
    });
    if (!updated) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }
    res.json(updated);
  })
);

app.get(
  '/api/maps/:id/graph',
  asyncRoute(async (req, res) => {
    const mapId = Number(req.params.id);
    const map = await getOwnedMap(mapId, req.user.id);
    if (!map) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }

    const [tagSimilarityResult, tagGroupResult, tags, logs, edges, domainCategories] = await Promise.all([
      buildTagSimilarities(mapId),
      buildTagGroups(mapId),
      listTags(mapId),
      listLogs(mapId),
      getEdges(mapId),
      listDomainCategories(mapId)
    ]);
    res.json({
      map,
      tags,
      logs,
      edges,
      tagSimilarities: tagSimilarityResult.relations,
      tagGroups: tagGroupResult.groups,
      domainCategories,
      aiMeta: {
        tagRelations: tagSimilarityResult.aiMeta,
        tagGroups: tagGroupResult.aiMeta
      }
    });
  })
);

app.get(
  '/api/maps/:id/insights',
  asyncRoute(async (req, res) => {
    const mapId = Number(req.params.id);
    if (!(await getOwnedMap(mapId, req.user.id))) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }
    res.json(await buildInsights(mapId));
  })
);

app.post(
  '/api/maps/:id/advice',
  asyncRoute(async (req, res) => {
    const mapId = Number(req.params.id);
    if (!(await getOwnedMap(mapId, req.user.id))) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }
    res.json(await generateAdvice(mapId));
  })
);

app.get(
  '/api/maps/:id/domain-categories',
  asyncRoute(async (req, res) => {
    const mapId = Number(req.params.id);
    if (!(await getOwnedMap(mapId, req.user.id))) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }
    res.json(await listDomainCategories(mapId));
  })
);

app.post(
  '/api/maps/:id/domain-categories',
  asyncRoute(async (req, res) => {
    const mapId = Number(req.params.id);
    if (!(await getOwnedMap(mapId, req.user.id))) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }
    res.status(201).json(
      await createDomainCategory({
        mapId,
        name: req.body.name,
        color: req.body.color,
        keywords: req.body.keywords
      })
    );
  })
);

app.post(
  '/api/logs',
  asyncRoute(async (req, res) => {
    const payload = normalizeLogPayload(req.body, { requireMapId: true });
    if (!(await getOwnedMap(payload.mapId, req.user.id))) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }
    res.status(201).json(await createLog(payload));
  })
);

app.put(
  '/api/logs/:id',
  asyncRoute(async (req, res) => {
    const logId = Number(req.params.id);
    const existing = await getLogById(logId);
    if (!existing || !(await getOwnedMap(existing.mapId, req.user.id))) {
      res.status(404).json({ message: '日志不存在' });
      return;
    }

    const payload = normalizeLogPayload(req.body, { requireMapId: false });
    const updated = await updateLog(logId, payload);
    if (!updated) {
      res.status(404).json({ message: '日志不存在' });
      return;
    }
    res.json(updated);
  })
);

app.delete(
  '/api/logs/:id',
  asyncRoute(async (req, res) => {
    const logId = Number(req.params.id);
    const existing = await getLogById(logId);
    if (!existing || !(await getOwnedMap(existing.mapId, req.user.id))) {
      res.status(404).json({ message: '日志不存在' });
      return;
    }

    const deleted = await deleteLog(logId);
    if (!deleted) {
      res.status(404).json({ message: '日志不存在' });
      return;
    }
    res.json({ ok: true });
  })
);

app.post(
  '/api/logs/restore',
  asyncRoute(async (req, res) => {
    const mapId = Number(req.body?.mapId);
    if (!(await getOwnedMap(mapId, req.user.id))) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }
    res.status(201).json(await restoreLogSnapshot(req.body));
  })
);

app.put(
  '/api/domain-categories/:id',
  asyncRoute(async (req, res) => {
    const category = await getOwnedDomainCategory(Number(req.params.id), req.user.id);
    if (!category) {
      res.status(404).json({ message: '领域大类不存在' });
      return;
    }
    const updated = await updateDomainCategory(category.id, {
      name: req.body.name,
      color: req.body.color,
      keywords: req.body.keywords
    });
    if (!updated) {
      res.status(404).json({ message: '领域大类不存在' });
      return;
    }
    res.json(updated);
  })
);

app.delete(
  '/api/domain-categories/:id',
  asyncRoute(async (req, res) => {
    const category = await getOwnedDomainCategory(Number(req.params.id), req.user.id);
    if (!category) {
      res.status(404).json({ message: '领域大类不存在' });
      return;
    }
    const result = await deleteDomainCategory(category.id);
    if (!result.deleted) {
      res.status(404).json({ message: '领域大类不存在' });
      return;
    }
    res.json({ ok: true });
  })
);

app.post(
  '/api/tags',
  asyncRoute(async (req, res) => {
    const mapId = Number(req.body.mapId);
    if (!(await getOwnedMap(mapId, req.user.id))) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }
    res.status(201).json(
      await createTag({
        mapId,
        name: req.body.name,
        color: req.body.color
      })
    );
  })
);

app.put(
  '/api/tags/:id',
  asyncRoute(async (req, res) => {
    const tag = await getOwnedTag(Number(req.params.id), req.user.id);
    if (!tag) {
      res.status(404).json({ message: '标签不存在' });
      return;
    }

    const updated = await updateTag(tag.id, {
      name: req.body.name,
      color: req.body.color
    });
    if (!updated) {
      res.status(404).json({ message: '标签不存在' });
      return;
    }
    res.json(updated);
  })
);

app.delete(
  '/api/tags/:id',
  asyncRoute(async (req, res) => {
    const tag = await getOwnedTag(Number(req.params.id), req.user.id);
    if (!tag) {
      res.status(404).json({ message: '标签不存在' });
      return;
    }

    const result = await deleteTag(tag.id);
    if (!result.deleted) {
      res.status(404).json({ message: '标签不存在' });
      return;
    }
    res.json({ ok: true });
  })
);

app.post(
  '/api/tags/restore',
  asyncRoute(async (req, res) => {
    const mapId = Number(req.body?.mapId);
    if (!(await getOwnedMap(mapId, req.user.id))) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }
    res.status(201).json(await restoreTagSnapshot(req.body));
  })
);

app.post(
  '/api/tags/suggest',
  asyncRoute(async (req, res) => {
    const mapId = Number(req.body.mapId);
    const content = String(req.body.content ?? '');
    if (!(await getOwnedMap(mapId, req.user.id))) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }
    res.json(await suggestTags(mapId, content));
  })
);

app.post(
  '/api/tags/search',
  asyncRoute(async (req, res) => {
    const mapId = Number(req.body.mapId);
    const query = String(req.body.query ?? '');
    if (!(await getOwnedMap(mapId, req.user.id))) {
      res.status(404).json({ message: '星云图不存在' });
      return;
    }
    res.json(await searchTags(mapId, query));
  })
);

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

async function getOwnedMap(mapId, userId) {
  if (!Number.isFinite(mapId)) {
    return null;
  }
  return getMapById(mapId, userId);
}

async function getOwnedTag(tagId, userId) {
  if (!Number.isFinite(tagId)) {
    return null;
  }
  const tag = await getTagById(tagId);
  if (!tag || !(await getOwnedMap(tag.mapId, userId))) {
    return null;
  }
  return tag;
}

async function getOwnedDomainCategory(categoryId, userId) {
  if (!Number.isFinite(categoryId)) {
    return null;
  }
  const category = await getDomainCategoryById(categoryId);
  if (!category || !(await getOwnedMap(category.mapId, userId))) {
    return null;
  }
  return category;
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
  res.setHeader('Set-Cookie', buildSessionCookie(`${COOKIE_NAME}=${encodeURIComponent(token)}`, SESSION_MAX_AGE_SECONDS));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', buildSessionCookie(`${COOKIE_NAME}=`, 0));
}

function buildSessionCookie(value, maxAge) {
  return `${value}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${secureCookies ? '; Secure' : ''}`;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
