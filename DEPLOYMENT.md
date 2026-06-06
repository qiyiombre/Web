# Render + Supabase 部署步骤

这个版本不再使用本地 `local-data/nebula-memory.sqlite` 保存线上数据。

线上结构：

```text
用户浏览器 -> Render 上的 Node/Express 服务 -> Supabase PostgreSQL 数据库
```

## 1. Supabase

先在 Supabase 创建项目，然后复制 PostgreSQL 连接串。

你需要的是类似下面这样的地址：

```env
DATABASE_URL=postgresql://postgres.xxxxx:你的密码@xxxxx:6543/postgres
```

注意：

- 不要把真实 `DATABASE_URL` 提交到 GitHub。
- 如果密码里有 `@`、`#`、`/`、`?` 等特殊字符，需要做 URL 编码，或者重新设置一个只含字母数字的数据库密码。
- 项目第一次启动时会自动创建表，并创建演示账号 `demo / demo123456`。

## 2. 本地可选测试

如果要在本地直接连 Supabase 测试，把 `.env.example` 复制成 `.env`，填入：

```env
PORT=3001
DATABASE_URL=你的 Supabase PostgreSQL 连接串
DEEPSEEK_API_KEY=你的 DeepSeek Key
DEEPSEEK_MODEL=deepseek-v4-flash
```

然后运行：

```powershell
npm.cmd install
npm.cmd --prefix client run build
npm.cmd start
```

访问：

```text
http://127.0.0.1:3001
```

## 3. Render

在 Render 创建 Web Service：

```text
New -> Web Service -> Connect GitHub repository
```

配置：

```text
Runtime: Node
Build Command: npm install && npm --prefix client run build
Start Command: npm start
```

环境变量：

```env
NODE_VERSION=22
NODE_ENV=production
PORT=3001
DATABASE_URL=你的 Supabase PostgreSQL 连接串
DEEPSEEK_API_KEY=你的 DeepSeek Key
DEEPSEEK_MODEL=deepseek-v4-flash
```

部署成功后，用户访问 Render 给你的网址即可使用。

## 4. 常见问题

如果 Render 日志里出现数据库连接失败：

- 检查 `DATABASE_URL` 是否完整。
- 检查 `[YOUR-PASSWORD]` 是否已经换成真实数据库密码。
- 检查密码里的特殊字符是否 URL 编码。
- 如果 Supabase 提示 IPv4/IPv6 连接问题，换用 Supabase 提供的 pooler 连接串，或启用 IPv4 add-on。

如果页面能打开但登录失败：

- 看 Render Logs。
- 确认 `DATABASE_URL` 和 `NODE_ENV=production` 已设置。
- 确认 Supabase 项目没有暂停。
