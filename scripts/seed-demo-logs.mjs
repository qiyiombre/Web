import { createLog, db, initializeDatabase } from '../server/src/db.js';

initializeDatabase();

const samples = [
  {
    title: '英语听力晨练',
    content: '早上用二十分钟跟读一段播客，发现先听关键词再复述整句，比反复暂停更容易进入状态。准备把它放进每天的学习启动流程。',
    tags: ['英语', '学习', '复习'],
    daysAgo: 1
  },
  {
    title: '数据库索引实验',
    content: '给日志列表查询补了索引思路，重新比较了全表扫描和按 map_id 查询的差异。后端性能问题需要结合真实数据量看，不能只凭感觉判断。',
    tags: ['数据库', '后端', '项目', 'Web'],
    daysAgo: 2
  },
  {
    title: '界面色彩复盘',
    content: '重新检查了星图里标签颜色的层级：高亮状态要足够明显，普通状态不能太抢。设计调整会直接影响读图时的情绪压力。',
    tags: ['设计', '前端', '项目', '情绪'],
    daysAgo: 3
  },
  {
    title: '读完一章认知心理学',
    content: '这章讲注意力切换成本，和最近写代码时频繁看消息的体验很吻合。做了几张笔记卡片，准备之后和时间管理标签连起来。',
    tags: ['阅读', '学习', '笔记'],
    daysAgo: 4
  },
  {
    title: '和同学讨论答辩分工',
    content: '晚上开了小组会，把演示、讲稿、测试截图分开认领。沟通清楚之后压力下降了一些，项目推进也更有节奏。',
    tags: ['社交', '合作', '项目', '压力'],
    daysAgo: 5
  },
  {
    title: '晚间力量训练',
    content: '做了深蹲和俯卧撑，强度不高但出汗以后脑子轻了很多。运动和睡眠的关系很明显，晚上入睡速度比前两天快。',
    tags: ['运动', '健康', '睡眠'],
    daysAgo: 6
  },
  {
    title: '整理本周财务流水',
    content: '把外卖、交通和学习资料开销分了类，发现小额支出累积得很快。下周想给饮食和娱乐设置一个更清楚的预算边界。',
    tags: ['理财', '复盘', '时间管理'],
    daysAgo: 7
  },
  {
    title: '家里视频通话',
    content: '和家里聊了近况，讲完最近的作业和考试安排以后踏实不少。有些压力只是需要说出来，情绪就会自然松动。',
    tags: ['家庭', '情绪', '休息'],
    daysAgo: 8
  },
  {
    title: '周末短途城市漫步',
    content: '去了不远的老街，拍了几张建筑细节照片。换一个环境走路，比坐在桌前硬休息更能恢复注意力。',
    tags: ['旅行', '摄影', '情绪'],
    daysAgo: 9
  },
  {
    title: '算法题错题归纳',
    content: '把最近错的动态规划题重新按状态定义、转移方程、边界条件分类。复习时发现自己不是不会，而是没有稳定的检查顺序。',
    tags: ['算法', '复习', '考试', '笔记'],
    daysAgo: 10
  },
  {
    title: '后端接口错误排查',
    content: '登录态接口偶尔返回 401，顺着 Cookie、请求头和会话表查了一遍。代码问题不大，主要是调试时环境和端口切换太频繁。',
    tags: ['后端', '代码', 'Web', '压力'],
    daysAgo: 11
  },
  {
    title: '课程小论文初稿',
    content: '先把论文结构写出来：问题背景、案例、自己的观察和结论。写作时不要一开始就追求完美，先让材料有地方落脚。',
    tags: ['写作', '课程', '作业', '学习'],
    daysAgo: 12
  },
  {
    title: '午餐换成轻食',
    content: '今天中午没有点重油的饭，下午困意明显少一些。饮食对学习状态的影响比想象中直接，之后可以继续观察。',
    tags: ['饮食', '健康', '美食'],
    daysAgo: 13
  },
  {
    title: '睡前音乐放松',
    content: '睡前放了半小时轻音乐，没有继续刷短视频。情绪降下来以后更容易入睡，第二天早上也没有那么疲惫。',
    tags: ['音乐', '睡眠', '情绪'],
    daysAgo: 14
  },
  {
    title: '整理研究资料卡片',
    content: '把论文、博客和课堂笔记拆成几张资料卡，分别标注来源、观点和可用场景。研究资料变少一点碎片感以后，项目想法也更清楚。',
    tags: ['研究', '阅读', '笔记', '项目'],
    daysAgo: 15
  },
  {
    title: '考试计划拆解',
    content: '把三门课的复习内容拆成每天可完成的小块，先处理最不确定的部分。时间管理不是把日程塞满，而是减少临场慌乱。',
    tags: ['考试', '时间管理', '复习', '压力'],
    daysAgo: 16
  },
  {
    title: 'CSS 动效打磨',
    content: '给几个按钮和面板过渡做了细微调整，前端动效要服务于操作反馈，不能只是看起来炫。设计和代码需要一起考虑。',
    tags: ['前端', '设计', 'Web', '代码'],
    daysAgo: 17
  },
  {
    title: '晨间无手机专注块',
    content: '起床后一小时没有看手机，直接进入阅读和笔记。这个小规则让学习开始得更快，也减少了早上的情绪波动。',
    tags: ['时间管理', '学习', '健康'],
    daysAgo: 18
  },
  {
    title: '朋友生日聚餐',
    content: '晚上和朋友吃饭聊天，短暂离开任务列表以后反而更有精神。社交不一定是打断，有时也是恢复能量的一部分。',
    tags: ['社交', '美食', '情绪'],
    daysAgo: 19
  },
  {
    title: '数据可视化灵感记录',
    content: '看到一个关系图案例，节点大小、边透明度和聚类距离都值得参考。可以把这些想法迁移到星云图，让复杂标签更容易阅读。',
    tags: ['数据可视化', '设计', '项目', 'Web'],
    daysAgo: 20
  }
];

const maps = db.prepare('SELECT id, name FROM nebula_maps ORDER BY id').all();
const existingLog = db.prepare('SELECT id FROM logs WHERE map_id = ? AND title = ?');
const updateCreatedAt = db.prepare('UPDATE logs SET created_at = ?, updated_at = ? WHERE id = ?');
let inserted = 0;
let skipped = 0;

for (const map of maps) {
  for (const sample of samples) {
    if (existingLog.get(map.id, sample.title)) {
      skipped += 1;
      continue;
    }

    const created = createLog({
      mapId: map.id,
      title: sample.title,
      content: sample.content,
      tagNames: sample.tags
    });
    const createdAt = new Date(Date.now() - sample.daysAgo * 86400000 - (map.id % 5) * 3600000).toISOString();
    updateCreatedAt.run(createdAt, createdAt, created.id);
    inserted += 1;
  }
}

db.prepare('DELETE FROM ai_cache').run();

const summary = maps.map((map) => ({
  id: map.id,
  name: map.name,
  logs: db.prepare('SELECT COUNT(*) AS count FROM logs WHERE map_id = ?').get(map.id).count,
  tags: db.prepare('SELECT COUNT(*) AS count FROM tags WHERE map_id = ?').get(map.id).count
}));

console.log(JSON.stringify({ inserted, skipped, summary }, null, 2));
