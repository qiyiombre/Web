import { getAiCache, getTagCooccurrence, listTags, setAiCache } from './db.js';
import { callDeepSeekJson, hasDeepSeekKey } from './deepseek.js';

export async function buildTagSimilarities(mapId) {
  const tags = listTags(mapId);
  const cooccurrence = getTagCooccurrence(mapId);
  const local = buildLocalSimilarities(tags, cooccurrence);

  if (!hasDeepSeekKey() || tags.length < 2) {
    return local;
  }

  const cacheKey = buildRelationCacheKey(mapId, tags, cooccurrence);
  const cached = getAiCache(cacheKey);
  if (cached) {
    return mergeAiAndLocal(cached, local);
  }

  try {
    const aiRelations = await requestDeepSeekRelations(tags, cooccurrence);
    setAiCache(cacheKey, aiRelations);
    return mergeAiAndLocal(aiRelations, local);
  } catch (error) {
    console.warn(`DeepSeek tag relation unavailable, using local fallback: ${error.message}`);
    return local;
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
      '你是一个个人日志知识图谱分析器。请判断标签之间的语义接近程度和生活行为关联强度。只返回合法 JSON，不要输出 Markdown。',
    user: `根据下面的标签和共现数据，输出适合星云图布局的标签关系评分。

要求：
1. 只返回 JSON 对象，格式为 {"relations":[{"tagAId":1,"tagBId":2,"score":0.8,"reason":"..."}]}。
2. score 范围是 0 到 1，越高表示两个标签越应该靠近。
3. 同义、近义、同一领域、强生活关联、经常共现都可以提高分数。
4. 只返回 score >= 0.35 的关系，最多 30 条。
5. tagAId 必须小于 tagBId。

数据：
${JSON.stringify(payload)}`,
    temperature: 0.15,
    maxTokens: 1100
  });

  return normalizeRelations(result.relations ?? []);
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

function buildLocalSimilarities(tags, cooccurrence) {
  const tagCountById = new Map(tags.map((tag) => [tag.id, Number(tag.count || 0)]));
  const cooccurrenceByPair = new Map(cooccurrence.map((row) => [pairKey(row.tagAId, row.tagBId), Number(row.count || 0)]));
  const relations = [];

  for (let i = 0; i < tags.length; i += 1) {
    for (let j = i + 1; j < tags.length; j += 1) {
      const a = tags[i];
      const b = tags[j];
      const coScore = cooccurrenceScore(cooccurrenceByPair.get(pairKey(a.id, b.id)) || 0, tagCountById.get(a.id) || 0, tagCountById.get(b.id) || 0);
      const semantic = localSemanticScore(a.name, b.name);
      const score = semantic * 0.55 + coScore * 0.45;

      if (score >= 0.16 || coScore > 0) {
        relations.push({
          tagAId: a.id,
          tagBId: b.id,
          score: Number(score.toFixed(4)),
          semanticScore: Number(semantic.toFixed(4)),
          cooccurrenceScore: Number(coScore.toFixed(4)),
          source: 'local',
          reason: coScore > 0 ? '本地共现关系' : '本地标签分类或文字相似'
        });
      }
    }
  }

  return relations.sort((a, b) => b.score - a.score);
}

function localSemanticScore(a, b) {
  const categoryScore = categorySimilarity(a, b);
  const textScore = localTextSimilarity(a, b);
  return Math.max(categoryScore, textScore);
}

function categorySimilarity(a, b) {
  const groups = [
    ['学习', '复习', '考试', '作业', '课程', '刷题'],
    ['Web', '前端', '后端', '数据库', '算法', '项目', '代码', '编程'],
    ['压力', '焦虑', '睡眠', '熬夜', '情绪', '健康'],
    ['运动', '跑步', '健身', '健康'],
    ['社交', '朋友', '同学', '小组', '合作'],
    ['美食', '午饭', '晚饭', '饮食']
  ];

  return groups.some((group) => group.includes(a) && group.includes(b)) ? 0.72 : 0;
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
  return `deepseek:relations:${mapId}:${hashString(signature)}`;
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
