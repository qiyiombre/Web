import { getAiCache, listLogs, listTagTrends, listTags, listTopTagPairs, setAiCache } from './db.js';
import { callDeepSeekJson, hasDeepSeekKey } from './deepseek.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function buildInsights(mapId, rangeInput = null) {
  const range = rangeInput ? normalizeInsightRange(rangeInput, 'week') : null;
  const [stats, recentLogs] = range
    ? await Promise.all([buildRangeInsightStats(mapId, range), buildRecentLogs(mapId, range)])
    : await Promise.all([buildInsightStats(mapId), buildRecentLogs(mapId)]);
  const cached = await getCachedAdvice(mapId, stats, recentLogs, range);

  return {
    ...stats,
    suggestions: cached,
    range: range
      ? {
          timeFilter: range.timeFilter,
          customStartDate: range.customStartDate,
          customEndDate: range.customEndDate
        }
      : undefined,
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

export async function generateAdvice(mapId, rangeInput = {}) {
  const range = normalizeInsightRange(rangeInput, 'month');
  const [stats, recentLogs] = await Promise.all([buildRangeInsightStats(mapId, range), buildRecentLogs(mapId, range)]);
  const cached = await getCachedAdvice(mapId, stats, recentLogs, range);

  if (cached.length > 0) {
    return {
      cached: true,
      suggestions: cached,
      range: {
        timeFilter: range.timeFilter,
        customStartDate: range.customStartDate,
        customEndDate: range.customEndDate
      },
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
      range: {
        timeFilter: range.timeFilter,
        customStartDate: range.customStartDate,
        customEndDate: range.customEndDate
      },
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
    await setAiCache(buildAdviceCacheKey(mapId, stats, recentLogs, range), value);

    return {
      cached: false,
      suggestions: value.suggestions,
      range: {
        timeFilter: range.timeFilter,
        customStartDate: range.customStartDate,
        customEndDate: range.customEndDate
      },
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
      range: {
        timeFilter: range.timeFilter,
        customStartDate: range.customStartDate,
        customEndDate: range.customEndDate
      },
      aiMeta: {
        feature: 'advice',
        source: 'local',
        attempted: true,
        message: `DeepSeek 行为建议调用失败：${error.message}`
      }
    };
  }
}

async function getCachedAdvice(mapId, stats, recentLogs, range = null) {
  const cached = await getAiCache(buildAdviceCacheKey(mapId, stats, recentLogs, range));
  return normalizeSuggestions(cached?.suggestions);
}

async function buildRecentLogs(mapId, range = null) {
  return (await listLogs(mapId))
    .filter((log) => matchesPeriod(log, range?.current))
    .slice(0, 8)
    .map((log) => ({
      title: log.title,
      content: String(log.content).slice(0, 220),
      tags: log.tags.map((tag) => tag.name),
      createdAt: log.createdAt
    }));
}

async function buildRangeInsightStats(mapId, range) {
  const [tags, logs] = await Promise.all([listTags(mapId), listLogs(mapId)]);
  const currentLogs = logs.filter((log) => matchesPeriod(log, range.current));
  const previousLogs = logs.filter((log) => matchesPeriod(log, range.previous));
  const currentUsage = buildUsageByTag(currentLogs);
  const previousUsage = buildUsageByTag(previousLogs);
  const topTags = tags
    .map((tag) => ({ ...tag, count: currentUsage.get(tag.id) ?? 0 }))
    .filter((tag) => tag.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 6);
  const trendRows = tags.map((tag) => {
    const current = currentUsage.get(tag.id) ?? 0;
    const previous = previousUsage.get(tag.id) ?? 0;
    return {
      id: tag.id,
      name: tag.name,
      color: tag.color,
      current,
      previous,
      delta: current - previous
    };
  });
  const risingTags = trendRows
    .filter((row) => row.delta > 0)
    .sort((a, b) => b.delta - a.delta || b.current - a.current)
    .slice(0, 4);
  const fallingTags = trendRows
    .filter((row) => row.previous > 0 && row.delta < 0)
    .sort((a, b) => a.delta - b.delta || b.previous - a.previous)
    .slice(0, 4);

  return {
    topTags,
    risingTags,
    fallingTags,
    cooccurrence: buildCooccurrence(currentLogs).slice(0, 6),
    range: {
      timeFilter: range.timeFilter,
      customStartDate: range.customStartDate,
      customEndDate: range.customEndDate
    }
  };
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

function buildUsageByTag(logs) {
  const usage = new Map();
  for (const log of logs) {
    const seen = new Set();
    for (const tag of log.tags ?? []) {
      if (seen.has(tag.id)) continue;
      seen.add(tag.id);
      usage.set(tag.id, (usage.get(tag.id) ?? 0) + 1);
    }
  }
  return usage;
}

function buildCooccurrence(logs) {
  const pairs = new Map();
  for (const log of logs) {
    const tags = [...(log.tags ?? [])].sort((a, b) => a.id - b.id);
    for (let i = 0; i < tags.length; i += 1) {
      for (let j = i + 1; j < tags.length; j += 1) {
        const key = `${tags[i].id}:${tags[j].id}`;
        const item = pairs.get(key) ?? { tagA: tags[i].name, tagB: tags[j].name, count: 0 };
        item.count += 1;
        pairs.set(key, item);
      }
    }
  }
  return [...pairs.values()].sort((a, b) => b.count - a.count || a.tagA.localeCompare(b.tagA));
}

function normalizeInsightRange(input = {}, fallback = 'month') {
  const timeFilter = ['week', 'month', 'quarter', 'custom'].includes(input.timeFilter)
    ? input.timeFilter
    : fallback;
  const customStartDate = normalizeDate(input.customStartDate);
  const customEndDate = normalizeDate(input.customEndDate);
  const current = buildCurrentPeriod(timeFilter, customStartDate, customEndDate);
  return {
    timeFilter,
    customStartDate,
    customEndDate,
    current,
    previous: buildPreviousPeriod(current)
  };
}

function normalizeDate(value) {
  const text = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function buildCurrentPeriod(timeFilter, customStartDate, customEndDate) {
  const now = Date.now();
  if (timeFilter === 'custom') {
    const start = dateBoundary(customStartDate);
    const end = dateBoundary(customEndDate, true);
    if (start === null && end === null) return null;
    return { start, end };
  }
  const ms = timeFilter === 'week' ? 7 * DAY_MS : timeFilter === 'quarter' ? 90 * DAY_MS : 30 * DAY_MS;
  return { start: now - ms, end: now };
}

function buildPreviousPeriod(period) {
  if (!period || period.start === null || period.end === null || period.end <= period.start) {
    return null;
  }
  const duration = period.end - period.start;
  return { start: period.start - duration, end: period.start };
}

function dateBoundary(value, endOfDay = false) {
  if (!value) return null;
  const time = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`).getTime();
  return Number.isNaN(time) ? null : time;
}

function matchesPeriod(log, period) {
  if (!period) return true;
  const time = new Date(log.createdAt).getTime();
  if (Number.isNaN(time)) return true;
  if (period.start !== null && time < period.start) return false;
  if (period.end !== null && time > period.end) return false;
  return true;
}

function buildAdviceCacheKey(mapId, stats, recentLogs, range = null) {
  return `deepseek:advice:${mapId}:${hashString(JSON.stringify({ range, stats, recentLogs }))}`;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
