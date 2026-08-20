# 公证所交易市场 v1.1 — Cloudflare Workers / GitHub 部署版

这是从原 Railway/FastAPI 版本迁移后的 Cloudflare 版本。它使用 Cloudflare Worker + Durable Object + Durable Object SQLite + Workers Static Assets。

## 最简单的部署方式：GitHub → Cloudflare

你不需要在电脑安装 Node.js，也不需要安装 Wrangler。

### 1. 创建 GitHub 仓库

在 GitHub 新建一个仓库，例如：

`gongzhengsuo-market`

然后把**本目录里的所有文件直接上传到仓库根目录**，不要再套一层 `toutiao-github-final/` 文件夹。

仓库最终结构应当是：

```text
.
├─ public/
│  ├─ index.html
│  └─ bgm.mp3
├─ src/
│  └─ index.js
├─ package.json
├─ wrangler.jsonc
└─ README.md
```

### 2. 在 Cloudflare 网页端部署

进入 Cloudflare Dashboard：

`Workers & Pages` → `Create application` → `Import a repository`

选择刚才的 GitHub 仓库。

如果页面要求填写构建设置，使用：

- **Build command：** `npx wrangler deploy`
- **Deploy command：** 留空（如果界面要求填写 Deploy command，则同样填写 `npx wrangler deploy`）
- **Build output directory：** 留空
- **Root directory：** `/`

项目根目录已经包含 `wrangler.jsonc`，Cloudflare 会据此创建 Worker、Durable Object 和 SQLite migration，同时部署 `public/` 中的网页和音频资源。

### 3. 部署完成

Cloudflare 会生成 `*.workers.dev` 地址。直接打开该地址即可。

HTTPS 页面下，前端会自动把 `/ws/<player_id>` 连接转换为 `wss://`，不需要手动修改 WebSocket 地址。

## 项目结构

- `src/index.js`：Worker + Durable Object 后端
- `public/index.html`：原来的 Windows 95 风格前端
- `public/bgm.mp3`：背景音乐
- `wrangler.jsonc`：Cloudflare Worker / Durable Object 配置
- `package.json`：Cloudflare 构建所需的 Wrangler 依赖

## 与原 Railway/Python 版本的对应关系

| 原版本 | Cloudflare 版本 |
|---|---|
| FastAPI | Worker `fetch()` |
| `/ws/{player_id}` | Worker 转发到 Durable Object |
| `asyncio` 定时循环 | Durable Object Alarm |
| SQLite `game.db` | Durable Object SQLite |
| 进程内连接池 | Durable Object WebSocket API |
| `static/` | Workers Static Assets `public/` |

## 关于原来的 game.db

你上传给我的这份 `game.db` 中 `players` 表目前没有玩家记录，因此这次迁移不需要导入旧玩家数据。

如果 Railway 线上实际运行的数据库已经产生玩家资料，需要从 Railway 上那份数据库单独导出后再迁移；本版本不会自动读取 Railway 数据库。

## 登录机制

原程序使用玩家自行输入的名称作为 `player_id`，没有密码认证。这一行为在迁移过程中保持不变。
