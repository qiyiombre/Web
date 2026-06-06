import { getAiCache, getTagCooccurrence, listDomainCategories, listTags, setAiCache } from './db.js';
import { callDeepSeekJson, hasDeepSeekKey } from './deepseek.js';

const RELATION_FAILURE_TTL_MS = 5 * 60 * 1000;
const recentRelationFailures = new Map();
const recentGroupFailures = new Map();

const OTHER_GROUP = {
  id: 0,
  mapId: 0,
  name: '其他',
  color: '#d9e8f7',
  keywords: [],
  sortOrder: 999
};

export async function buildTagSimilarities(mapId) {
  const [tags, cooccurrence, domainCategories] = await Promise.all([
    listTags(mapId),
    getTagCooccurrence(mapId),
    listDomainCategories(mapId)
  ]);
  const local = buildLocalSimilarities(tags, cooccurrence, domainCategories);

  if (!hasDeepSeekKey() || tags.length < 2) {
    return {
      relations: local,
      aiMeta: {
        feature: 'tagRelations',
        source: 'local',
        attempted: false,
        message: !hasDeepSeekKey() ? '未配置 DeepSeek Key，语义关系使用本地算法' : '标签数量不足，语义关系使用本地算法'
      }
    };
  }

  const cacheKey = buildRelationCacheKey(mapId, tags, cooccurrence);
  const cached = await getAiCache(cacheKey);
  if (Array.isArray(cached) && cached.length > 0) {
    return {
      relations: mergeAiAndLocal(cached, local),
      aiMeta: {
        feature: 'tagRelations',
        source: 'cache',
        attempted: false,
        message: '语义关系使用 DeepSeek 缓存结果'
      }
    };
  }

  const recentFailure = recentRelationFailures.get(cacheKey);
  if (recentFailure && Date.now() - recentFailure.at < RELATION_FAILURE_TTL_MS) {
    return {
      relations: local,
      aiMeta: {
        feature: 'tagRelations',
        source: 'local',
        attempted: false,
        message: `DeepSeek 语义关系最近调用失败，暂时使用本地算法：${recentFailure.message}`
      }
    };
  }

  try {
    const aiRelations = await requestDeepSeekRelations(tags, cooccurrence);
    if (aiRelations.length > 0) {
      await setAiCache(cacheKey, aiRelations);
      recentRelationFailures.delete(cacheKey);
    } else {
      recentRelationFailures.set(cacheKey, {
        at: Date.now(),
        message: 'DeepSeek 未返回有效标签关系'
      });
    }
    return {
      relations: mergeAiAndLocal(aiRelations, local),
      aiMeta: {
        feature: 'tagRelations',
        source: aiRelations.length > 0 ? 'deepseek' : 'local',
        attempted: true,
        message: aiRelations.length > 0 ? 'DeepSeek 语义关系调用成功' : 'DeepSeek 未返回有效语义关系，已使用本地算法'
      }
    };
  } catch (error) {
    console.warn(`DeepSeek tag relation unavailable, using local fallback: ${error.message}`);
    recentRelationFailures.set(cacheKey, {
      at: Date.now(),
      message: error.message
    });
    return {
      relations: local,
      aiMeta: {
        feature: 'tagRelations',
        source: 'local',
        attempted: true,
        message: `DeepSeek 语义关系调用失败，已使用本地算法：${error.message}`
      }
    };
  }
}

export async function buildTagGroups(mapId) {
  const [tags, domainCategories] = await Promise.all([listTags(mapId), listDomainCategories(mapId)]);
  const local = buildLocalTagGroups(tags, domainCategories);

  if (!hasDeepSeekKey() || tags.length < 2) {
    return {
      groups: local,
      aiMeta: {
        feature: 'tagGroups',
        source: 'local',
        attempted: false,
        message: !hasDeepSeekKey() ? '未配置 DeepSeek Key，领域分组使用本地规则' : '标签数量不足，领域分组使用本地规则'
      }
    };
  }

  const cacheKey = buildGroupCacheKey(mapId, tags, domainCategories);
  const cached = await getAiCache(cacheKey);
  if (Array.isArray(cached) && cached.length > 0) {
    return {
      groups: normalizeTagGroups(cached, tags, 'deepseek', domainCategories),
      aiMeta: {
        feature: 'tagGroups',
        source: 'cache',
        attempted: false,
        message: '领域分组使用 DeepSeek 缓存结果'
      }
    };
  }

  const recentFailure = recentGroupFailures.get(cacheKey);
  if (recentFailure && Date.now() - recentFailure.at < RELATION_FAILURE_TTL_MS) {
    return {
      groups: local,
      aiMeta: {
        feature: 'tagGroups',
        source: 'local',
        attempted: false,
        message: `DeepSeek 领域分组最近调用失败，暂时使用本地规则：${recentFailure.message}`
      }
    };
  }

  try {
    const aiGroups = await requestDeepSeekTagGroups(tags, domainCategories);
    if (aiGroups.length > 0) {
      await setAiCache(cacheKey, aiGroups);
      recentGroupFailures.delete(cacheKey);
    } else {
      recentGroupFailures.set(cacheKey, {
        at: Date.now(),
        message: 'DeepSeek 未返回有效领域分组'
      });
    }
    return {
      groups: aiGroups.length > 0 ? normalizeTagGroups(aiGroups, tags, 'deepseek', domainCategories) : local,
      aiMeta: {
        feature: 'tagGroups',
        source: aiGroups.length > 0 ? 'deepseek' : 'local',
        attempted: true,
        message: aiGroups.length > 0 ? 'DeepSeek 领域分组调用成功' : 'DeepSeek 未返回有效领域分组，已使用本地规则'
      }
    };
  } catch (error) {
    console.warn(`DeepSeek tag grouping unavailable, using local fallback: ${error.message}`);
    recentGroupFailures.set(cacheKey, {
      at: Date.now(),
      message: error.message
    });
    return {
      groups: local,
      aiMeta: {
        feature: 'tagGroups',
        source: 'local',
        attempted: true,
        message: `DeepSeek 领域分组调用失败，已使用本地规则：${error.message}`
      }
    };
  }
}

async function requestDeepSeekRelations(tags, cooccurrence) {
  const payload = {
    tags: tags.map((tag) => ({ id: tag.id, name: tag.name, count: tag.count })),
    cooccurrence: cooccurrence.map((item) => ({
      tagAId: item.tagAId,
      tagBId: item.tagBId,
      count: item.count
    }))
  };

  const result = await callDeepSeekJson({
    system:
      '你是一个个人日志知识图谱分析器。请以语义、同义近义、同一领域为主判断标签关系；共现次数只能作为弱辅助。只返回合法 JSON，不要输出 Markdown。',
    user: `根据下面的标签和共现数据，输出适合“语义优先星云图布局”的标签关系评分。

要求：
1. 只返回 JSON 对象，格式为 {"relations":[{"tagAId":1,"tagBId":2,"score":0.8,"reason":"..."}]}。
2. score 范围是 0 到 1，越高表示两个标签越应该靠近。
3. 同义、近义、同一领域、相同生活主题应明显提高分数。
4. 共现次数只占很小权重；如果两个标签语义无关，不要只因为共现多就给高分。
5. 只返回 score >= 0.35 的关系，最多 30 条。
6. tagAId 必须小于 tagBId。

数据：
${JSON.stringify(payload)}`,
    temperature: 0.15,
    maxTokens: 2400
  });

  return normalizeRelations(result.relations ?? []);
}

async function requestDeepSeekTagGroups(tags, domainCategories) {
  const payload = {
    tags: tags.map((tag) => ({ id: tag.id, name: tag.name, count: tag.count })),
    preferredGroups: domainCategories.map((category) => ({
      name: category.name,
      keywords: category.keywords
    }))
  };
  const preferredNames = [...domainCategories.map((category) => category.name), OTHER_GROUP.name].join('、') || OTHER_GROUP.name;

  const result = await callDeepSeekJson({
    system:
      '你是一个个人日志标签分类器。请把标签按领域主题分组，适合星云图把每个领域放成一片星区。只返回合法 JSON，不要输出 Markdown。',
    user: `请把下面的标签分成若干领域组。

要求：
1. 只返回 JSON 对象，格式为 {"groups":[{"name":"技术","tagIds":[1,2],"reason":"..."}]}。
2. 优先使用这些大类名称：${preferredNames}。
3. 如果标签明显不属于这些类，可以使用一个简短的新领域名。
4. 每个 tagId 必须且只能出现在一个组里。
5. 组数控制在 3 到 8 个；空组不要返回。

数据：
${JSON.stringify(payload)}`,
    temperature: 0.12,
    maxTokens: 1800
  });

  return Array.isArray(result.groups) ? result.groups : [];
}

function mergeAiAndLocal(aiRelations, localRelations) {
  const merged = new Map(localRelations.map((relation) => [pairKey(relation.tagAId, relation.tagBId), relation]));

  for (const relation of normalizeRelations(aiRelations)) {
    const key = pairKey(relation.tagAId, relation.tagBId);
    const local = merged.get(key);
    merged.set(key, {
      tagAId: relation.tagAId,
      tagBId: relation.tagBId,
      score: Number(Math.max(relation.score, local?.score ?? 0).toFixed(4)),
      semanticScore: Number(relation.score.toFixed(4)),
      cooccurrenceScore: local?.cooccurrenceScore ?? 0,
      source: 'deepseek',
      reason: relation.reason || 'DeepSeek 判断两个标签语义或行为关系接近'
    });
  }

  return [...merged.values()].sort((a, b) => b.score - a.score);
}

function buildLocalSimilarities(tags, cooccurrence, domainCategories) {
  const tagCountById = new Map(tags.map((tag) => [tag.id, Number(tag.count || 0)]));
  const cooccurrenceByPair = new Map(cooccurrence.map((row) => [pairKey(row.tagAId, row.tagBId), Number(row.count || 0)]));
  const relations = [];

  for (let i = 0; i < tags.length; i += 1) {
    for (let j = i + 1; j < tags.length; j += 1) {
      const a = tags[i];
      const b = tags[j];
      const coScore = cooccurrenceScore(cooccurrenceByPair.get(pairKey(a.id, b.id)) || 0, tagCountById.get(a.id) || 0, tagCountById.get(b.id) || 0);
      const semantic = localSemanticScore(a.name, b.name, domainCategories);
      const score = semantic * 0.85 + coScore * 0.15;

      if (score >= 0.18 || semantic >= 0.2) {
        relations.push({
          tagAId: a.id,
          tagBId: b.id,
          score: Number(score.toFixed(4)),
          semanticScore: Number(semantic.toFixed(4)),
          cooccurrenceScore: Number(coScore.toFixed(4)),
          source: 'local',
          reason: semantic >= 0.2 ? '本地语义或领域相似' : '本地弱共现关系'
        });
      }
    }
  }

  return relations.sort((a, b) => b.score - a.score);
}

function buildLocalTagGroups(tags, domainCategories) {
  const rules = [...domainCategories, OTHER_GROUP];
  const buckets = new Map(rules.map((rule) => [rule.name, { rule, tags: [] }]));
  for (const tag of tags) {
    const rule = classifyLocalGroup(tag.name, domainCategories);
    buckets.get(rule.name)?.tags.push(tag);
  }

  return [...buckets.values()]
    .filter((bucket) => bucket.tags.length > 0)
    .map((bucket, index) => ({
      id: groupId(bucket.rule.name),
      name: bucket.rule.name,
      color: bucket.rule.color,
      tagIds: bucket.tags.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).map((tag) => tag.id),
      source: 'local',
      reason: '本地领域规则'
    }))
    .sort((a, b) => groupOrder(a.name, domainCategories) - groupOrder(b.name, domainCategories) || b.tagIds.length - a.tagIds.length);
}

function normalizeTagGroups(rawGroups, tags, source, domainCategories) {
  const validIds = new Set(tags.map((tag) => tag.id));
  const assigned = new Set();
  const groups = [];

  for (const rawGroup of rawGroups) {
    const name = normalizeGroupName(rawGroup?.name);
    const tagIds = uniqueNumbers(rawGroup?.tagIds).filter((id) => validIds.has(id) && !assigned.has(id));
    if (tagIds.length === 0) {
      continue;
    }
    for (const id of tagIds) {
      assigned.add(id);
    }
    groups.push({
      id: groupId(name),
      name,
      color: groupColor(name, domainCategories),
      tagIds,
      source,
      reason: String(rawGroup?.reason ?? '').slice(0, 80)
    });
  }

  const remaining = tags.filter((tag) => !assigned.has(tag.id));
  if (remaining.length > 0) {
    mergeLocalGroups(groups, buildLocalTagGroups(remaining, domainCategories));
  }

  return groups
    .filter((group) => group.tagIds.length > 0)
    .sort((a, b) => groupOrder(a.name, domainCategories) - groupOrder(b.name, domainCategories) || b.tagIds.length - a.tagIds.length);
}

function mergeLocalGroups(groups, localGroups) {
  for (const localGroup of localGroups) {
    const existing = groups.find((group) => group.name === localGroup.name);
    if (existing) {
      existing.tagIds = [...new Set([...existing.tagIds, ...localGroup.tagIds])];
    } else {
      groups.push(localGroup);
    }
  }
}

function classifyLocalGroup(name, domainCategories) {
  return (
    domainCategories.find((rule) => [rule.name, ...rule.keywords].some((keyword) => keywordMatches(name, keyword))) ??
    OTHER_GROUP
  );
}

function keywordMatches(name, keyword) {
  const cleanName = String(name ?? '').trim().toLowerCase();
  const cleanKeyword = String(keyword ?? '').trim().toLowerCase();
  return cleanName === cleanKeyword || cleanName.includes(cleanKeyword) || cleanKeyword.includes(cleanName);
}

function normalizeGroupName(name) {
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 12);
  return clean || OTHER_GROUP.name;
}

function uniqueNumbers(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(Number).filter((value) => Number.isFinite(value) && value > 0))];
}

function groupId(name) {
  return `group-${hashString(name)}`;
}

function groupColor(name, domainCategories) {
  const rules = [...domainCategories, OTHER_GROUP];
  const rule = rules.find((item) => item.name === name);
  return rule?.color ?? (rules.length > 1 ? rules[hashString(name).charCodeAt(0) % (rules.length - 1)].color : OTHER_GROUP.color);
}

function groupOrder(name, domainCategories) {
  const index = domainCategories.findIndex((rule) => rule.name === name);
  return index === -1 ? domainCategories.length : index;
}

function localSemanticScore(a, b, domainCategories) {
  const categoryScore = categorySimilarity(a, b, domainCategories);
  const textScore = localTextSimilarity(a, b);
  return Math.max(categoryScore, textScore);
}

function categorySimilarity(a, b, domainCategories) {
  return domainCategories.some((category) => {
    const group = [category.name, ...category.keywords];
    return group.some((keyword) => keywordMatches(a, keyword)) && group.some((keyword) => keywordMatches(b, keyword));
  })
    ? 0.72
    : 0;
}

function localTextSimilarity(a, b) {
  const aTokens = textTokens(a);
  const bTokens = textTokens(b);
  if (aTokens.size === 0 || bTokens.size === 0) {
    return 0;
  }
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function textTokens(text) {
  const clean = String(text).trim().toLowerCase();
  const tokens = new Set();
  for (const char of clean) {
    if (!/\s/.test(char)) {
      tokens.add(char);
    }
  }
  for (let i = 0; i < clean.length - 1; i += 1) {
    const pair = clean.slice(i, i + 2);
    if (!/\s/.test(pair)) {
      tokens.add(pair);
    }
  }
  return tokens;
}

function cooccurrenceScore(count, countA, countB) {
  if (count <= 0 || countA <= 0 || countB <= 0) {
    return 0;
  }
  return clamp01(count / Math.sqrt(countA * countB));
}

function normalizeRelations(relations) {
  return relations
    .map((relation) => {
      const a = Number(relation.tagAId);
      const b = Number(relation.tagBId);
      const score = clamp01(Number(relation.score));
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === b || !Number.isFinite(score)) {
        return null;
      }
      return {
        tagAId: Math.min(a, b),
        tagBId: Math.max(a, b),
        score,
        reason: String(relation.reason ?? '').slice(0, 80)
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
}

function buildRelationCacheKey(mapId, tags, cooccurrence) {
  const signature = JSON.stringify({
    tags: tags.map((tag) => [tag.id, tag.name, tag.count]),
    cooccurrence: cooccurrence.map((item) => [item.tagAId, item.tagBId, item.count])
  });
  return `deepseek:relations:v2:${mapId}:${hashString(signature)}`;
}

function buildGroupCacheKey(mapId, tags, domainCategories) {
  const signature = JSON.stringify({
    tags: tags.map((tag) => [tag.id, tag.name, tag.count]),
    domainCategories: domainCategories.map((category) => [category.name, category.color, category.keywords])
  });
  return `deepseek:groups:v2:${mapId}:${hashString(signature)}`;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function pairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}
