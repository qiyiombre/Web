import './env.js';
import { createHash, createHmac } from 'node:crypto';
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
  deleteMap,
  deleteSession,
  deleteTag,
  getEdges,
  getDomainCategoryById,
  getLogById,
  getMapById,
  getSessionUser,
  getTagById,
  getUserPreferences,
  initializeDatabase,
  listDomainCategories,
  listLogs,
  listMaps,
  listTags,
  normalizeTagNames,
  restoreLogSnapshot,
  restoreTagSnapshot,
  setUserPreferences,
  updateDomainCategory,
  updateLog,
  updateMap,
  updateUserPassword,
  updateTag,
  verifyUserCredentials
} from './db.js';
import { buildInsights, generateAdvice } from './insights.js';
import { searchTags, suggestTags } from './recommend.js';
import { buildTagGroups, buildTagSimilarities } from './semantic.js';
import { createCorsMiddleware, createRateLimiter, securityHeaders } from './security.js';
import { callDeepSeekJson, hasDeepSeekKey } from './deepseek.js';

await initializeDatabase();

const app = express();
const port = Number(process.env.PORT ?? 3001);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.resolve(__dirname, '../../client/dist');
const COOKIE_NAME = 'nebula_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const secureCookies = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
const authRateLimit = createRateLimiter();

app.set('trust proxy', 1);
app.use(securityHeaders);
app.use(createCorsMiddleware());
app.use(express.json({ limit: '1mb' }));

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
  authRateLimit,
  asyncRoute(async (req, res) => {
    const user = await createUser(req.body.username, req.body.password);
    const session = await createSession(user.id);
    setSessionCookie(res, session.token);
    res.status(201).json({ user });
  })
);

app.post(
  '/api/auth/login',
  authRateLimit,
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
  '/api/user/preferences',
  asyncRoute(async (req, res) => {
    res.json(await getUserPreferences(req.user.id));
  })
);

app.put(
  '/api/user/preferences',
  asyncRoute(async (req, res) => {
    const preferences = normalizeUserPreferences(req.body?.preferences ?? req.body);
    res.json(await setUserPreferences(req.user.id, preferences));
  })
);

app.put(
  '/api/auth/password',
  authRateLimit,
  asyncRoute(async (req, res) => {
    const changed = await updateUserPassword(req.user.id, req.body?.currentPassword, req.body?.newPassword);
    if (!changed) {
      res.status(400).json({ message: '当前密码不正确' });
      return;
    }
    res.json({ ok: true });
  })
);

app.post(
  '/api/assistant',
  asyncRoute(async (req, res) => {
    const message = String(req.body?.message ?? '').trim();
    const currentMapId = Number(req.body?.currentMapId);
    if (!message) {
      res.status(400).json({ message: '助手指令不能为空' });
      return;
    }
    res.json(await resolveAssistantIntent({
      userId: req.user.id,
      message,
      currentMapId: Number.isFinite(currentMapId) ? currentMapId : null
    }));
  })
);

app.post(
  '/api/assistant/transcribe',
  express.raw({
    type: ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'application/octet-stream'],
    limit: '12mb'
  }),
  asyncRoute(async (req, res) => {
    const audioBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    if (audioBuffer.length < 256) {
      res.status(400).json({ message: '录音内容太短，请重新录制' });
      return;
    }
    const text = await transcribeAssistantAudio(audioBuffer, String(req.headers['content-type'] ?? 'audio/webm'));
    res.json({ text });
  })
);

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

app.delete(
  '/api/maps/:id',
  asyncRoute(async (req, res) => {
    const mapId = Number(req.params.id);
    const deleted = await deleteMap(mapId, req.user.id);
    if (!deleted) {
      res.status(404).json({ message: '鏄熶簯鍥句笉瀛樺湪' });
      return;
    }
    res.json({ ok: true });
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
    const range =
      'timeFilter' in req.query || 'customStartDate' in req.query || 'customEndDate' in req.query
        ? {
            timeFilter: firstQueryValue(req.query.timeFilter),
            customStartDate: firstQueryValue(req.query.customStartDate),
            customEndDate: firstQueryValue(req.query.customEndDate)
          }
        : null;
    res.json(await buildInsights(mapId, range));
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
    res.json(await generateAdvice(mapId, req.body ?? {}));
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
  const status = statusForError(error);
  if (status >= 500) {
    console.error(error);
  } else {
    console.warn(error.message ?? error);
  }
  res.status(status).json({ message: status >= 500 ? 'Server error' : error.message ?? 'Bad request' });
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

async function resolveAssistantIntent({ userId, message, currentMapId }) {
  const context = await buildAssistantContext(userId, currentMapId);
  if (!hasDeepSeekKey()) {
    return localAssistantIntent(message, context, 'DeepSeek 未配置，已使用本地规则处理。');
  }

  try {
    const result = await callDeepSeekJson({
      system: ASSISTANT_SYSTEM_PROMPT,
      user: JSON.stringify({
        userMessage: message,
        currentMap: context.currentMap ? pickMapContext(context.currentMap) : null,
        maps: context.maps.map(pickMapContext),
        currentMapStats: context.stats,
        currentMapTags: context.tags.slice(0, 30).map((tag) => ({ name: tag.name, count: tag.count })),
        recentLogs: context.logs.slice(0, 12).map((log) => ({
          title: log.title,
          contentPreview: String(log.content ?? '').slice(0, 90),
          tags: log.tags.map((tag) => tag.name),
          createdAt: log.createdAt
        }))
      }),
      temperature: 0.15,
      maxTokens: 900
    });
    return normalizeAssistantIntent(result, context);
  } catch (error) {
    console.warn(error.message ?? error);
    return localAssistantIntent(message, context, 'DeepSeek 暂时不可用，已使用本地规则处理。');
  }
}

async function buildAssistantContext(userId, currentMapId) {
  const maps = await listMaps(userId);
  const currentMap = maps.find((map) => map.id === currentMapId) ?? maps[0] ?? null;
  const [logs, tags] = currentMap
    ? await Promise.all([listLogs(currentMap.id), listTags(currentMap.id)])
    : [[], []];
  return {
    maps,
    currentMap,
    logs,
    tags,
    stats: summarizeAssistantMap(currentMap, logs, tags)
  };
}

function summarizeAssistantMap(map, logs, tags) {
  const topTags = [...tags].sort((a, b) => b.count - a.count).slice(0, 6);
  const recentLogs = [...logs]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);
  return {
    mapName: map?.name ?? '',
    logCount: logs.length,
    tagCount: tags.length,
    topTags: topTags.map((tag) => ({ name: tag.name, count: tag.count })),
    recentLogTitles: recentLogs.map((log) => log.title)
  };
}

function pickMapContext(map) {
  return {
    id: map.id,
    name: map.name,
    description: map.description
  };
}

const ASSISTANT_ACTIONS = new Set([
  'none',
  'create_log',
  'search_logs',
  'open_map',
  'open_logs',
  'open_insights',
  'open_settings',
  'open_home',
  'show_stats',
  'summarize_map'
]);

const ASSISTANT_SYSTEM_PROMPT = `
你是“星云日志”的操作助手。你只能返回 JSON，不能返回 Markdown。
你的任务是把用户自然语言转换成一个安全的白名单动作。

允许的 action:
- none: 只回复，不执行操作
- create_log: 准备新建日志，payload 必须包含 title, content, tagNames
- search_logs: 搜索日志，payload.query
- open_map: 打开某个星图，payload.mapId
- open_logs: 打开当前或指定星图日志页，payload.mapId
- open_insights: 打开当前或指定星图洞察页，payload.mapId
- open_settings: 打开设置页
- open_home: 打开首页
- show_stats: 展示当前星图统计
- summarize_map: 总结当前星图

返回格式:
{
  "reply": "给用户看的简短中文回复",
  "action": "allowed_action",
  "confidence": 0.0,
  "requiresConfirmation": false,
  "payload": {}
}

规则:
- 不要直接删除、修改密码、改设置、删除日志、删除标签。
- create_log 必须 requiresConfirmation=true。
- 如果用户要创建日志但信息不足，也可以根据用户原话生成草稿标题和内容。
- 如果涉及星图，优先使用 currentMap；用户明确说出星图名时，使用 maps 里最匹配的 mapId。
- show_stats 和 summarize_map 可以直接根据 currentMapStats/recentLogs/currentMapTags 给出 reply。
`.trim();

function normalizeAssistantIntent(raw, context) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const action = ASSISTANT_ACTIONS.has(source.action) ? source.action : 'none';
  const payload = source.payload && typeof source.payload === 'object' && !Array.isArray(source.payload)
    ? source.payload
    : {};
  const normalized = {
    reply: limitText(source.reply || defaultAssistantReply(action, context), 360),
    action,
    confidence: clampNumber(source.confidence, 0, 1, 0.55),
    requiresConfirmation: Boolean(source.requiresConfirmation),
    payload: normalizeAssistantPayload(action, payload, context)
  };

  if (action === 'create_log') {
    normalized.requiresConfirmation = true;
  }
  if (['open_map', 'open_logs', 'open_insights'].includes(action) && !normalized.payload.mapId) {
    normalized.action = context.currentMap ? action : 'none';
    normalized.payload = context.currentMap ? { mapId: context.currentMap.id } : {};
  }
  return normalized;
}

function normalizeAssistantPayload(action, payload, context) {
  if (action === 'create_log') {
    return {
      mapId: ownedAssistantMapId(payload.mapId, context) ?? context.currentMap?.id ?? null,
      title: limitText(payload.title || '助手记录', 80),
      content: limitText(payload.content || payload.summary || '通过星云助手创建的日志。', 4000),
      tagNames: normalizeTagNames(payload.tagNames ?? payload.tags ?? []).slice(0, 8)
    };
  }
  if (action === 'search_logs') {
    return {
      mapId: ownedAssistantMapId(payload.mapId, context) ?? context.currentMap?.id ?? null,
      query: limitText(payload.query || payload.keyword || '', 80)
    };
  }
  if (['open_map', 'open_logs', 'open_insights'].includes(action)) {
    return {
      mapId: ownedAssistantMapId(payload.mapId, context) ?? findAssistantMapId(payload.mapName, context) ?? context.currentMap?.id ?? null
    };
  }
  if (action === 'show_stats' || action === 'summarize_map') {
    return {
      mapId: context.currentMap?.id ?? null,
      stats: context.stats
    };
  }
  return {};
}

function ownedAssistantMapId(mapId, context) {
  const id = Number(mapId);
  if (!Number.isFinite(id)) return null;
  return context.maps.some((map) => map.id === id) ? id : null;
}

function findAssistantMapId(mapName, context) {
  const name = String(mapName ?? '').trim().toLowerCase();
  if (!name) return null;
  return context.maps.find((map) => map.name.toLowerCase().includes(name) || name.includes(map.name.toLowerCase()))?.id ?? null;
}

function localAssistantIntent(message, context, prefix = '') {
  const text = message.trim();
  const lower = text.toLowerCase();
  const prefixText = prefix ? `${prefix} ` : '';

  const namedMapId = context.maps.find((map) => text.includes(map.name))?.id ?? null;
  if (text.includes('设置')) {
    return normalizeAssistantIntent({ reply: `${prefixText}正在打开设置页。`, action: 'open_settings', payload: {} }, context);
  }
  if (text.includes('首页') || lower.includes('home')) {
    return normalizeAssistantIntent({ reply: `${prefixText}正在回到首页。`, action: 'open_home', payload: {} }, context);
  }
  if (text.includes('洞察') || text.includes('分析')) {
    return normalizeAssistantIntent({ reply: `${prefixText}正在打开洞察页。`, action: 'open_insights', payload: { mapId: namedMapId } }, context);
  }
  if (text.includes('日志页') || text.includes('日志列表') || (text.includes('打开') && text.includes('日志'))) {
    return normalizeAssistantIntent({ reply: `${prefixText}正在打开日志页。`, action: 'open_logs', payload: { mapId: namedMapId } }, context);
  }
  if (namedMapId) {
    return normalizeAssistantIntent({ reply: `${prefixText}正在打开指定星图。`, action: 'open_map', payload: { mapId: namedMapId } }, context);
  }
  if (text.includes('搜索') || text.includes('查找') || text.includes('找')) {
    const query = text.replace(/^(帮我|请|搜索|查找|找|一下|日志)/g, '').trim() || text;
    return normalizeAssistantIntent({ reply: `${prefixText}我会在当前星图里搜索相关日志。`, action: 'search_logs', payload: { query } }, context);
  }
  if (text.includes('统计') || text.includes('多少') || text.includes('高频')) {
    return normalizeAssistantIntent({ reply: `${prefixText}${formatStatsReply(context.stats)}`, action: 'show_stats', payload: {} }, context);
  }
  if (text.includes('总结') || text.includes('概括')) {
    return normalizeAssistantIntent({ reply: `${prefixText}${formatSummaryReply(context.stats)}`, action: 'summarize_map', payload: {} }, context);
  }
  if (text.includes('新建') || text.includes('创建') || text.includes('写一篇') || text.includes('记录')) {
    const tagMatch = text.match(/标签(?:是|为|:|：)?([^，。；;]+)/);
    const tags = tagMatch ? tagMatch[1].split(/[、,，\s]+/).filter(Boolean) : [];
    const titleMatch = text.match(/关于([^，。；;]+)|标题(?:是|为|:|：)([^，。；;]+)/);
    const title = titleMatch?.[1] || titleMatch?.[2] || '助手记录';
    return normalizeAssistantIntent({
      reply: `${prefixText}我整理了一篇日志草稿，确认后会写入当前星图。`,
      action: 'create_log',
      requiresConfirmation: true,
      payload: {
        title,
        content: text,
        tagNames: tags.length ? tags : ['助手记录']
      }
    }, context);
  }
  return normalizeAssistantIntent({ reply: `${prefixText}我可以帮你新建日志、搜索日志、打开日志页/洞察页/设置页，或者查看当前星图统计。`, action: 'none' }, context);
}

function defaultAssistantReply(action, context) {
  if (action === 'show_stats') return formatStatsReply(context.stats);
  if (action === 'summarize_map') return formatSummaryReply(context.stats);
  if (action === 'create_log') return '我整理了一篇日志草稿，确认后会写入当前星图。';
  return '我已经理解你的指令。';
}

function formatStatsReply(stats) {
  const topTags = stats.topTags.length
    ? stats.topTags.map((tag) => `${tag.name}(${tag.count})`).join('、')
    : '暂无高频标签';
  return `当前星图「${stats.mapName || '未命名'}」有 ${stats.logCount} 篇日志、${stats.tagCount} 个标签。高频标签：${topTags}。`;
}

function formatSummaryReply(stats) {
  const recent = stats.recentLogTitles.length ? stats.recentLogTitles.join('、') : '暂无最近日志';
  return `当前星图「${stats.mapName || '未命名'}」主要由 ${stats.logCount} 篇日志和 ${stats.tagCount} 个标签构成。最近记录包括：${recent}。`;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function limitText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

async function transcribeAssistantAudio(audioBuffer, contentType) {
  if (process.env.TENCENTCLOUD_SECRET_ID && process.env.TENCENTCLOUD_SECRET_KEY) {
    return transcribeWithTencentCloud(audioBuffer, contentType);
  }

  const apiKey = process.env.SPEECH_TO_TEXT_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error('语音转文字密钥未配置，请在 .env 中设置 TENCENTCLOUD_SECRET_ID 和 TENCENTCLOUD_SECRET_KEY');
    error.statusCode = 503;
    throw error;
  }

  const endpoint = process.env.SPEECH_TO_TEXT_ENDPOINT || 'https://api.openai.com/v1/audio/transcriptions';
  const model = process.env.SPEECH_TO_TEXT_MODEL || 'whisper-1';
  const timeoutMs = clampInteger(process.env.SPEECH_TO_TEXT_TIMEOUT_MS, 3000, 60000, 25000);
  const language = String(process.env.SPEECH_TO_TEXT_LANGUAGE ?? 'zh').trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const form = new FormData();
    const mimeType = normalizeAudioContentType(contentType);
    form.append('file', new Blob([audioBuffer], { type: mimeType }), audioFilenameForContentType(mimeType));
    form.append('model', model);
    if (language) {
      form.append('language', language);
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: form,
      signal: controller.signal
    });
    const bodyText = await response.text();
    const body = safeJsonParse(bodyText);
    if (!response.ok) {
      const detail = body?.error?.message || body?.message || bodyText.slice(0, 160) || response.statusText;
      const error = new Error(`语音转文字失败：${detail}`);
      error.statusCode = response.status === 401 || response.status === 403 ? 502 : 400;
      throw error;
    }

    const transcript = String(body?.text ?? body?.data?.text ?? '').trim();
    if (!transcript) {
      const error = new Error('语音转文字没有返回文本，请重新录制');
      error.statusCode = 502;
      throw error;
    }
    return limitText(transcript, 2000);
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('语音转文字超时，请稍后再试');
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function transcribeWithTencentCloud(audioBuffer, contentType) {
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  const endpoint = 'https://asr.tencentcloudapi.com';
  const host = 'asr.tencentcloudapi.com';
  const service = 'asr';
  const action = 'SentenceRecognition';
  const version = '2019-06-14';
  const region = process.env.TENCENTCLOUD_ASR_REGION || 'ap-shanghai';
  const timeoutMs = clampInteger(process.env.TENCENTCLOUD_ASR_TIMEOUT_MS, 3000, 60000, 25000);
  const voiceFormat = tencentVoiceFormatForContentType(contentType);
  const payload = JSON.stringify({
    ProjectId: 0,
    SubServiceType: 2,
    EngSerViceType: process.env.TENCENTCLOUD_ASR_ENGINE || '16k_zh',
    SourceType: 1,
    VoiceFormat: voiceFormat,
    Data: audioBuffer.toString('base64'),
    DataLen: audioBuffer.length,
    FilterDirty: 0,
    FilterModal: 0,
    FilterPunc: 0,
    ConvertNumMode: 1
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const authorization = buildTencentCloudAuthorization({
    secretId,
    secretKey,
    service,
    host,
    payload,
    timestamp
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        Host: host,
        'X-TC-Action': action,
        'X-TC-Version': version,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Region': region
      },
      body: payload,
      signal: controller.signal
    });
    const bodyText = await response.text();
    const body = safeJsonParse(bodyText);
    const apiError = body?.Response?.Error;
    if (!response.ok || apiError) {
      const detail = apiError?.Message || body?.message || bodyText.slice(0, 160) || response.statusText;
      const error = new Error(`腾讯云语音识别失败：${detail}`);
      error.statusCode = response.status === 401 || response.status === 403 ? 502 : 400;
      throw error;
    }

    const transcript = String(body?.Response?.Result ?? '').trim();
    if (!transcript) {
      const error = new Error('腾讯云没有返回识别文字，请重新录制');
      error.statusCode = 502;
      throw error;
    }
    return limitText(transcript, 2000);
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('腾讯云语音识别超时，请稍后再试');
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildTencentCloudAuthorization({ secretId, secretKey, service, host, payload, timestamp }) {
  const algorithm = 'TC3-HMAC-SHA256';
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const httpRequestMethod = 'POST';
  const canonicalUri = '/';
  const canonicalQueryString = '';
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const hashedRequestPayload = sha256Hex(payload);
  const canonicalRequest = [
    httpRequestMethod,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    hashedRequestPayload
  ].join('\n');
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    algorithm,
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join('\n');
  const secretDate = hmacSha256(date, `TC3${secretKey}`);
  const secretService = hmacSha256(service, secretDate);
  const secretSigning = hmacSha256('tc3_request', secretService);
  const signature = hmacSha256Hex(stringToSign, secretSigning);
  return `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacSha256(value, key) {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function hmacSha256Hex(value, key) {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

function tencentVoiceFormatForContentType(contentType) {
  const lower = String(contentType ?? '').toLowerCase();
  if (lower.includes('ogg')) return 'ogg-opus';
  if (lower.includes('mp4') || lower.includes('m4a')) return 'm4a';
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3';
  if (lower.includes('wav')) return 'wav';
  return 'wav';
}

function normalizeAudioContentType(contentType) {
  const lower = String(contentType ?? '').toLowerCase();
  if (lower.includes('ogg')) return 'audio/ogg';
  if (lower.includes('mp4') || lower.includes('m4a')) return 'audio/mp4';
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'audio/mpeg';
  if (lower.includes('wav')) return 'audio/wav';
  return 'audio/webm';
}

function audioFilenameForContentType(contentType) {
  if (contentType === 'audio/ogg') return 'voice.ogg';
  if (contentType === 'audio/mp4') return 'voice.m4a';
  if (contentType === 'audio/mpeg') return 'voice.mp3';
  if (contentType === 'audio/wav') return 'voice.wav';
  return 'voice.webm';
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeUserPreferences(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const highFrequencyMinimum = clampInteger(source.highFrequencyMinimum, 2, 99, 2);
  const lowFrequencyMaximum = Math.min(
    clampInteger(source.lowFrequencyMaximum, 1, 98, 1),
    Math.max(1, highFrequencyMinimum - 1)
  );
  const nebulaHeatMinimumDelta = clampInteger(source.nebulaHeatMinimumDelta, 1, 99, 1);
  const nebulaHeatMediumDelta = Math.max(
    nebulaHeatMinimumDelta,
    clampInteger(source.nebulaHeatMediumDelta, 1, 99, 2)
  );
  const nebulaHeatStrongDelta = Math.max(
    nebulaHeatMediumDelta,
    clampInteger(source.nebulaHeatStrongDelta, 1, 99, 4)
  );
  return {
    rendererMode: source.rendererMode === 'webgpu' ? 'webgpu' : 'canvas',
    layoutMode: source.layoutMode === 'domain' ? 'domain' : 'semantic',
    themeMode: ['obsidian', 'ember', 'moss', 'burgundy'].includes(source.themeMode) ? source.themeMode : 'deepSpace',
    timeFilter: ['week', 'month', 'quarter', 'custom'].includes(source.timeFilter) ? source.timeFilter : 'all',
    frequencyFilter: source.frequencyFilter === 'high' || source.frequencyFilter === 'low' ? source.frequencyFilter : 'all',
    highFrequencyMinimum,
    lowFrequencyMaximum,
    insightTopLimit: clampInteger(source.insightTopLimit, 3, 20, 8),
    insightTrendLimit: clampInteger(source.insightTrendLimit, 3, 20, 5),
    insightCooccurrenceLimit: clampInteger(source.insightCooccurrenceLimit, 3, 20, 8),
    nebulaPriorityDisplayLimit: clampInteger(source.nebulaPriorityDisplayLimit, 0, 30, 8),
    nebulaHeatWindowDays: clampInteger(source.nebulaHeatWindowDays, 1, 90, 7),
    nebulaHeatMinimumDelta,
    nebulaHeatMediumDelta,
    nebulaHeatStrongDelta,
    nebulaHeatFlatOpacity: clampInteger(source.nebulaHeatFlatOpacity, 5, 80, 28),
    nebulaLogDensityMode: source.nebulaLogDensityMode === 'single' ? 'single' : 'auto',
    sortMode: ['frequency', 'lowFrequency', 'recent'].includes(source.sortMode) ? source.sortMode : 'layout',
    customStartDate: normalizeIsoDate(source.customStartDate),
    customEndDate: normalizeIsoDate(source.customEndDate)
  };
}

function clampInteger(value, min, max, fallback) {
  const next = Number(value);
  if (!Number.isFinite(next)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(next)));
}

function normalizeIsoDate(value) {
  const clean = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(clean) ? clean : '';
}

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
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

function statusForError(error) {
  if (Number.isInteger(error?.statusCode)) {
    return error.statusCode;
  }
  if (error?.type === 'entity.parse.failed') {
    return 400;
  }
  if (error?.code === '23505') {
    return 409;
  }
  if (error?.code) {
    return 500;
  }
  return 400;
}
