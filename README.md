# Memory Companion — 个人记忆 AI 系统

**[中文](#中文) | [English](#english)**

---

<a name="中文"></a>
## 什么是 Memory Companion？

一个让 AI 真正记住你的个人记忆系统。

大多数 AI 助手在会话结束后就忘记一切。这个系统不会。每一次对话都被存储下来，经过反思和提炼，并在下一次对话时被检索出来——AI 会随着时间推移真正了解你，而不仅仅是在单次对话中。

```
你说话 → 消息入库 → AI 提取个人资料与记忆事件
                   → 每日 reflection 总结规律与未完成事项
                   → 下次对话时检索相关记忆
                   → AI 带着真实记忆回应你
```

后端是你自己托管的 Node.js 服务，对话存储在本地 SQLite 中。配套的 iOS/macOS 原生客户端通过 HTTPS 连接到你的服务器。

---

## 功能特性

- **持久记忆** — 每次对话都被存储，AI 自动检索相关历史上下文
- **个人资料提取** — AI 从对话中学习你的稳定信息（职业、关系、兴趣等）
- **每日 Reflection** — 每天生成一篇反思：讨论了什么、未完成的线索、演变中的规律
- **Person Model** — 你自己写的一份关于自己的文本，每次对话都注入系统提示词
- **流式响应** — 逐 token 输出，体验接近 ChatGPT
- **iOS & macOS 原生客户端** — SwiftUI 开发，无第三方依赖
- **完全自托管** — 数据存在你自己的服务器，除你选择的 LLM 提供商外不与任何第三方共享

---

## 技术栈

| 层级 | 技术 |
|---|---|
| 后端 | Node.js 24+，`node:sqlite`（零运行时 npm 依赖） |
| LLM | 任何兼容 OpenAI 接口的 API（OpenAI、Anthropic、本地模型） |
| Embeddings | `text-embedding-3-small` 或兼容模型 |
| 服务器 | Docker + Caddy（HTTPS、反向代理） |
| iOS/macOS 客户端 | SwiftUI，iOS 17+，macOS 14+ |

---

## 快速开始

### 1. 克隆并配置

```bash
git clone https://github.com/your-username/memory-companion
cd memory-companion
cp .env.example .env
```

编辑 `.env`：

```env
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
EMBEDDING_MODEL=text-embedding-3-small
API_AUTH_TOKEN=你自定义的随机密钥
APP_HOSTNAME=memory.yourdomain.com
```

`API_AUTH_TOKEN` 是 iOS/macOS 客户端在 `Authorization` header 中发送的密钥，设置为任意随机长字符串，保密不公开。

### 2. 写你的 Person Model

```bash
cp docs/PERSON_MODEL.md data/person-model.md
# 按照模板填写你自己的信息
# 具体写什么参考 docs/PERSON_MODEL.md
```

### 3. 本地运行

```bash
docker compose up
```

服务启动在 `http://localhost:3030`。

验证：
```bash
curl http://localhost:3030/health
```

### 4. 导入初始数据（可选）

如果你希望 AI 在开始对话前就了解你的背景：

```bash
# 先编辑 scripts/seed-data.js，填入你自己的内容
node scripts/seed-data.js
```

---

## 部署到服务器

内置部署脚本使用 rsync + Docker Compose。

### 准备工作

- Ubuntu 22.04+ 服务器（DigitalOcean、AWS、Hetzner 等均可）
- SSH 密钥访问
- 一个指向服务器的域名

### 初始化服务器环境

```bash
bash scripts/bootstrap-digitalocean.sh your-user@your-server-ip
```

### 配置 Caddy

编辑 `deploy/Caddyfile`：
```
memory.yourdomain.com {
    reverse_proxy localhost:3030
}
```

### 部署

```bash
# 先在 scripts/deploy.sh 中修改 REMOTE 和 REMOTE_DIR
bash scripts/deploy.sh
```

---

## iOS / macOS 客户端

原生客户端位于 `apps/apple/`，需要 Xcode 16+ 和 [XcodeGen](https://github.com/yonaskolb/XcodeGen)。

```bash
cd apps/apple
xcodegen generate
open PersonalMemoryClient.xcodeproj
```

首次启动后，进入 **Settings** 填写 Backend URL 和 Auth Token。

---

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `OPENAI_BASE_URL` | 是 | API 基础 URL（兼容 OpenAI 接口） |
| `OPENAI_API_KEY` | 是 | LLM 提供商的 API Key |
| `OPENAI_MODEL` | 是 | 对话模型名称 |
| `EMBEDDING_MODEL` | 是 | Embedding 模型名称 |
| `EXTRACTION_MODEL` | 否 | 提取用的轻量模型（默认同 `OPENAI_MODEL`） |
| `API_AUTH_TOKEN` | 是 | 客户端认证密钥 |
| `APP_HOSTNAME` | 是 | 公网域名（供 Caddy 和健康检查使用） |
| `MEMORY_DB_PATH` | 否 | SQLite 路径（默认 `data/memory.db`） |
| `PORT` | 否 | 服务端口（默认 3030） |

---

## 数据与隐私

所有数据存储在你自己服务器上的 `data/memory.db`（SQLite）中。除以下情况外，不向任何第三方发送数据：

- 你的消息 → 你选择的 LLM 提供商 API
- 待 embedding 的文本 → 你选择的 embedding API

以下文件**永远不会被 git 提交**（已在 `.gitignore` 中强制排除）：

- `.env` — API Key 和认证密钥
- `data/memory.db` — 你的对话数据
- `data/person-model.md` — 你的个人背景文件
- `backups/` — 数据库备份

---

## API 说明

所有接口需要 `Authorization: Bearer <API_AUTH_TOKEN>`。

### 聊天（流式）

```
POST /v1/chat/completions
Content-Type: application/json

{
  "model": "gpt-4o",
  "stream": true,
  "messages": [{"role": "user", "content": "我最近在忙什么？"}],
  "metadata": {
    "conversationId": "服务端会话 ID 或 null",
    "clientConversationId": "客户端 UUID",
    "requestId": "UUID"
  }
}
```

返回 OpenAI 格式的 Server-Sent Events 流。

### 会话管理

```
GET  /v1/conversations
GET  /v1/client/state?conversationId=&clientConversationId=
```

### 记忆数据

```
GET  /v1/reflections
GET  /v1/profile-facts
GET  /v1/memory-events
```

### 健康检查

```
GET  /health
```

---

## 备份与恢复

```bash
node scripts/backup.js backups/
node scripts/restore.js backups/memory-2025-01-01.sqlite
```

---

## 运行测试

```bash
npm test
```

---

## 架构图

```
iOS/macOS 客户端
      │  HTTPS + Bearer Token
      ▼
  Caddy（TLS 终结）
      │
      ▼
  Node.js 服务（端口 3030）
   ├── POST /v1/chat/completions  ──► LLM API（流式）
   │        │
   │        └── 异步提取 pipeline（fire-and-forget）
   │              ├── 个人资料提取
   │              ├── 记忆事件提取
   │              └── 每日 reflection（新的一天触发）
   │
   ├── GET  /v1/client/state      ──► SQLite
   ├── GET  /v1/reflections       ──► SQLite
   ├── GET  /v1/profile-facts     ──► SQLite
   └── GET  /v1/memory-events     ──► SQLite
```

每轮对话的上下文检索：
1. 语义搜索记忆事件（embedding 相似度）
2. 最新每日 reflection
3. 活跃个人资料
4. Person Model（`data/person-model.md`）

---

<a name="english"></a>
## What is Memory Companion?

A personal AI memory system that remembers who you are across conversations.

Most AI assistants forget everything when the session ends. This one doesn't. Every conversation is stored, reflected upon, and retrieved — so the AI builds up a real understanding of you over time, not just within a single chat.

```
You talk → messages stored → AI extracts profile facts & memory events
                           → daily reflection summarizes patterns & open loops
                           → next conversation retrieves relevant context
                           → AI responds with actual memory of your past
```

---

## Features

- **Persistent memory** — every conversation stored; AI retrieves relevant past context automatically
- **Profile extraction** — AI learns stable facts about you from what you tell it
- **Daily reflection** — written summary each day: topics, open threads, evolving patterns
- **Person model** — a plain-text file you write about yourself; injected into every conversation
- **Streaming responses** — token-by-token output
- **Native iOS & macOS client** — SwiftUI, no third-party dependencies
- **Self-hosted** — your data stays on your server

---

## Quick start

```bash
git clone https://github.com/your-username/memory-companion
cd memory-companion
cp .env.example .env
# Edit .env with your API keys and auth token
docker compose up
```

See the Chinese section above for full step-by-step instructions — the setup is identical.

---

## Deploy

```bash
bash scripts/bootstrap-digitalocean.sh your-user@your-server-ip
# edit scripts/deploy.sh with your REMOTE and REMOTE_DIR
bash scripts/deploy.sh
```

---

## iOS / macOS client

Requires Xcode 16+ and [XcodeGen](https://github.com/yonaskolb/XcodeGen).

```bash
cd apps/apple && xcodegen generate
open PersonalMemoryClient.xcodeproj
```

---

## License

MIT
