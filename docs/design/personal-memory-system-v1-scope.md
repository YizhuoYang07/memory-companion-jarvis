---
title: Personal Memory System V1 Scope
description: 对话式个人记忆系统的第一阶段范围定义，只保留必须验证的最小闭环
summary: 把长期蓝图压缩成真正可做的 V1，只验证对话自动入库、记忆检索与 daily reflection
---

# Personal Memory System V1 Scope

## 文档目的

本文档不是长期蓝图。

它只回答一个问题：

第一阶段到底做什么，什么不做。

配套长期文档见：

- `/design/personal-memory-system-blueprint`

原则：

- 长期愿景可以大
- V1 必须狠
- 任何不能直接服务“连续性最小闭环”的内容，都延后

## V1 的一句话定义

V1 是一个以对话为中心、以记忆检索为核心闭环的个人连续性系统。

它只验证一件事：

通过对话自动入库 + 少量高质量记忆检索，系统是否能在第二天比第一天更自然地接住用户。

如果这件事不成立，图片、定位、前端壳优化都不重要。

## V1 必做

V1 只保留三项必做能力。

## 1. 对话自动入库

系统必须稳定保存：

- conversation
- user message
- assistant message
- message timestamp
- message ordering

最低要求：

- 一轮对话结束后，原始消息可靠落库
- 历史线程可被按时间和会话恢复
- 不要求复杂多端同步

这是地基，不是 feature。

## 2. Retrieval-aware 对话

每次新消息到来时，系统执行最小闭环：

1. 读取当前消息
2. 从历史中检索少量相关记忆
3. 组装一个小上下文包
4. 调用模型生成回答
5. 把本轮结果再写回系统

V1 的重点不是“检索很多”，而是“检索得准”。

V1 推荐只检索三类内容：

- 最近相关消息
- 近期 memory events
- 高置信 profile facts

不要求：

- 复杂 reranking
- 大规模向量流水线优化
- episode 图谱

## 3. Daily reflection

只做 daily，不做 weekly。

daily reflection 只负责：

- 总结今天发生了什么
- 标记哪些线程还在继续
- 提出少量 profile 候选

它不是用户可见的花哨功能，而是系统内的沉淀步骤。

如果 daily 不稳定，weekly 没有意义。

## V1 延后

这些内容有价值，但全部明确延后到后续阶段。

## 1. 图片长期记忆

图片长期是正确方向，但不是 V1 的验证项。

原因：

- 会立刻引入对象存储
- 会引入 vision summary schema
- 会引入图片与 event 的长期绑定
- 会增大检索排序复杂度

后续可以先做“图片即时理解”，但不进入 V1 核心验收。

## 2. 定位桥

定位也延后。

原因：

- 会引入 iOS 权限处理
- 会引入上传频率和后台策略
- 会引入地点解析与状态同步

定位是有价值的 grounding，但不是连续性闭环成立的前提。

## 3. Episode 正式层

episode 是长期系统的重要层，但 V1 不要求完整落地。

V1 可以只通过轻量 event 和 profile 近似表达连续性。

## 4. Weekly reflection

weekly reflection 明确延后。

先把 daily 做稳定，再谈二阶沉淀。

## 5. 原生前端壳优化

V1 可以使用最小可用入口，不要求一开始就把长期前端壳定死。

如果现成原生壳接入成本过高，优先保证闭环，而不是保证入口完美。

## V1 删除

这些内容不只是延后，而是从 V1 范围中显式删除。

- briefing
- 文件检索
- 邮件、日历、Git、网页收藏等被动采集
- planner-first runtime
- job automation
- 多 specialist orchestration
- 为了兼容很多客户端而做的大量协议适配

删掉它们的原因只有一个：

它们都不直接验证“连续性最小闭环”。

## V1 最小架构

```text
Simple Chat Client
  ↓
Conversation Gateway
  ↓
Raw Log Store
  ↓
Memory Extractor (light)
  ↓
Retrieval Assembler
  ↓
LLM
```

这里故意不出现：

- location bridge
- media pipeline
- episode layer
- weekly reflection

不是它们没价值，而是它们不该抢占第一阶段。

## V1 数据模型

V1 只需要五类核心表。

## 保留

- `conversations`
- `messages`
- `memory_events`
- `profile_facts`
- `retrieval_logs`

## 可先留空或极简

- `reflections`

## 不进入 V1 真正实现

- `media_assets`
- `location_snapshots`
- `episodes`
- `episode_events`

原则：

schema 漂亮不等于系统成立。

## V1 核心流程

```text
new user message
  -> store raw message
  -> retrieve related history
  -> assemble compact context
  -> call model
  -> store assistant reply
  -> enqueue light extraction
  -> update daily reflection material
```

提炼只做轻量规则：

- 提取明确事实
- 提取正在做的事情
- 提取稳定偏好候选
- 不强行做复杂人生建模

## V1 验收标准

V1 只看四条。

1. 系统能稳定保存和恢复多轮对话。
2. 新消息到来时，系统能检索出少量相关历史并参与回答。
3. 第二天继续对话时，回答明显比“纯新会话”更有连续感。
4. daily reflection 能稳定生成，并对后续 retrieval 有帮助。

如果这四条里有一条站不住，V1 就不算成立。

## V1 不看什么

以下内容即使很好，也不能拿来证明 V1 成功：

- UI 很漂亮
- 支持图片
- 支持定位
- 支持很多模型
- 支持很多客户端
- schema 很完整

这些都可能是以后重要的东西，但都不是第一阶段的胜负手。

## 开工顺序

推荐按这个顺序推进：

1. raw conversation persistence
2. minimal retrieval assembly
3. retrieval-aware reply path
4. light memory extraction
5. daily reflection

任何一步如果不稳，先修稳再做下一步。

## 最终判断

如果 V1 做完后，系统依然像“一个记性稍微好一点的聊天机器人”，那说明范围虽然收了，但闭环还没成立。

只有当它开始表现出这种感觉时，V1 才算成功：

你不需要重复交代很多背景，它能自然接住你最近在做什么、想什么、卡在哪里。
