import { getAiCache, listTags, setAiCache } from './db.js';
import { callDeepSeekJson, hasDeepSeekKey } from './deepseek.js';

const keywordGroups = [
  { name: 'Web', words: ['web', '浏览器', 'canvas', 'webgpu', 'vue', 'react', 'html', 'css', 'js'] },
  { name: '前端', words: ['vue', 'react', '页面', '组件', '样式', '交互', '布局'] },
  { name: '后端', words: ['后端', '接口', 'api', '数据库', 'express', 'server', '服务端'] },
  { name: '项目', words: ['项目', '大作业', '期末', '答辩', '演示', '需求'] },
  { name: '算法', words: ['算法', '动态规划', '图算法', '搜索', '排序', '复杂度'] },
  { name: '学习', words: ['学习', '复习', '课程', '知识点', '看书', '听课'] },
  { name: '作业', words: ['作业', 'ddl', '任务', '提交', '报告'] },
  { name: '考试', words: ['考试', '复习', '试卷', '刷题'] },
  { name: '压力', words: ['压力', '焦虑', '紧张', '赶', '来不及'] },
  { name: '睡眠', words: ['睡觉', '熬夜', '睡眠', '困', '晚睡'] },
  { name: '运动', words: ['跑步', '运动', '健身', '散步', '篮球'] },
  { name: '健康', words: ['健康', '身体', '胃', '头疼', '休息'] },
  { name: '情绪', words: ['开心', '低落', '心情', '烦', '轻松', '成就感'] },
  { name: '社交', words: ['朋友', '同学', '聊天', '小组', '合作'] },
  { name: '饮食', words: ['吃饭', '午饭', '晚饭', '美食', '饮食'] }
];

export async function suggestTags(mapId, content, limit = 8) {
  const existingTags = listTags(mapId);

  if (hasDeepSeekKey()) {
    try {
      const aiSuggestions = await suggestTagsWithDeepSeek(existingTags, content, limit);
      if (aiSuggestions.length > 0) {
        return {
          suggestions: aiSuggestions,
          aiMeta: {
            feature: 'tagSuggestions',
            source: 'deepseek',
            attempted: true,
            message: 'DeepSeek 标签推荐调用成功'
          }
        };
      }
    } catch (error) {
      console.warn(`DeepSeek tag suggestion unavailable, using local fallback: ${error.message}`);
      return {
        suggestions: suggestTagsLocal(existingTags, content, limit),
        aiMeta: {
          feature: 'tagSuggestions',
          source: 'local',
          attempted: true,
          message: `DeepSeek 标签推荐调用失败，已使用本地算法：${error.message}`
        }
      };
    }

    return {
      suggestions: suggestTagsLocal(existingTags, content, limit),
      aiMeta: {
        feature: 'tagSuggestions',
        source: 'local',
        attempted: true,
        message: 'DeepSeek 未返回有效标签推荐，已使用本地算法'
      }
    };
  }

  return {
    suggestions: suggestTagsLocal(existingTags, content, limit),
    aiMeta: {
      feature: 'tagSuggestions',
      source: 'local',
      attempted: false,
      message: '未配置 DeepSeek Key，标签推荐使用本地算法'
    }
  };
}

export async function searchTags(mapId, query, limit = 30) {
  const existingTags = listTags(mapId);
  const cleanQuery = String(query ?? '').trim().slice(0, 80);
  if (!cleanQuery) {
    return {
      matches: [],
      aiMeta: {
        feature: 'tagSearch',
        source: 'none',
        attempted: false,
        message: '请输入搜索内容'
      }
    };
  }

  const local = searchTagsLocal(existingTags, cleanQuery, limit);
  if (!hasDeepSeekKey()) {
    return {
      matches: local,
      aiMeta: {
        feature: 'tagSearch',
        source: 'local',
        attempted: false,
        message: '未配置 DeepSeek Key，模糊搜索使用本地语义规则'
      }
    };
  }

  const cacheKey = buildTagSearchCacheKey(mapId, existingTags, cleanQuery, limit);
  const cached = getAiCache(cacheKey);
  if (Array.isArray(cached)) {
    return {
      matches: mergeTagSearchMatches(normalizeTagSearchMatches(cached, existingTags, limit, 'cache'), local, limit),
      aiMeta: {
        feature: 'tagSearch',
        source: 'cache',
        attempted: false,
        message: 'DeepSeek 模糊搜索使用缓存结果'
      }
    };
  }

  try {
    const aiMatches = await searchTagsWithDeepSeek(existingTags, cleanQuery, limit);
    setAiCache(cacheKey, aiMatches);
    return {
      matches: mergeTagSearchMatches(aiMatches, local, limit),
      aiMeta: {
        feature: 'tagSearch',
        source: aiMatches.length > 0 ? 'deepseek' : 'local',
        attempted: true,
        message: aiMatches.length > 0 ? 'DeepSeek 模糊搜索调用成功' : 'DeepSeek 未返回有效匹配，已使用本地语义规则'
      }
    };
  } catch (error) {
    console.warn(`DeepSeek tag search unavailable, using local fallback: ${error.message}`);
    return {
      matches: local,
      aiMeta: {
        feature: 'tagSearch',
        source: 'local',
        attempted: true,
        message: `DeepSeek 模糊搜索调用失败，已使用本地语义规则：${error.message}`
      }
    };
  }
}

async function searchTagsWithDeepSeek(existingTags, query, limit) {
  const result = await callDeepSeekJson({
    system:
      '你是个人日志标签语义搜索助手。你只能从用户已有标签中选择语义相近的标签，不要创造新标签。只返回合法 JSON，不要输出 Markdown。',
    user: `请根据搜索词，从已有标签里找出语义相近、同义、近义或同领域的标签。

要求：
1. 只返回 JSON 对象，格式为 {"matches":[{"tagId":1,"score":0.9,"reason":"匹配理由"}]}。
2. 只能使用已有标签的 tagId，不能新增标签。
3. 标签名不包含搜索词但语义相近也应该返回。例如搜索“健身”时，“运动”“健康”可以匹配；搜索“代码”时，“前端”“后端”“Web”可以匹配。
4. score 范围 0 到 1，越相关越高。
5. 最多返回 ${limit} 个，按相关度从高到低。

搜索词：
${query}

已有标签：
${JSON.stringify(existingTags.map((tag) => ({ tagId: tag.id, name: tag.name, count: tag.count })))}`,
    temperature: 0.12,
    maxTokens: 1200
  });

  return normalizeTagSearchMatches(result.matches ?? result.tags ?? [], existingTags, limit, 'deepseek');
}

async function suggestTagsWithDeepSeek(existingTags, content, limit) {
  const result = await callDeepSeekJson({
    system:
      '你是个人日志标签推荐助手。你需要优先复用已有标签，必要时推荐少量新标签。只返回合法 JSON，不要输出 Markdown。',
    user: `请根据日志内容推荐标签。

要求：
1. 只返回 JSON 对象，格式为 {"tags":[{"name":"标签名","score":0.9,"reason":"推荐理由","existing":true}]}。
2. 最多返回 ${limit} 个标签。
3. 优先推荐 existingTags 中已有且相关的标签。
4. 如果已有标签不足以表达内容，可以推荐新标签。
5. 标签名保持简短，2 到 6 个中文字符或常见英文技术词。
6. score 范围 0 到 1。

已有标签：
${JSON.stringify(existingTags.map((tag) => ({ name: tag.name, count: tag.count })))}

日志内容：
${String(content ?? '').slice(0, 1200)}`,
    temperature: 0.2,
    maxTokens: 900
  });

  const existingNames = new Set(existingTags.map((tag) => tag.name));
  return normalizeSuggestions(result.tags ?? [], existingNames, limit, 'DeepSeek 根据日志语义推荐', 'deepseek');
}

function suggestTagsLocal(existingTags, content, limit) {
  const text = String(content ?? '').toLowerCase();
  const candidates = new Map();

  for (const tag of existingTags) {
    const lowerName = tag.name.toLowerCase();
    let score = 0;
    if (text.includes(lowerName)) {
      score += 0.82;
    }
    for (const char of tag.name) {
      if (text.includes(char.toLowerCase())) {
        score += 0.035;
      }
    }
    if (score > 0) {
      candidates.set(tag.name, {
        name: tag.name,
        score: clamp01(score + Math.min(tag.count, 8) * 0.015),
        reason: '与已有标签名称或历史使用习惯相关',
        existing: true,
        source: 'local'
      });
    }
  }

  for (const group of keywordGroups) {
    const hits = group.words.filter((word) => text.includes(word.toLowerCase()));
    if (hits.length === 0) {
      continue;
    }

    const existing = existingTags.find((tag) => tag.name === group.name);
    const previous = candidates.get(group.name);
    const score = clamp01(hits.length * 0.25 + (existing ? Math.min(existing.count, 8) * 0.025 : 0));
    candidates.set(group.name, {
      name: group.name,
      score: Math.max(previous?.score ?? 0, score),
      reason: `内容中出现了「${hits.slice(0, 3).join('、')}」等关键词`,
      existing: Boolean(existing),
      source: 'local'
    });
  }

  return [...candidates.values()]
    .sort((a, b) => b.score - a.score || Number(b.existing) - Number(a.existing))
    .slice(0, limit);
}

function searchTagsLocal(existingTags, query, limit) {
  const cleanQuery = String(query ?? '').trim().toLowerCase();
  const candidates = new Map();
  const semanticGroups = [
    { topic: '运动健康', words: ['运动', '健身', '锻炼', '跑步', '训练', '瑜伽', '有氧', '力量', '散步', '篮球', '足球', '健康', '身体'] },
    { topic: '睡眠休息', words: ['睡眠', '睡觉', '熬夜', '休息', '午休', '困', '疲惫', '恢复'] },
    { topic: '饮食美食', words: ['饮食', '美食', '吃饭', '做饭', '早餐', '午餐', '晚餐', '咖啡'] },
    { topic: '学习考试', words: ['学习', '复习', '课程', '考试', '作业', '阅读', '笔记', '英语', '算法'] },
    { topic: '技术开发', words: ['代码', '编程', '开发', '前端', '后端', 'web', 'api', '数据库', '设计', '项目'] },
    { topic: '情绪压力', words: ['情绪', '压力', '焦虑', '心情', '开心', '低落', '放松', '烦躁'] },
    { topic: '社交关系', words: ['社交', '朋友', '聊天', '合作', '家庭', '同学', '聚餐'] },
    { topic: '创作艺术', words: ['绘画', '设计', '摄影', '音乐', '写作', '创作', '艺术', '灵感'] },
    { topic: '旅行生活', words: ['旅行', '旅游', '出门', '通勤', '生活', '购物', '整理'] }
  ];

  for (const tag of existingTags) {
    const lowerName = tag.name.toLowerCase();
    let score = 0;
    let reason = '';

    if (lowerName === cleanQuery) {
      score = 0.98;
      reason = '标签名称完全匹配';
    } else if (lowerName.includes(cleanQuery) || cleanQuery.includes(lowerName)) {
      score = 0.82;
      reason = '标签名称部分匹配';
    } else {
      const queryChars = [...new Set([...cleanQuery].filter((char) => char.trim()))];
      const overlap = queryChars.length === 0 ? 0 : queryChars.filter((char) => lowerName.includes(char)).length / queryChars.length;
      if (overlap > 0) {
        score = Math.max(score, 0.24 + overlap * 0.32);
        reason = '标签名称有相近字词';
      }
    }

    for (const group of semanticGroups) {
      const queryInGroup = group.words.some((word) => fuzzyWordMatch(cleanQuery, word));
      const tagInGroup = group.words.some((word) => fuzzyWordMatch(lowerName, word));
      if (queryInGroup && tagInGroup) {
        score = Math.max(score, 0.72);
        reason = `与搜索词同属${group.topic}主题`;
      }
    }

    if (score > 0) {
      candidates.set(tag.id, {
        id: tag.id,
        name: tag.name,
        color: tag.color,
        count: tag.count,
        score: clamp01(score + Math.min(tag.count, 8) * 0.012),
        reason: reason || '与搜索词语义相近',
        source: 'local'
      });
    }
  }

  return [...candidates.values()]
    .sort((a, b) => b.score - a.score || b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function fuzzyWordMatch(value, word) {
  const lowerWord = word.toLowerCase();
  return value.includes(lowerWord) || lowerWord.includes(value);
}

function normalizeTagSearchMatches(items, existingTags, limit, source) {
  const tagsById = new Map(existingTags.map((tag) => [tag.id, tag]));
  const tagsByName = new Map(existingTags.map((tag) => [tag.name, tag]));
  const seen = new Set();
  return items
    .map((item) => {
      const id = Number(item.tagId ?? item.id);
      const tag = tagsById.get(id) ?? tagsByName.get(String(item.name ?? '').trim());
      if (!tag || seen.has(tag.id)) {
        return null;
      }
      seen.add(tag.id);
      return {
        id: tag.id,
        name: tag.name,
        color: tag.color,
        count: tag.count,
        score: clamp01(Number(item.score ?? 0.6)),
        reason: String(item.reason ?? '与搜索词语义相近').trim().slice(0, 90),
        source
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function mergeTagSearchMatches(primary, secondary, limit) {
  const merged = new Map();
  for (const item of [...primary, ...secondary]) {
    const previous = merged.get(item.id);
    if (!previous || item.score > previous.score) {
      merged.set(item.id, item);
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function buildTagSearchCacheKey(mapId, tags, query, limit) {
  const signature = JSON.stringify({
    query: query.trim().toLowerCase(),
    limit,
    tags: tags.map((tag) => [tag.id, tag.name, tag.count])
  });
  return `deepseek:tag-search:v1:${mapId}:${hashString(signature)}`;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function normalizeSuggestions(items, existingNames, limit, fallbackReason, source) {
  const seen = new Set();
  return items
    .map((item) => ({
      name: String(item.name ?? '').trim().slice(0, 24),
      score: clamp01(Number(item.score ?? 0.6)),
      reason: String(item.reason ?? fallbackReason).trim().slice(0, 80),
      existing: existingNames.has(String(item.name ?? '').trim()),
      source
    }))
    .filter((item) => {
      if (!item.name || seen.has(item.name)) {
        return false;
      }
      seen.add(item.name);
      return true;
    })
    .sort((a, b) => b.score - a.score || Number(b.existing) - Number(a.existing))
    .slice(0, limit);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}
