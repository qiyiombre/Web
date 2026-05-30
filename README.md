# 星云洞察

星云洞察是一个个人日志知识图谱与行为分析系统。它把标签显示为“恒星”，把日志显示为“行星”，通过 Canvas 实时渲染、Web Worker 图谱布局、标签推荐、离线草稿、登录隔离和 AI 行为建议来体现 Web 技术应用。

## 技术栈

- 前端：Vue 3、TypeScript、Vite、Canvas 2D、Web Worker、IndexedDB
- 后端：Node.js、Express、Node 内置 SQLite
- 登录：Cookie Session、HttpOnly Cookie、密码哈希存储
- 数据：SQLite 文件数据库，默认位置为 `server/data/nebula.sqlite`
- AI 增强：DeepSeek API，可用于标签推荐、标签关系评分和行为建议

## 启动方法

PowerShell 中如果 `npm` 被执行策略拦截，请使用 `npm.cmd`。

第一次安装依赖：

```powershell
npm.cmd install
```

构建并启动稳定版本：

```powershell
npm.cmd --prefix client run build
.\start.cmd
```

保持启动窗口不要关闭，然后浏览器访问：

```text
http://127.0.0.1:3001
```

课堂演示账号：

```text
用户名：demo
密码：demo123456
```

也可以直接在页面注册新账号。每个账号拥有独立的星云图、日志和标签。

## 使用流程

1. 登录或注册账号。
2. 左侧选择或新建一个星云图。
3. 点击“新日志”，输入标题和内容。
4. 点击“推荐标签”，选择系统推荐标签，也可以手动添加新标签。
5. 保存后，中心星云图会出现新的日志行星。
6. 点击标签恒星可激活或取消激活标签；多个标签激活时，只高亮同时包含这些标签的日志。
7. 左侧“标签管理”可以新增、重命名、删除标签，并能定位到星云图中的对应恒星。
8. 右侧“洞察分析”展示高频标签、变化趋势、常见共现关系；点击“生成建议”才会调用 AI。

## 已体现的 Web 技术点

- Canvas 2D 在浏览器中实时绘制交互式星云知识图谱。
- Web Worker 在独立线程计算图谱布局，避免布局计算阻塞主线程。
- 鼠标事件完成节点拾取、缩放、拖拽、点击高亮和标签位置固定。
- IndexedDB 保存新日志草稿：断网时可继续写，刷新后可恢复，联网后手动保存到后端。
- Cookie Session + HttpOnly Cookie 实现轻量登录，SQLite 中保存用户、会话和用户隔离数据。
- Express REST API 提供前后端分离的数据接口。
- SQLite 持久化星云图、日志、标签、日志-标签关系和 AI 缓存。
- DeepSeek API 负责结构化标签推荐、标签关系评分和用户行为建议。

## DeepSeek AI 增强

项目支持 DeepSeek API：

- 推荐标签：用户点击“推荐标签”时才调用；无 API Key 或失败时使用本地关键词兜底。
- 标签关系评分：标签新增、改名、删除、日志标签关系变化后缓存签名改变，首次重新评分；结果会缓存。
- 行为建议：打开页面不会自动调用；用户点击“生成建议”后才调用，并缓存同一批统计数据的结果。
- AI 布局：标签关系评分越高，Canvas 中两个标签越靠近；手动拖动过的标签会固定在用户位置。
- 恢复布局：点击顶部“恢复 AI 布局”会清除手动位置，让全部标签重新按 AI/本地关系自动布局。

PowerShell 设置方式：

```powershell
$env:DEEPSEEK_API_KEY="你的 API Key"
.\start.cmd
```

可选模型配置：

```powershell
$env:DEEPSEEK_MODEL="deepseek-v4-flash"
```
