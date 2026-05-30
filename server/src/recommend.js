import { listTags } from './db.js';
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
        return aiSuggestions;
      }
    } catch (error) {
      console.warn(`DeepSeek tag suggestion unavailable, using local fallback: ${error.message}`);
    }
  }

  return suggestTagsLocal(existingTags, content, limit);
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
  return normalizeSuggestions(result.tags ?? [], existingNames, limit, 'DeepSeek 根据日志语义推荐');
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
        existing: true
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
      existing: Boolean(existing)
    });
  }

  return [...candidates.values()]
    .sort((a, b) => b.score - a.score || Number(b.existing) - Number(a.existing))
    .slice(0, limit);
}

function normalizeSuggestions(items, existingNames, limit, fallbackReason) {
  const seen = new Set();
  return items
    .map((item) => ({
      name: String(item.name ?? '').trim().slice(0, 24),
      score: clamp01(Number(item.score ?? 0.6)),
      reason: String(item.reason ?? fallbackReason).trim().slice(0, 80),
      existing: existingNames.has(String(item.name ?? '').trim())
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
