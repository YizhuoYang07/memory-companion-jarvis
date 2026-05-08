# Memory Companion — 个人记忆 AI 系统

**[中文](#中文) | [English](#english)**

---

<a name="中文"></a>

## 什么是 Memory Companion？

一个让 AI 真正记住你的个人记忆系统。它不是聊天机器人——是一个**陪你长期存在的对话伙伴**，跨对话保留你的故事、模式、关系、状态。

大多数 AI 助手在会话结束就忘记一切。这套系统不会。每次对话被存储、提炼、连接到过往记忆，下一次对话时被检索回来——**AI 真正认识你，而不是每次重新认识**。

```
你说话 → 消息入库
       → 异步：AI 提取个人事实、记忆事件、纠正
       → 异步：每日反思总结模式与未完成事项
       → 下一轮对话：检索相关记忆（语义 + 关键词 + 实体卡）
       → AI 带着记忆回应你
```

后端是你**自己托管**的 Node.js 服务，对话存在你自己服务器的 SQLite 文件里。配套的 iOS/macOS 原生客户端通过 HTTPS 连接到你的后端。

**不是 SaaS。** 没有云端账户、没有订阅、没有"我们"看到你的数据——你的数据只在你机器上。

---

## 核心设计哲学

**记忆是数据，不是 prompt。** 当你换底层对话模型（Sonnet → 未来某模型），记忆不会丢——因为它存在你 SQLite 里，不在任何模型的权重里。

**事实和推断分开。** 系统会把"用户出生在 X 城"（observed）和"用户重视精确"（inferred）用不同字段标记，让模型在使用时知道置信级别。

**纠正会改变记忆。** 你说"不是这样，是那样"，系统会找出对应的旧记忆条目并把它标记为已纠正。下次召回不再被打脸。

**重复不是噪声，是信号强度。** 你说 10 遍"我很想他"会被聚合成"持续思念，4 天，强度上升"，而不是 10 条独立条目。

---

## 功能特性

### 记忆层
- **持久对话**——所有消息存在本地 SQLite，自动按 conversation 组织
- **个人事实提取**——AI 从对话中学习你的稳定信息（教育、偏好、关系、兴趣等）
- **记忆事件**——AI 记录值得长期保留的具体事件（决策、状态变化、洞察）
- **纠正机制**——你的纠正被存档，能反向标记被纠正的旧记忆
- **每日反思**——每天 LLM 综合写一段"模式理解"，不是流水账日记

### 检索层
- **语义检索**——基于 embedding 的相似度，跨时间召回相关上下文
- **意图路由**——每轮先识别意图（时间问句、纠正、关系推理、健康话题等），不同意图走不同检索策略
- **实体卡**——为重要的人/地点/项目生成结构化卡片，让模型读到的是"关于 X 的当前状态"而不是 27 条零散事实
- **关系状态版本化**——关系会变；用 `(effective_at, superseded_at)` 区间表达"X 月时是 A 状态，Y 月变成 B"
- **跨时间模式识别**——独立的 pattern 层覆盖 5 个维度：情绪能量 / 关系动态 / 健康身体 / 思考价值观 / 创造产出

### 系统层
- **流式响应**——OpenAI-compatible SSE，逐 token 输出
- **OpenAI-compatible API**——任何兼容客户端都能接入；可换底层 LLM 提供商
- **完全自托管**——你自己的服务器，你自己的数据
- **零运行时依赖**——Node.js 24+ 内置 SQLite，省去包管理噩梦
- **完整测试套件**——70+ 测试覆盖 server、chat-service、extraction、retrieval、governance 等

---

## 技术栈

| 层级 | 技术 |
|---|---|
| 后端 | Node.js 24+，原生 `node:sqlite`（**零运行时 npm 依赖**）|
| 主回答模型 | 任何兼容 OpenAI Chat Completions 接口的 LLM（OpenAI、Anthropic、本地 vLLM 等）|
| 提取/判官模型 | 推荐用更便宜的小模型（Haiku 类、GPT-4o-mini 类），独立 `EXTRACTION_MODEL` 配置 |
| Embedding | text-embedding-3-small 或兼容模型 |
| 反向代理 | Caddy 2（自动 HTTPS）|
| 客户端 | SwiftUI iOS 17+ / macOS 14+，原生体验，无第三方依赖 |

**成本拆分**（典型个人使用）：主回答用强模型，extraction/反思 LLM 升级/correction 判官用小模型。月成本通常在几美元以内。

---

## 架构

```
iOS / macOS SwiftUI 客户端
    │  HTTPS + Bearer Token
    ▼
Caddy（TLS 终结）
    │
    ▼
Node.js 服务（端口 3030）
    │
    ├── 同步路径
    │     POST /v1/chat/completions
    │       ├── 检索（embedding + 关键词 + 实体卡 + 时间锚点）
    │       ├── 注入提示词包：
    │       │     [Person Understanding]   你写的关于自己的文档
    │       │     [Current Time]            本地时间 + 最近消息时间戳
    │       │     [Memory Context]          检索结果（事实、事件、反思、纠正）
    │       │     [Intent Hint]             路由策略提示
    │       └── 流式调用底层 LLM，SSE 转发
    │
    └── 异步路径（fire-and-forget，不阻塞响应）
          ├── 提取 profile facts / memory events / corrections
          ├── 计算 embeddings
          └── 触发当日 reflection（每天首条触发；多条则升级为 LLM 综合）
```

每轮检索的多源融合：

1. **最近消息**（200 条工作记忆窗口）
2. **语义召回事件**（embedding 相似度，剔除已在工作记忆中的）
3. **关键词召回事实**（防止低频但重要的条目被截断）
4. **实体卡**（命中已知实体时拼出整张卡）
5. **时间线**（时间问句时单独召回带 `occurred_at` 的事件）
6. **最新反思**（一段"模式理解"作为开场）
7. **最近纠正**（高优先级，禁止再犯）

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
EXTRACTION_MODEL=gpt-4o-mini       # 推荐用便宜模型，节省成本
EMBEDDING_MODEL=text-embedding-3-small
API_AUTH_TOKEN=自定义随机长字符串       # iOS/macOS 客户端连接时用
APP_HOSTNAME=memory.yourdomain.com
```

`API_AUTH_TOKEN` 自定义任意长随机串，不公开。

### 2. 准备你的 Person Model

```bash
# 复制模板
cp docs/PERSON_MODEL.md data/person-model.md
# 按模板填写你的身份基础（出生地、教育、健康诊断、关系、兴趣等）
# 建议只写"observable facts"，避免过度自我解释
```

### 3. 本地运行

```bash
docker compose up
```

服务在 `http://localhost:3030`。

```bash
curl http://localhost:3030/health
```

### 4. 部署到服务器

```bash
# 准备 Ubuntu 22.04+ 服务器，SSH 可达
bash scripts/bootstrap-digitalocean.sh

# 编辑 scripts/deploy.sh 设置 REMOTE 和 REMOTE_DIR
bash scripts/deploy.sh
```

部署机制：rsync 同步代码 + Docker 重建。**自动排除 `data/*.db` / `.env` / `backups/`**——保护生产数据不被本地覆盖。

### 5. iOS / macOS 客户端

```bash
cd apps/apple
xcodegen generate
open PersonalMemoryClient.xcodeproj
```

需要 Xcode 16+ 和 [XcodeGen](https://github.com/yonaskolb/XcodeGen)。

首次启动后进入 **Settings** 填 Backend URL 和 Auth Token。

---

## 数据模型

```
messages                    对话原始消息
profile_facts               稳定个人事实（kind, value, confidence, claim_type, salience_class, ...）
memory_events               事件性记忆（summary, score, occurred_at, claim_type, mention_count, ...）
corrections                 用户纠正（original, corrected, target_type, target_id）
reflections                 每日反思
entities                    实体（person/place/project/pet）
entity_facts                实体 ↔ 事实多对多
entity_events               实体 ↔ 事件多对多
relationship_state          关系状态版本化（effective_at, superseded_at）
patterns                    跨时间模式（5 个维度）
message_embeddings          向量
memory_event_embeddings     向量
```

每条事实/事件都带 `claim_type`：`observed`（用户直接说的）/ `inferred`（推断）/ `reported`（用户转述他人）/ `interpretive`（带强烈解读）。检索排序时不同 claim type 权重不同——观察>推断>解读。

每条事实/事件都带 `salience_class`：`identity` 不衰减 / `health` 90+ 天半衰期 / `relationship_state` 30-45 天 / `preference` 60 天 / `current_focus` 14-21 天 / `general` 30 天。每次被召回 salience += 0.1。无关旧事不会永远占前台。

---

## 数据与隐私

所有数据存在你自己服务器上的 `data/memory.db`（SQLite）。除以下情况外**不向任何第三方发送数据**：

- 你的消息 → 你选择的 LLM 提供商 API（按你 `OPENAI_BASE_URL` 配置走哪条路）
- 待 embedding 的文本 → 你选择的 embedding API

`.gitignore` 强制排除以下文件，**永远不会被 git 提交**：

- `.env`（API Key 和认证密钥）
- `data/memory.db`（你的对话数据库）
- `data/person-model.md`（你的个人背景文件）
- `backups/`（数据库备份）
- `docs/`（设计文档与对话历史）
- `scripts/seed-data.js`（如果你写了个人版本）

---

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `OPENAI_BASE_URL` | 是 | API 基础 URL（OpenAI / Anthropic / 自部署都行）|
| `OPENAI_API_KEY` | 是 | LLM API Key |
| `OPENAI_MODEL` | 是 | 主对话模型名称 |
| `EXTRACTION_MODEL` | 否 | 提取/判官小模型（默认同 `OPENAI_MODEL`，建议另设便宜的）|
| `EMBEDDING_BASE_URL` | 否 | embedding 接口 URL（默认 OpenAI）|
| `EMBEDDING_API_KEY` | 否 | embedding key（默认复用 `OPENAI_API_KEY_GPT`）|
| `EMBEDDING_MODEL` | 否 | embedding 模型（默认 `text-embedding-3-small`）|
| `API_AUTH_TOKEN` | 是 | 客户端 Bearer 认证 |
| `APP_HOSTNAME` | 是 | 公网域名（Caddy + 健康检查用）|
| `MEMORY_DB_PATH` | 否 | SQLite 路径（默认 `data/memory.db`）|
| `PORT` | 否 | 服务端口（默认 3030）|
| `RATE_LIMIT_MAX_REQUESTS` | 否 | 速率限制上限 |
| `RATE_LIMIT_WINDOW_MS` | 否 | 速率限制窗口（毫秒）|
| `USER_TIMEZONE` | 否 | 用户时区（默认 `UTC`，影响 [Current Time] 注入）|

---

## API

需要 `Authorization: Bearer <API_AUTH_TOKEN>`，除了 `/health`。

### 聊天（OpenAI-compatible，含流式）

```
POST /v1/chat/completions
{
  "model": "gpt-4o",
  "stream": true,
  "messages": [...],
  "metadata": {
    "conversationId": "...",
    "clientConversationId": "客户端 UUID（用于跨 thread 映射）",
    "requestId": "...（幂等键）"
  }
}
```

返回 OpenAI 格式 SSE 流。响应里额外有 `conversation_id` 和 `retrieval_context`（用于客户端调试）。

### 会话管理

```
GET  /v1/conversations
POST /v1/conversations
PATCH /v1/conversations/:id
DELETE /v1/conversations/:id
GET  /v1/conversations/:id/messages
GET  /v1/client/state            # 客户端冷启动恢复（conversationId 或 clientConversationId）
```

### 记忆数据

```
GET    /v1/profile-facts
POST   /v1/profile-facts          # 手动插入
DELETE /v1/profile-facts/:id      # 手动删除
GET    /v1/memory-events
GET    /v1/reflections
GET    /v1/reflections/:date
POST   /v1/reflections/daily
```

### 监控

```
GET /health                       # 含 provider/model/db/auth/rate-limit 元信息
GET /metrics                      # Prometheus 文本格式
```

---

## 备份与恢复

```bash
node scripts/backup.js backups/
node scripts/restore.js backups/memory-2026-01-01.sqlite
```

恢复时务必先停服务，避免 SQLite 的 `-wal` / `-shm` 文件干扰。

---

## 测试

```bash
npm test
```

使用 Node 内置 `node:test`，70+ 测试覆盖核心模块。

---

## 版本历史

仅作时间线索引，详细技术变更见各 release notes 和源码 commit history。

| 版本 | 日期 | 一句话总结 |
|---|---|---|
| **V1.0** | 2026-03 | 首个完整 scaffold：Node + SQLite + OpenAI-compatible + 流式 + iOS/macOS 客户端 |
| **V1.1** | 2026-03-30 | 检索重构：embedding 语义搜索取代纯 token overlap；CJK 中文支持修复 |
| **V2.0** | 2026-04-02 | 架构级重写：person-model 注入 + 时间感知 + 纠正机制 + 意图检测 + 检索路由 |
| **V2.1** | 2026-04-24 | "走在用户前面"：扩大上下文窗口、反思变成模式综合而非流水账、token 清理 |
| **V2.2** | 2026-05-07 | Memory governance：保守治理 + 新测试套件 + Swift 客户端刷新 + 严格脱敏 |
| **V3** | 2026-05-08+ | 数据模型重构：实体表 + 关系状态版本化 + claim_type + salience 多档 + 跨时间 patterns。让记忆能跨模型代际存活 |

---

## 设计哲学（节选）

> "记忆系统的核心问题是身份连续性。模型会被淘汰，记忆不能。所以记忆必须存在数据形状里，不能寄生在任何一个模型的权重里。下一代模型读到的不应该是'诚实'二字，而应该是带 claim_type 标签的数据——它无论怎么解释'诚实'都不能把推断当事实，因为数据已经替它分开了。**价值观成为协议，不是指令。**"

---

## 许可证

MIT

---

<a name="english"></a>

## What is Memory Companion?

A personal AI memory system that genuinely remembers you across conversations. Not a chatbot — a **conversational partner that exists with you over time**, retaining your story, patterns, relationships, and state across sessions.

Most AI assistants forget everything when the session ends. This system doesn't. Every conversation is stored, refined, linked to past memories, and retrieved on the next conversation — so the AI **builds real understanding of you** rather than starting from scratch each time.

```
You talk    → messages stored
            → async: AI extracts profile facts / memory events / corrections
            → async: daily reflection summarizes patterns & open loops
            → next turn: retrieves relevant memory (semantic + keyword + entity cards)
            → AI responds with actual memory of your past
```

The backend is **self-hosted** Node.js. Your conversations live in a SQLite file on your own server. The accompanying iOS/macOS native client connects via HTTPS.

**Not SaaS.** No cloud account, no subscription, no "we" reading your data — your data only lives on your machine.

---

## Core design philosophy

**Memory is data, not prompts.** When you swap the underlying conversational model, memory doesn't get lost — it lives in your SQLite, not in any model's weights.

**Facts and inferences stay separated.** The system distinguishes "user was born in city X" (observed) from "user values precision" (inferred), so the model knows the confidence level when using each.

**Corrections retract memory.** If you say "no, it's actually that," the system finds the corresponding old entry and marks it superseded. Next retrieval won't keep tripping on it.

**Repetition isn't noise — it's signal strength.** Saying "I miss him" 10 times gets aggregated into "sustained longing, 4 days, intensity rising," not 10 separate entries.

---

## Features

### Memory layer
- **Persistent conversations** stored in local SQLite
- **Profile fact extraction** — AI learns stable facts about you
- **Memory events** — meaningful events worth long-term retention
- **Corrections** — your corrections retract conflicting old memories
- **Daily reflections** — LLM-synthesized "pattern understanding," not a diary entry

### Retrieval layer
- **Semantic search** via embeddings, across all time
- **Intent-based routing** — different intents (time queries, corrections, relationship reasoning, health topics) trigger different retrieval strategies
- **Entity cards** — for important people / places / projects, retrieves a structured card rather than scattered facts
- **Versioned relationship state** — relationships change; `(effective_at, superseded_at)` ranges express "was state A in March, became state B in April"
- **Cross-time pattern detection** — independent pattern layer covers 5 dimensions: emotional energy / relational dynamics / health & body / thinking & values / creation & output

### System layer
- **Streaming responses** — OpenAI-compatible SSE
- **OpenAI-compatible API** — any compatible client connects; LLM provider swappable
- **Fully self-hosted** — your server, your data
- **Zero runtime dependencies** — Node.js 24+ with built-in SQLite
- **Comprehensive test suite** — 70+ tests across server, chat-service, extraction, retrieval, governance

---

## Quick start

```bash
git clone https://github.com/your-username/memory-companion
cd memory-companion
cp .env.example .env
# Edit .env with your API keys and auth token
docker compose up
```

See the Chinese section above for the full step-by-step setup — the procedure is identical.

---

## Deploy

```bash
bash scripts/bootstrap-digitalocean.sh
# Edit scripts/deploy.sh with your REMOTE and REMOTE_DIR
bash scripts/deploy.sh
```

The deploy script uses rsync + Docker rebuild and **explicitly excludes** `data/*.db`, `.env`, `backups/` — protecting production data from being clobbered by local copies.

---

## iOS / macOS client

Requires Xcode 16+ and [XcodeGen](https://github.com/yonaskolb/XcodeGen).

```bash
cd apps/apple && xcodegen generate
open PersonalMemoryClient.xcodeproj
```

In Settings, configure your Backend URL and Auth Token.

---

## Version history

| Version | Date | One-liner |
|---|---|---|
| **V1.0** | 2026-03 | Complete scaffold: Node + SQLite + OpenAI-compatible + streaming + iOS/macOS client |
| **V1.1** | 2026-03-30 | Retrieval rewrite: embedding semantic search; CJK fix |
| **V2.0** | 2026-04-02 | Architecture rewrite: person-model + time awareness + corrections + intent routing |
| **V2.1** | 2026-04-24 | "Walk ahead of the user": wider context window, reflection as pattern synthesis |
| **V2.2** | 2026-05-07 | Memory governance: conservative cleanup + new test suite + Swift client refresh |
| **V3** | 2026-05-08+ | Data-model rebuild: entity table + versioned relationship state + claim_type + multi-tier salience + cross-time patterns. Makes memory survive model upgrades |

---

## Design philosophy (excerpt)

> "The core problem of a memory system is identity continuity. Models get deprecated; memory shouldn't. So memory must live in data shape, not in any model's weights. The next model should read tagged data — `claim_type=observed` vs `inferred` — not the word 'honest.' No matter how it interprets 'honest,' it cannot conflate inference with fact, because the data has already separated them. **Values become protocol, not instruction.**"

---

## License

MIT
