import { getAiCache, listLogs, listTagTrends, listTags, listTopTagPairs, setAiCache } from './db.js';
import { callDeepSeekJson, hasDeepSeekKey } from './deepseek.js';

export async function buildInsights(mapId) {
  const [stats, recentLogs] = await Promise.all([buildInsightStats(mapId), buildRecentLogs(mapId)]);
  const cached = await getCachedAdvice(mapId, stats, recentLogs);

  return {
    ...stats,
    suggestions: cached,
    adviceMeta:
      cached.length > 0
        ? {
            feature: 'advice',
            source: 'cache',
            attempted: false,
            message: '行为建议使用 DeepSeek 缓存结果'
          }
        : {
            feature: 'advice',
            source: 'none',
            attempted: false,
            message: '尚未生成 AI 建议'
          }
  };
}

export async function generateAdvice(mapId) {
  const [stats, recentLogs] = await Promise.all([buildInsightStats(mapId), buildRecentLogs(mapId)]);
  const cached = await getCachedAdvice(mapId, stats, recentLogs);

  if (cached.length > 0) {
    return {
      cached: true,
      suggestions: cached,
      aiMeta: {
        feature: 'advice',
        source: 'cache',
        attempted: false,
        message: '行为建议使用 DeepSeek 缓存结果'
      }
    };
  }

  if (!hasDeepSeekKey()) {
    return {
      cached: false,
      suggestions: ['未配置 DeepSeek API Key，暂不生成 AI 建议。'],
      aiMeta: {
        feature: 'advice',
        source: 'local',
        attempted: false,
        message: '未配置 DeepSeek Key，无法生成 AI 建议'
      }
    };
  }

  try {
    const result = await callDeepSeekJson({
      system:
        '你是一个谨慎、实用的个人行为观察助手。你只能基于给定统计和日志摘要提出建议，不要诊断疾病，不要夸大结论。只返回合法 JSON。',
      user: `请根据个人日志统计生成行为建议。

要求：
1. 只返回 JSON 对象，格式为 {"suggestions":["建议1","建议2","建议3"]}。
2. 建议要具体、温和、可执行，每条 25 到 60 个中文字符。
3. 不要编造用户没有提供的信息。
4. 如果数据不足，要说明继续记录后判断会更可靠。
5. 最多 5 条。

统计数据：
${JSON.stringify(stats)}

最近日志摘要：
${JSON.stringify(recentLogs)}`,
      temperature: 0.35,
      maxTokens: 900
    });

    const suggestions = normalizeSuggestions(result.suggestions);
    const value = {
      suggestions: suggestions.length > 0 ? suggestions : ['DeepSeek 暂未生成有效建议，请继续记录更多日志。']
    };
    await setAiCache(buildAdviceCacheKey(mapId, stats, recentLogs), value);

    return {
      cached: false,
      suggestions: value.suggestions,
      aiMeta: {
        feature: 'advice',
        source: 'deepseek',
        attempted: true,
        message: 'DeepSeek 行为建议调用成功'
      }
    };
  } catch (error) {
    console.warn(`DeepSeek advice unavailable: ${error.message}`);
    return {
      cached: false,
      suggestions: ['DeepSeek 建议生成失败，请检查 API Key 或网络后重试。'],
      aiMeta: {
        feature: 'advice',
        source: 'local',
        attempted: true,
        message: `DeepSeek 行为建议调用失败：${error.message}`
      }
    };
  }
}

async function getCachedAdvice(mapId, stats, recentLogs) {
  const cached = await getAiCache(buildAdviceCacheKey(mapId, stats, recentLogs));
  return normalizeSuggestions(cached?.suggestions);
}

async function buildRecentLogs(mapId) {
  return (await listLogs(mapId))
    .slice(0, 8)
    .map((log) => ({
      title: log.title,
      content: String(log.content).slice(0, 220),
      tags: log.tags.map((tag) => tag.name),
      createdAt: log.createdAt
    }));
}

async function buildInsightStats(mapId) {
  const [topTags, trendRows, cooccurrence] = await Promise.all([
    listTags(mapId).then((tags) => tags.slice(0, 6)),
    listTagTrends(mapId),
    listTopTagPairs(mapId)
  ]);

  const risingTags = trendRows
    .filter((row) => row.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 4);

  const fallingTags = trendRows
    .filter((row) => row.previous > 0 && row.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 4);

  return {
    topTags,
    risingTags,
    fallingTags,
    cooccurrence
  };
}

function normalizeSuggestions(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 5);
}

function buildAdviceCacheKey(mapId, stats, recentLogs) {
  return `deepseek:advice:${mapId}:${hashString(JSON.stringify({ stats, recentLogs }))}`;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
