---
title: Rudder 原生 Chat 体验与 Agent Run 执行架构完整改造计划
date: 2026-09-21
kind: implementation
status: proposed
area: agent_runtimes
entities:
  - agent_run
  - runtime_session
  - side_chat
  - chat_transcript
---

# Rudder 原生 Chat 体验与 Agent Run 执行架构完整改造计划

## 1. 本次交付：两个目标必须同时完成

本次改造包含两条同等重要、相互依赖的主线。不能只完成其中一条，也不能把它缩减为给数据库增加一个 Session ID。

**主线 A：原生 Chat 体验。**用户在 Rudder 中与某个 Agent 聊天，实际是在持续使用该 Agent Runtime 的原生会话。多轮上下文、工具调用、原生压缩、工具结果、交互请求、控制和分支沿用 Runtime 的机制。Rudder 增加自己的指令、业务工具和交互界面，不重新拼一份有损的历史冒充原生会话，也不因适配能力不足而暗中屏蔽原生功能。用户仍能查看有权限查看的过程、工具细节、文件修改、子 Agent 活动和最终回答。

**主线 B：Agent Run 驱动与存储改造。**Agent Run 是跨场景、跨 Runtime 的统一受管理执行单元。Chat、Side Chat、Issue、Review、Automation、Heartbeat 都使用同一套执行底座。每个 Run 绑定自己的原生执行区间，多个连续 Run 可以共享同一条原生逻辑会话。完整原始 Transcript 默认由原生 Runtime 持久化；Rudder 保存定位、归属、结果和必要的产品数据，通过统一 Reader 按需读取，不在业务数据库和多条日志链路里重复保存全部原始过程。

这两个目标共同构成完成标准。只有原生连续对话、但仍重复存储所有事件，不算完成；只减少存储、却破坏历史查看和 Side Chat，也不算完成。

### 1.1 必须保留的范围

实现 Codex、Claude Code、Hermes、OpenCode、Pi、Cursor 六条适配，不能以“其他 Runtime 继续使用旧实现”作为最终交付。前五种是完整原生会话集成的一等交付；Cursor 使用其实际可用的原生能力，对历史导出、精确 Fork 或 Steer 的真实缺口按下文规则处理。现有 Gemini 和 OpenClaw 保持可用，接入公共底座时做回归，不在本次顺带重写无关能力。

Side Chat 的临时草稿、首次发送、创建者权限、来源回复锚点、过期、关闭、Move to Messenger、标题、分组、父 Chat 状态以及已有交互必须保留。原生 Runtime 没有“临时聊天转永久聊天”的产品功能，不构成删除 Rudder 该功能的理由。

保留预算、权限、审批、任务认领、工作空间安全、附件、反馈、批注、学习、导出和审查等现有能力。Issue 的认领与状态规则只在其所属业务场景执行，不能成为 Chat 发起 Run 的前置条件。

### 1.2 “原生一致”的明确含义

对照条件是同一授权 Profile、同一模型与配置、同一工作目录、同一工具与技能范围。比较的是会话与控制语义，不要求模型输出逐字一致，也不要求复制终端像素、快捷键或 ANSI 外观。原生可执行的功能应有等价的 Rudder 控件或经过授权的原生命令入口；纯终端自定义界面无法直接搬到浏览器时，需要明确的桥接或等价交互，不能静默忽略。

区分三份信息：原生模型恢复状态、原生可持久化历史、Rudder 的用户可见投影。它们不必完全相同。只有 Runtime 公开并允许展示的 reasoning 文本或摘要可以展示；隐藏或加密的内部状态保持不透明，不尝试从可见推理重建它。

### 1.3 基线和证据边界

本文合并此前完整方案、Side Chat 契约、六种 Runtime 规范及其审查发现，删除的是额外的进度模板、空白验收账本和分散文件，不删除技术范围。本文单独可用于执行，不依赖旧压缩包里的其他文件。

此前 Rudder 代码审计覆盖过 `287b2cb156eac986ab8aa23f4095a2bd06f35980` 和 `c54001819ca38079b627994557db0a18ed278fc0`；它们只用于定位历史证据，不能要求本地工作树回退到这些 SHA。本次是方案整合，不声称重新审计了当前本地仓库或通过了原生运行测试。公共接口资料是协议线索，实际方法、版本、保留策略和行为必须按已安装 Runtime 验证。

此前审计中的问题线索包括：普通新一轮 Chat 不通过恢复 Run 的分支复用原生 Session；历史在 prompt helper 中以最近消息重新组装；过程事件与下一轮模型上下文分别处理；普通结果依赖文本 sentinel；部分原生提问没有进入完整的人机往返。实现前应定位这些路径在当前代码中的继任模块，不因文件移动而漏改，也不把已经改好的代码退回旧状态。

## 2. 目标架构与职责分配

```text
主 Chat / Side Chat / Issue / Review / Automation / Heartbeat
                         │
                  场景自己的业务校验
                         │
                         ▼
             统一 Agent Run 执行入口
   权限、预算、准入、排队、Attempt、租约、恢复、终态
                         │
              逻辑会话绑定与原生执行定位
                         │
                         ▼
                Runtime-specific Driver
                         │
                         ▼
       Codex / Claude / Hermes / OpenCode / Pi / Cursor
                原生会话、工具、压缩、历史

Chat / Run Detail / 批注 / 反馈 / 学习 / 导出
                         │
                         ▼
                统一 Transcript Reader
                         │
       校验权限 → 解析 Run 范围 → 定位 Host/原生资源
                         │
             原生读取 / 旧日志 / 必要的对象补充
                         │
                    统一展示投影
```

这些是模块边界，不要求新建微服务。优先在现有服务和 Adapter 内抽出可复用模块，复用当前 TS/Rust 权威实现，不重新写第二套执行状态机或调度器。

### 2.1 Rudder 负责什么

Rudder 负责产品 Conversation、Agent 身份与授权、场景、工作目标和关联、用户输入的可靠提交、Run/Attempt 身份、预算和并发、对人类操作的授权、可见输出截止点、历史读取权限、数据保留引用和 UI 状态。

普通 Chat 和 Side Chat 共用发送、控制、事件解释与过程展示能力，但各自保留独立的草稿、附件、滚动、选中分支和活动 Generation。不能为了组件复用，把它们的状态按 Agent ID 合并。

### 2.2 Runtime 负责什么

Runtime 负责模型执行、原生工具循环、原生会话状态、上下文压缩、原生历史、原生分支机制以及实际执行中的人机交互请求。Driver 将 Rudder 的明确操作翻译成该 Runtime 的协议，并把原生结果翻译成统一事件；Driver 不把所有 Runtime 降到“给模型一大段字符串”的共同最低能力。

原生工具、Memory、Skills、插件、模型配置、指令文件应在既有授权边界内继续加载。逐项检查现有启动 flag、执行后清理和托管目录逻辑：清理一次性凭证/临时输入可以保留，不能每轮清空 provider memory、无说明禁用插件/内置 Skills 或更换认证方式。Rudder 的扩展不能无意覆盖原生基础系统指令，也不能通过新全局配置禁用原生能力却仍声称体验一致。

### 2.3 Run、Session、进程和 Conversation 的关系

```text
Conversation C → Binding B → 原生 Segment S1
用户输入 M1 → Run R1 / Attempt A1 → S1 的执行区间 T1
用户输入 M2 → Run R2 / Attempt A2 → S1 的执行区间 T2
用户输入 M3 → Run R3 / Attempt A3 → S1 的执行区间 T3

若原生压缩产生后继存储：Binding B → S2，S1 仍是旧 Run 的来源
若用户 Fork：创建 Binding B2，不能改写 B 的历史归属
若进程重启：恢复 B 指向的原生状态，不因此新建 Conversation
```

一次普通 Chat 输入通常对应一个 Run 和一个主要原生执行区间。原生工具循环中的每次模型请求不自动创建新的 Rudder Run；一个 Run 可以包含多个原生低层回合。恢复、重试和原生子 Agent 可以增加区间，必须保持各自来源与费用。

启动前失败的 Run 可以没有原生区间，只保留有限启动诊断。原生接受状态不明的 Run 标记待核对，不填假 Session ID。复制历史不复制原 Run 的执行、费用或审批权。打开历史、打开侧边面板、Keep 等纯产品操作不产生模型 Run。

## 3. 主线 A：原生 Chat 的具体实现

### 3.1 第一次发送

首先按现有规则验证用户、Conversation、Agent、模型选择、附件、Workspace 和预算，并保存用户输入及幂等提交标识。然后调用统一 Run 入口，带入“新建原生会话”的意图；由底座准备 Profile、创建原生状态并尽早持久化绑定，再开始原生执行。

如果某 Runtime 将 Fork 与第一次 Query 合在同一个调用里，先保存创建意图，并在初始化事件中尽早绑定原生 ID。不能发送空的假消息来分配 Session，也不能在未开始推理时伪造一个成功 Run。

### 3.2 第二次以及后续发送

根据当前 Conversation 的明确绑定继续原生会话，发送本轮新增内容，不查找 Agent 最近一次 Run 或目录里的 latest Session。

```text
本轮输入 = 用户新文本 + 新附件 + 用户主动选中的引用 + 必要的业务变化
不包含 = recentMessages 全量重放 / Rudder 合成完整 Transcript /
         上一轮 reasoning 与 tool result 的手工拼接
```

启用原生复用与停止历史重放必须是同一变更切片。只改 Session ID、不改 Prompt 会重复注入旧历史；只改 Prompt、不恢复 Session 会丢失历史。

原生模型上下文由 Runtime 负责压缩和选择。用户查看很早的 Run 则是另一个 Reader 的责任，不能因为原生“仍能回答”就宣布历史过程已保存完整。

### 3.3 指令、上下文和模型选择

把 Prompt 组装拆为稳定扩展指令、当前用户输入、必要业务变化三部分。稳定指令在原生支持的扩展位置添加并记录版本，保留原生基础 harness。项目材料、外部文档、日志、引用和工具结果按其信任级别提供，不提升为高优先级指令。

业务变化只提交需要更新的部分，例如 Goal 状态、用户新反馈或当前工作约束；不每轮附加全组织资料。当前 Run 的工具授权由可信执行上下文传递，不让模型自己声明 Run ID 以获得权限。

稳定配置指纹排除 Run ID、时间戳、临时 Token 等每轮变化值。模型、effort 和可调整参数在原生支持时原地变更；Profile、组织、执行身份、授权范围或 Runtime 更换必须经过显式判断。Runtime 更换通常是上下文交接，不是同一原生状态无损迁移。

队列中的输入按当前已实现的模型/Agent 快照规则处理，不擅自换成“执行时随便取最新默认”。切换选中 Agent 不重定向正在执行的 Run 或它的 Stop/审批按钮。

### 3.4 中间过程与最终回答

从原生结构化事件直接生成统一事件，再投影给 UI。保留 text/commentary、允许展示的 reasoning、工具输入/结果、命令与目录、Diff、图片/附件、失败、人类请求、原生子 Agent 和扩展活动。

不要在原生路径做“结构化通知 → 假 stdout JSONL → 重新解析 → 写数据库 → 再解析”的往返。旧 parser 仅保留给真实旧执行模式或日志导入。

普通回复的完成由原生最终消息及执行终态决定，不再依赖 `RUDDER_RESULT_BEGIN/END` 或结果缺失后的额外修复推理。多个 commentary 与 final 不能被简单合成“最后一段文字就是答案”；运行失败或停止时，不能把 reasoning 或部分进展升级为成功最终回答。

Rudder 特有的 Issue 提案、业务操作、可视化结果等继续通过现有结构化工具或结果通道校验。去掉普通文本 sentinel 不代表移除结构化结果验证、用户确认或安全展示规则。现有 inline visual 的未完成片段也不能因新事件路径直接泄露到正文。

### 3.5 用户操作与 Run 关系

| 用户操作 | Run 与原生行为 | 必须避免的错误 |
|---|---|---|
| 空闲时 Send | 新 Run，继续当前绑定 | 新建无历史 Session |
| 执行中发送下一条 | Rudder 持有队列；到准入时创建新 Run | 原生与 Rudder 各发送一次 |
| Steer | 发送到当前 Run 的精确原生执行 | 被误当成新聊天回合 |
| Stop | 先保存可见截止点，再请求原生停止 | 收到 stopping 就释放全部执行责任 |
| Retry | 核对上次接受/副作用后采用正确恢复或新 Attempt | 超时后盲重发 |
| Regenerate | 从原输入之前的可验证边界分支，再提交原输入 | 把要替换的回答仍留在上下文里 |
| 编辑旧消息 | 新可见分支，旧 Run 与来源仍可检查 | 原地覆盖旧 Run 原始记录 |
| Fork / Side Chat | 从选中完成回复精确分支 | 从当前 latest head 分叉 |
| 回复提问/审批 | 回答精确原生请求，保持该 Run | 将旧历史审批变回有效请求 |
| 打开历史/刷新 | 读取和重订阅 | 重新调用模型生成历史 |

`accepted_current`、`queued_next`、`rejected_terminal`、`cancelled_by_extension`、`acceptance_unknown` 等应保留语义区别，不把所有 RPC success 当作操作已按预期生效。既有降级 Steer 可以保持其明确的继续执行语义，但不能把取消后重跑标成 native steer。

### 3.6 原生提问、审批与秘密输入

将原生请求绑定到 Connection Epoch、Binding、Run、Attempt、原生执行 ID、请求 ID 和授权人。UI 展示结构化内容，响应回到同一个原生请求。命令、文件修改、MCP 信任、计划确认、澄清、多选等都应有正确的接受、拒绝、取消和过期处理。

原生请求撤回、超时、连接失效或 Attempt 更换后，旧按钮失效。重连读取到的历史请求只作证据，只有确认仍在等待的原生请求才重新提供交互。多个页面或设备重复回答要幂等；一次允许不能变为长期允许。

Hermes 的 sudo/secret 等输入不进入 Transcript、产品消息、事件缓存、导出或遥测正文。仅保存不含秘密的操作状态；敏感值走经过授权的瞬时通道。

### 3.7 原生命令与原生环境

盘点原生聊天的 commands/slash、工具、Memory、Skills、插件、附件、子 Agent 控制及原生配置变更。展示层提供对应能力，不把 slash 当普通用户文字发给模型模拟执行。区分纯 UI 命令、元数据命令、影响后续配置的命令和真正会调用模型/工具的命令；后者进入预算、审批和 Run 归属。

有原生自主 Goal/自动继续机制时，不允许它与 Rudder 队列形成两个未协调的执行者。明确由谁接纳后续输入，原生自动执行必须被计费、受预算和取消控制，不能成为脱离 Run 的隐形任务。

## 4. 主线 B：Agent Run 的数据模型与执行契约

### 4.1 复用已有结构，增加必要的原生定位

现有 `heartbeat_runs` 是兼容持久化表名，本次不要求全库改名。复用 Run、Generation、Attempt、租约、控制命令、审批、费用、终态效果和资源管理结构。以下是需要表达的逻辑数据；已有等价结构则扩展，不重复建表。

| 逻辑结构 | 必须表达的内容 |
|---|---|
| Runtime Binding | 组织、访问主体、Agent、Runtime、Host、Profile、Workspace、稳定配置版本、连续性模式、父分支与来源边界、当前 Segment |
| Native Segment | Binding 关联、具体原生标识、可选根会话标识、服务端资源定位、原生格式/版本、分支叶子、前驱与转换原因 |
| Run Span | Run、Attempt、Segment、区间选择器、序号、原生执行/输入关联、主/继续/子执行关系、状态、完整性、停止截止点、必要对象引用 |
| 保留引用 | 哪个 Conversation/Run/批注/后代仍需要哪些原生资源、用途、生命周期版本及清理条件 |
| 历史来源别名 | 复制展示的消息对应的只读来源、精确范围、内容摘要、授权依据；不复制运行控制权 |

Binding 跨多轮；Segment 处理物理标识变化和原生分支树；Span 处理一次 Run 的精准归属。不能把三个概念重新压成一个含混的 sessionId。进程连接与 Host 在线状态另行观察：Host offline 不意味着 Session deleted。

### 4.2 核心字段建议

```ts
// Proposed Rudder contracts; these are not provider API schemas.
interface RuntimeBinding {
  id: string;
  orgId: string;
  principalScopeRef: string;
  agentId: string;
  runtimeType: string;
  hostId: string;
  profileId: string;
  workspaceBindingId: string | null;
  instructionsRevision: string;
  capabilityRevision: string;
  continuity: "native" | "context_handoff" | "legacy";
  parentBindingId: string | null;
  sourceBoundaryRef: string | null;
  currentSegmentId: string | null;
}

interface RunRuntimeSpan {
  id: string;
  orgId: string;
  runId: string;
  attemptRef: string;
  segmentId: string;
  ordinal: number;
  relation: "primary" | "continuation" | "native_subagent";
  nativeExecutionRef: string | null;
  inputCorrelationRef: string | null;
  selector: NativeSpanSelector;
  sourceRevision: string | null;
  state: "open" | "sealed" | "unresolved";
  completeness: "complete" | "partial" | "terminal_only" | "unknown";
  visibilityCutoffRef: string | null;
  supplementalObjectRef: string | null;
}

type NativeSpanSelector =
  | { kind: "codex_turn"; threadId: string; turnId: string }
  | { kind: "claude_chain"; sessionId: string;
      startExclusiveUuid: string | null; throughInclusiveUuid: string | null;
      ancestryRevision: string }
  | { kind: "hermes_execution"; sessionRef: string;
      providerExecutionRef: string; sourceRangeRef: string | null }
  | { kind: "opencode_input"; sessionId: string; userMessageId: string;
      terminalMessageIds: string[] }
  | { kind: "pi_branch_range"; sessionResourceRef: string;
      fromExclusive: string | null; throughInclusive: string | null;
      leafId: string | null }
  | { kind: "cursor_execution"; sessionId: string;
      executionRef: string; nativeRangeRef: string | null };
```

这些 selector 是 Driver 必须提供的内部归属，不意味着每个 Runtime 原样返回这些字段。未解析的范围可以暂时为空，但不能据此启用只读引用模式。没有稳定原生区间时，将该次执行的完整可展示记录保存为明确的对象补充，不用时间窗口猜归属。

所有跨对象关联校验同组织与权限。索引覆盖 Run→Span、Binding→Segment、待恢复执行和可清理资源。存在同一原生文件包含多条叶子分支的情况，唯一性与锁必须包括分支语义，不能仅凭 nativeId 做错误去重；若写同一物理文件需要额外串行，则在 Host 按物理资源加锁。

公开 DTO 不返回可任意访问的本地路径、凭证、原始环境变量或无限制 Profile 定位。浏览器提交内部受限引用，服务器/Host 负责解析。

### 4.3 历史 Run 不随会话增长

Run 完成后封闭它的来源范围。继续 R2、R3 不能让 R1 的 Transcript 变长。压缩或原生重写后仍通过保留的来源版本、原生片段或对象补充恢复原范围。

Fork 可能重写消息 ID，Driver 返回可验证的来源到子分支映射。复制消息可有新的产品消息 ID，但原来的费用、Run 和审批属于来源执行，不能转移。

原生子 Agent 的历史必须关联到实际父工具调用、执行与范围。迟到的子结果作为附属来源/后续证据记录，不重开已完成父 Run，不把子线程后续所有工作都算给父 Run。对已明确授权的原生后台工作保留控制、预算与清理责任，不能因主页面关闭就遗失。

### 4.4 统一提交接口

```ts
// Build on the existing AgentRunOrigin and input/asset types.
type SessionIntent =
  | { mode: "create" }
  | { mode: "continue"; bindingId: string }
  | { mode: "branch"; sourceBindingId: string; boundary: NativeBoundary }
  | { mode: "context_handoff"; sourceRef: string };

interface NativeRunSubmission {
  origin: AgentRunOrigin;
  agentId: string;
  operationId: string;
  session: SessionIntent;
  newInput: RuntimeInput[];
  contextDelta: RuntimeContextDelta[];
}
```

原生提交类型不接收 `messages[]` 或 `transcript[]`。旧历史重建保持单独的兼容类型，不通过一个可选参数暗中进入原生路径。

Chat、Side Chat、Issue、Review、Automation、Heartbeat 都在业务校验后调用相同入口；它们通过 session policy 选择新建、继续或分支，但不各自 spawn Runtime。以 Agent 最近 Session 为全局默认会让任务 B 劫持聊天 A，禁止这种实现。

### 4.5 Driver 操作与能力

Driver 在现有 runtime-utils/Adapter 公共边界扩展。必须能表达 probe、创建/恢复、提交、核对执行、控制、回答人类请求、读取 Run 区间、读取会话历史、按边界分支、检查保留与释放资源。具体协议及第三方类型留在对应 Adapter。

```text
probe(profile)                  → 版本、传输与独立能力证据
ensureSession(intent)           → 绑定就绪事件；不假装已开始执行
submit(binding, newInput)       → 派发/接受状态 + 原生执行关联
inspectExecution(attempt)      → 当前状态与可恢复证据
control(target, operation)      → native/queued/rejected/unknown 等语义
respondToRequest(request, ...)  → 精确原生人类请求响应
readSpan(selector, cursor)      → 该次执行的来源页
readConversation(binding, ...) → 授权后的会话视图
branchAt(boundary)              → 实际达到的边界、身份映射、连续性等级
inspectRetention / release     → 资源依赖和可安全释放条件
```

能力逐项记录 documented/observed/verified/unsupported/unknown，关联 Runtime 版本、Adapter 版本、传输、Profile/存储配置和验证用例。至少分开：原生续聊、精确历史、重启持久化、压缩历史、完成助手边界 Fork、编辑用户边界、Steer、Stop、提问、审批、原生命令、插件交互、子 Agent、清理/导出和费用归属。不能用一个 `supportsSessions=true` 开启所有能力。

## 5. Run 执行、并发、恢复与进程管理

### 5.1 一次新 Run 的可靠顺序

```text
1. 验证操作人、场景状态、附件与输入；按 operationId 去重
2. 保存输入意图与 Run；沿用现有排队、预算和准入规则
3. 建立/领取 Attempt，取得 Binding 和必要物理资源的写入权
4. 准备授权 Profile、Workspace、工具与凭证
5. 创建或恢复精确原生状态；尽早提交 Binding/Segment
6. 保存派发意图，调用原生输入接口
7. 收到接受/初始化信息后立即关联原生执行与 Run Span
8. 转发类型化事件，控制可见输出与人类请求
9. 原生真正结束后核对状态、使用量、来源范围和持久化
10. 用既有 terminal-effects 机制完成产品结果、通知和清理责任
```

区分“提交已接受”“正在执行”“等待人类”“正在停止”“执行终止”“业务终态待提交”。这些首先映射到已有状态字段和子状态，不随意发明一个新的平行 Run 状态机。

启动失败、初始化失败、模型中途失败、取消、超时、连接断开、原生历史不可读分别处理。发现历史存储问题不允许伪造模型成功，也不应丢掉已经完成的业务结果；Run outcome 与历史 availability/completeness 分开表达。

### 5.2 幂等与接受状态未知

`operationId` 在 Rudder 中唯一地标识一次用户提交，但不自动等于 provider 幂等键。对支持原生幂等的接口，使用其正式请求字段/头并验证作用域、冲突与有效期；对仅支持请求关联的接口，不能把 correlation ID 当作去重保证。

连接可能在“Runtime 已执行，Rudder 尚未收到确认”时中断。将提交标记为 `acceptance_unknown`，通过原生执行状态、原输入标识或原生幂等重放核对。不能直接生成新 key 再执行。原生幂等保留期过后，仍然未知的操作不会自动变得可安全重发。

创建 Session/Fork 也存在相同跨边界问题。先有可恢复创建意图，原生创建成功但数据库提交失败时追认结果或安全清理孤儿，不无上限反复创建。若无法证实副作用状态，明确展示阻塞点，允许用户作出知情决策。

### 5.3 单写入者与控制 fencing

复用已有 Run/Attempt ownership，在 Binding 和共享物理原生资源层补齐写入互斥。互斥必须覆盖所有场景，而不是只锁 Chat 的 generation。错误共享 fixed session key、按 Agent 全局复用 Session、或让多个 Driver 实例随意同时恢复同一 Session 都要阻止。

租约必须包含执行 owner/epoch，控制目标携带期望 Run、Attempt/Generation、Binding 和原生执行标识。旧页面的 Stop、迟到的 Steer 或旧 worker 的终态不能操作新执行。数据库租约到期不等于旧 Runtime 已停止；接管前确认旧执行者已被 fence 或安全退出。

用户另外开原生 CLI 直接写同一 Session 时，仅 Rudder 数据库锁无法保护。优先使用原生支持的单写入/共享服务机制；否则借用用户 Session 时必须采用显式控制权交接、只读观察或检测冲突后阻止并发写入。不要假装一个进程内 mutex 能阻止外部 CLI。

### 5.4 排队与 Run 完成边界

默认由 Rudder 持有未来用户消息，准入后每条成为自己的 Run。Steer 是当前 Run 的输入补充。只有能把原生队列里的每条实际输入映射到既有 Run 时，才可以委托原生队列，不能由两个队列重复投递。

原生自动重试、工具循环、压缩后继续，通常属于当前 Run/Attempt 的执行过程；原生低层 turn_end 不必等于一次产品回答结束。原生 follow-up 队列若由 Runtime 自动 drain，也不能把不同用户提交的结果和费用都合并到第一个 Run。

完成判断由各 Driver 证明：原输入对应的执行已结束、不会再自动重试该输入、必要终态已记录、使用量已对齐。不要用“几秒没有收到 token”判断结束。

### 5.5 使用量与预算

每个 Run 记录请求模型与实际服务模型；费用依据实际服务模型和原生可验证使用量。原生累计计数需要按因果范围或可靠检查点计算增量，不能每一轮再次计入整个 Session 总成本。Fork 复制的历史不收费；失败 Attempt 和实际发生的重试按真实消耗处理。

对子 Agent 使用量明确原生父计数是否已经包含子消耗；包含时不再额外相加，不包含时通过已确认子关系聚合。延迟到达的费用作为更正/附属统计，不凭空把父 Run 从 completed 改回 running。

预算 hard-stop、组织自动暂停、取消升级沿用原规则。停止请求已被接受但执行仍在进行时，执行责任和必要并发占用不能提前丢失。

### 5.6 进程常驻与按 Run 凭证

会话持久化与进程常驻独立交付。Codex/Claude 可以先按轮启动、正确显式 resume；Hermes/OpenCode/Pi 等交互 Host 可以复用进程，但不能让浏览器连接寿命决定执行寿命。

现有实现中的 `RUDDER_RUN_ID`、临时 API Key 或 MCP Token 若来自某个 Run，常驻进程不能在后续轮次继续用第一轮身份。可信 Host 将原生执行关联到当前已授权 Attempt，按请求解析工具权限，或使用隔离的按 Run 通道；禁止多并发共享一个可变的全局 currentRunId。

Host 设置活跃/空闲上限、连接回收和资源限额。回收空闲进程不删除会话。浏览器刷新、Side Chat Keep、临时网络断开不启动第二个会话。若 Runtime 自带 orphan timeout，保持 Host 连接并做版本化重连，不通过关闭全局安全超时解决。

## 6. Side Chat 专项：保留 Rudder 自己的产品语义

### 6.1 现有行为的保护基线

此前审计中的 Side Chat 由 `server/src/services/side-chats.ts` 管理，包含两小时有效窗口、创建者校验、已完成助手消息锚定、隐藏状态以及原地 `keepInMessenger`。后续会话家族分组修订覆盖了更早文档的分组段落。实施时以当前服务、相关调用方和测试为准，保留标题快照、model/effort override 处理、分组、失败保留和 UI 切换细节。

需要先跑 characterization tests，明确哪些实际持久化消息会触发 touch、过期发生时在途 Run 如何处理、关闭的清理顺序以及 Keep 的权限。不能只见到一个 touch 函数就猜测所有事件都会延长 TTL，也不能把普通 Chat 的生命周期从 Side Chat 规则推导出来。

### 6.2 四个寿命必须解耦

| 寿命 | 结束意味着什么 | 不意味着什么 |
|---|---|---|
| Side Panel tab | 用户不再打开该视图；临时关闭沿用销毁行为 | 所有同 Agent 的执行都应停止 |
| Side Chat 可发送窗口 | 超期后不得再接纳新输入 | 立即删除已有历史或取消所有原生状态 |
| Agent Run | 本次执行结束或中断 | 连续聊天结束 |
| 原生资源保留 | 满足明确条件后可清理 | TTL 一到就可以无条件删掉资源 |

临时 Side Chat 从首次 Send 开始使用可持久化、可恢复的原生存储。禁止因 temporary 标签启用 ephemeral、no-session、仅内存 Session。Rudder 的临时产品状态通过保留策略实现，不通过不保存底层历史实现。

### 6.3 首次 Send 与精确分支

打开 `/side`、助手回复的 Side Chat 动作或空面板入口，只产生本地 provisional draft，不创建原生 Session、Run 或模型请求。首次发送时，按组织、创建者、sourceConversation、sourceMessage、选中回答变体、Agent 与 clientMutationId 进行幂等创建。

在产品事务中建立隐藏 Conversation、现有消息/批注/附件副本、创建意图及来源保留。冻结所选完成助手的来源边界，随后执行原生分支并记录子身份，再派发第一条新输入。首次消息重试不能重复 Fork 或重复执行。

父 Chat 可能正在执行更晚的一轮。分支只能包含选中来源的历史前缀，不能包含后来追加的内容。不能先把父会话回滚到旧位置再 Fork；不能把前一个用户消息当成助手完成边界，遗漏用户选中的回复。

当选中回复只有停止可见前缀，而原生已经存了用户没看到的尾部时，必须选择与可见边界一致的原生分支；做不到就使用明确的可见上下文交接，不能暗中把隐藏尾部送进新会话。

同 Runtime、同授权且支持精确边界时走原生分支。不同 Runtime、较低权限、旧历史来源等不兼容情况，使用明确的 context_handoff，只导入获准的可见材料，后续继续使用新原生会话。它不等于无损原生 Fork。原生扩展拒绝操作时，不自动换交接路径绕过拒绝。

### 6.4 Move to Messenger：原地晋升

Keep 必须保留同一个 Conversation ID、Binding 与已有 Run，不触发原生 Fork、Session create、重新发送用户输入或重启正在运行的 Agent。

```text
进入现有 Keep 事务
  → 锁定并重新验证创建者、Side Chat 状态和期限
  → 已 kept 则幂等返回；已过期则按现有规则拒绝
  → 验证当前产品要求的来源可用性
  → 更新 kept / messengerVisible / expiry / keptAt 等现有字段
  → 沿用当前会话家族分组规则
  → 将资源保留引用升级为长期，递增清理版本
  → 提交
UI 关闭原侧边 tab，打开相同 Conversation 的普通 Chat
```

事务中不依赖新的原生 pin/Fork/复制 RPC。Host 离线时，满足原有来源与生命周期条件仍可晋升元数据；原生字节若已丢失，要明确提示，Keep 不能修复缺失数据。

正在流式生成或等待审批时 Keep，原 Run、原请求、原输入队列和当前正文继续有效。原生初始化尚未完成时，保留引用先附着到创建意图，后续资源继承长期保留。原生自身可能并发压缩，记录其 Segment 变化即可；禁止的是 Keep 导致重建，不是禁止 Runtime 自己演化。

失败时保留侧边窗口、草稿和附件，显示实际可重试错误。重复 Keep 不创建重复分组或活动。来源删除、期限竞争等继续按现有产品规则处理，不因存储重构顺便改语义。

### 6.5 过期、touch 与在途执行

使用服务器时间判断窗口。保留现有两小时常量和经过测试确认的刷新触发点。token、工具进度、轮询、页面读取、历史恢复、标题读取不能新增为 touch 来源。

在期限内被接纳的 Run 于期限后结束，按原有在途执行规则完成；队列里尚未接纳的新输入必须重新检查。迟到回调不能复活已提交 expired/deleted 的 Conversation。原生 SSE 缓冲过期或进程空闲退出与产品过期无关。

### 6.6 关闭、销毁与安全清理

关闭 provisional draft 只丢弃草稿。关闭隐藏临时 Side Chat 沿用销毁语义，但先保存可恢复的受限清理意图，阻止新准入并停止它自己的在途执行。不要停止父 Chat、兄弟 Side Chat 或同 Agent 的其他任务。

即使产品行按现有行为先删除，仍保留取消/核对所需的最小引用。收到 stopping 不代表执行停止；在实际终态前不能删执行仍需要的文件。清理应能跨 Rudder 重启继续。

释放当前 Chat 的保留引用后，检查 Run 证据、后代、批注、复制来源和原生删除级联。只有无活跃执行、无有效保留引用且版本匹配的资源才可物理删除。不要以“所有 Run 永久保留原始日志”把临时数据永远钉住；临时 Run 的原始证据按现有临时策略释放，必要审计仅保留受限元数据。

Keep 与 Close 竞争时必须有明确事务赢家。已成功 Keep 后，迟到 Close 和旧 GC 均不得删除数据；Close 已提交后 Keep 按现有错误处理。GC 再次读取 owner/epoch，而不是信任早先扫描结果或可失真的缓存引用计数。

原生删除可能级联到子线程，或后代仍依赖父历史。必要时先用合法原生手段独立保留被引用资源；无法安全分离就延迟物理删除并如实记录，不能宣称已经擦除。关闭聊天也不回滚真实文件修改、工具已发送的消息或已经形成的长期记忆。

### 6.7 复制历史、权限与父子隔离

保留现有复制消息和附件的产品 ID 语义。需要展示来源 Process 时加只读来源别名，不重新填回源 Run/approval/chatTurn 控制字段。源消息重映射、批注附件归属、选择范围摘要都必须校验。

Side Chat 创建者限制覆盖列表、按 ID 读取、Run Detail、Reader、文件详情、导出、查询缓存以及原生会话搜索。其他用户知道原生 Session ID 不能绕过权限。原生 Memory/session_search 跨主体共享时，通过授权 Profile 和存储隔离解决，不靠静默禁用 Hermes Memory 保住表面隐私。

同一创建者既有授权原生环境的复用可保留；跨主体的权限不能因 parent shared 而扩大。若来源要删除而复制内容按产品语义应保留，先保留独立授权来源或快照。权限撤销与已有副本的政策由既有产品约束决定，不能让 read alias 绕过它。

## 7. Transcript Reader：用户仍然能看，底层不重复存

### 7.1 统一读取路径

```text
请求 runId
  → 校验组织、操作人和 Run 可见性
  → 查该 Run 的 Span 描述
  → 校验来源别名、停止截止点和允许字段
  → 定位 Host / Profile / 原生资源
  → Driver 按稳定来源范围读取
  → 规范化为统一 Transcript item
  → 分页返回及订阅后续状态
```

Run Reader 只授权该 Run 的范围，不能凭一个 runId 读取整个 Session。Conversation Reader 独立聚合其授权历史，来源 Run 保持原始归属；不会把父会话后续消息混进子会话。

原生 API 优先，受版本约束的只读 Host 格式 Reader 次之，必要的对象/旧日志 Reader 作为明确策略。业务服务和浏览器不直接解析 Runtime 私有数据库。直接读取原生文件时必须支持源格式版本、截断/部分写入、并发追加和索引失效检测，禁止随意编辑原生文件。

### 7.2 建议返回契约

```ts
interface TranscriptPage {
  items: TranscriptItem[];
  nextCursor: string | null;
  source: "native" | "native_plus_objects" | "legacy";
  revision: string;
  availability: "available" | "offline" | "missing" | "expired" | "incompatible";
  completeness: "complete" | "partial" | "terminal_only" | "unknown";
}
```

未加载由客户端状态表达；加载成功的空列表与 offline/missing 分开。无权限使用现有安全错误，不泄露目标是否存在。来源版本不兼容不能显示成空历史；旧 Run 也不能在协议升级后悄悄读新分支。

分页游标绑定组织/主体、Run 或 Conversation scope、来源版本、选择器和读策略；不能复用到另一段历史。不要用 UI 数组下标或时间戳作权威定位。首屏、滚动、打开单个工具详情和刷新只加载各自需要的范围。

可从每页 50 个 item、约 256 KiB 可见正文和单次约 2 MiB 的详情块开始测量并调整，属于实现初始限额而非既有产品指标。超出范围要提供继续加载或受限对象引用，不把永久截断伪装成完整内容。

### 7.3 原生模型恢复历史与完整历史分开

Runtime 可以在模型恢复视图里把旧内容替换为摘要，但用户仍需要原来 Run 的工具结果。每种 Driver 必须证明完整历史 Reader 能读取压缩前记录及正确祖先分支。便利的 get messages 接口不天然满足此条件。

重写 source ID、分支切换、原生压缩、子会话追加都通过已封闭的 Span 和版本定位。无法还原的原生可见信息由明确对象补充保留，或报告历史 partial；不能宣称无损，也不能伪造 provider-private reasoning。

### 7.4 实时流、重连和背压

保留有上限的 Host/服务端环形缓冲，标记 Connection Epoch、原生执行、Item 和局部事件序号。token 级增量默认不永久写 SQL。小状态、控制回执和终态仍需持久化。

连接正常时流式更新；短断线从缓冲补缺。缓冲已失效时，先建立订阅/暂存新事件，读取原生快照，再按稳定 Item 身份和版本合并补齐，避免快照读取与订阅之间丢事件或重复正文。过期游标返回 reset/reconcile 信号，不能当成无需更新。

同一个 Item 的 delta 与后续完整快照是更新关系，不是两条新消息。reasoning summary 与同一 item 的其他展示流按已验证策略选择一个，防止重复展示。原生只提供临时 token 的场景，恢复承诺是恢复持久化结果和状态，不承诺每个瞬时通知永久可回放。

慢客户端不能使内存无限增长或阻塞 Stop/审批。可合并正文更新、要求重新读取、丢弃可恢复增量；不可丢弃尚未处理的人类控制请求。SSE 正确解析多行 data，JSON-LF 正确处理跨块 UTF-8 与字符串内 Unicode 行分隔符；设置帧大小上限，超过时走受限详情/显式错误。

### 7.5 停止截止点与批注

保存用户 Stop 被接受时的可见前缀和来源版本。原生后续尾部可保留为有权限的诊断，但不能刷新后进入正常最终答案。仅存一个 hash 无法恢复被原生覆写的前缀，必要时保存小型精确 Stop 快照。

批注记录产品源消息、Run/Span、原生 Item、文本范围和摘要，服务端重新读取来源校验。用户主动引用的短文本属于反馈本身，可以持久化；无需为一句引用保留整份额外 Transcript。复制/Fork 时同步来源 ID 和附件引用。历史审批只读，不能因用户选中旧 Process 获得执行权。

### 7.6 文件、附件、学习与所有消费者

命令目录、文件路径、技能身份和 Diff 来自结构化原生证据。文件预览继续通过授权 Workspace/资产解析，不从渲染文字猜路径。云端服务不能直接打开另一台 Runtime Host 的绝对路径；对附件建立可在目标 Host 使用的已授权引用，保持媒体类型，不强行把图片全部变成文本描述。

主 Chat、Side Chat、Run Detail、Run Feedback、批注、Debug、学习/Skill 优化、导出和历史摘要全部迁移到共同 Reader。学习读取遵循范围、保留与权限，不为省事重新复制完整 Transcript 到知识库。搜索保留现有产品消息和必要索引；原始工具输出若需搜索，走授权 Host/对象索引，不能暗中在主数据库重建全量原始历史。

## 8. 六种 Runtime 的实际适配方案

每条适配都要完成原生继续执行、完整历史读取、Run 区间、交互控制、Side Chat 分支/晋升和重启恢复。现有 package、配置键、认证入口与用户模型选择尽量兼容。不要仅为符合文档例子擅自替换二进制、全局升级或切换模型。

### 8.1 Codex：App Server 原生 Thread/Turn

**协议依据。**官方 App Server 暴露 Thread/Turn、历史读取、Fork 与控制。具体 `thread.id` 与根 `sessionId` 分开；`thread/fork` 的 `lastTurnId` 表达包含该完成 Turn 的边界。分页方法有实验性和存储实现限制，应按安装版本验证。[S1]

**改动入口。**从 `packages/agent-runtimes/codex-local/src/server/app-server-chat.ts`、App Server client、`execute.ts` 及测试接入。把会话/控制/历史映射拆为同 package 的小模块，不能把所有实现继续堆进已有大文件。

**创建与提交。**完成 initialize/initialized，启动持久化 thread 或用明确 thread ID resume。早发 sessionBound，再提交仅含新增输入的 `turn/start`，尽早绑定 turn ID。保留受管理 CODEX_HOME、Workspace、模型/effort 和现有审批策略。普通回复直接使用原生终态，不执行 sentinel repair。

**控制。**使用 `turn/steer` 并带 expectedTurnId，Stop 用 `turn/interrupt`。原生 requestUserInput、命令审批、文件审批和其他需要回复的请求通过共享人类请求层往返。保持接受未知与回合已关闭的区别。

**读取。**用已支持的 `thread/read` 读取原生历史；只有实际验证后才用 `thread/turns/list`、`thread/items/list`。不要启用仅能列 summary、却不能完整读取或 resume 的存储模式。单 Run 的范围以具体 turn ID 为准；大量历史需要 Host 受控读取和可重建索引。

**Side Chat。**指定选中的已完成 Turn 进行原生 Fork。保留子 Thread 和根会话标识，避免操作父 Thread。临时 Side Chat 也持久化。删除前检查 spawned descendant 级联和后代保留引用，Keep 不调用原生 Fork/delete/pin 作为事务前置条件。

**必须实测。**超过 12 条消息的续聊、工具信息仅存在于工具结果的追问、Rudder 与 Adapter 重启、完整工具详情、提问与拒绝、精确分支、停止截止点、丢 Session 不静默新建、子资源安全清理。

### 8.2 Claude Code：SDK/控制协议与完整原生历史

**协议依据。**当前官方支持指定 Session ID 恢复及 Fork；目录最近会话与明确 ID 恢复语义不同。SessionStore 路径的 getSessionMessages 可能仅是压缩后的模型恢复链；原始条目、Fork 身份映射、镜像完整性和文件 checkpointing 要单独处理。[S2][S3]

**改动入口。**保留 `claude-local`。优先采用当前受支持的 Agent SDK streaming/query/control，或与已安装 CLI 相匹配的正式控制协议。不基于已移除的实验 SDK 接口新建实现，SDK 与实际可执行文件版本要匹配。

**创建与提交。**从 init 事件尽早捕获原生 Session ID，后续显式 resume。禁止 concurrent Chats 使用目录级 continue/latest。保持原生 Code preset，并以增量方式添加 Rudder 指令；核对 CLAUDE.md、settings sources、Skill、插件、MCP、权限与项目根是否与授权原生环境一致，不能假设 SDK 默认与 CLI 默认相同。

**控制。**通过 live query/control 传递中断、权限与 AskUserQuestion 等请求。区分 SDK 接受新输入是即时指导还是后续排队，不给 queued 行为标 native steer。多选、拒绝、等待和取消均要测试。

**读取。**用户查看旧 Run 采用版本化原生 JSONL/SDK raw entries Reader，按照 UUID/parent chain 与封闭区间过滤。模型恢复链与完整历史 Reader 分开。Fork 重写 ID 时，建立原生来源映射，不继续用父 UUID 查询子历史。

**Side Chat。**有支持精确边界的原生无推理 Fork helper 时优先使用。只支持 fork-on-query 的版本，将首次真实输入与创建过程统一管理，保存创建意图与接受状态，禁止空 dummy prompt。助手锚点必须由安装版本的原生 API/合法 helper 达到，不手拼不同 Session 文件。

**保留与云端。**先使用原生持久卷。若接入 SessionStore/对象镜像，验证镜像失败、重复 UUID、子 Agent 子键和恢复完整性；mirror error 不能当备份成功。现有文件 checkpointing 开启时，不启用不兼容组合或悄悄关闭检查点。保留还需覆盖原生 cleanup 策略，不能擅改借用的用户全局配置。

**必须实测。**显式恢复、压缩前历史、Fork ID 重写、原生配置与交互、checkpoint 行为、镜像中断与子会话恢复。镜像是可选部署能力，但采用该路径时其测试是硬门槛。

### 8.3 Hermes：原生产品交互是一等交付

**依据边界。**此前 Rudder Adapter 审计显示已经使用 Session/Run HTTP，但还存在合成工具上下文和按 Run 派生的 workstream key。此前上游固定源码记录了原生 Session-backed Runs 和更完整的请求语义；原生 TUI 使用其产品 Gateway。[R-HERMES][H-API][H-TUI] 渲染文档与固定源码的版本/缓存存在差异，不能把任一文档的去重有效期、恢复或 Fork 能力写死为所有安装版本的事实。

**保留一个用户可理解的 Hermes Runtime。**继续使用 `hermes_gateway`，内部按配置与能力选择两种明确后端。`native_product_rpc` 用于本地完整产品交互，受管理 Host 在已授权 Profile 下连接/启动已安装 Hermes 产品 Gateway；`native_runs_http` 用于远程原生 Session-backed Runs。不是两个互不相干的 Agent 类型，更不是运行时遇错悄悄换后端。

**产品 RPC 路径。**检查安装源码的 method registry/contracts 与原生 UI 调用方式，复用它实际使用的创建/恢复、提交、session.branch/compress/interrupt、slash/command 等方法。`python -m tui_gateway.entry` 是此前源代码中的入口线索，执行前验证可用性。需要额外精确历史或边界能力时，在 Rudder Host 写小型、版本化、可测试的原生集成 helper，不虚构一个官方 RPC 名。

**原生交互。**把 approval、clarify、sudo、secret 当需要同 ID 响应的 server request，而非单向通知。支持请求取消、一次/会话/长期授权作用域，敏感值不入日志。普通 busy 输入进入单一队列，Steer 作用于当前执行，Stop 反映真实终态。保留原生模型选择、媒体输入、命令、插件、工具、Memory、Skills、Todo、子 Agent list/tail/steer/stop 和输出附件的等价交互。

**HTTP 路径。**探测 `/v1/capabilities`、认证 Profile 与可用接口。用 `/api/sessions` 创建/读取明确会话；已验证支持原生历史加载时，`/v1/runs` 仅传当前 input、session_id 与必要增量 instructions，不再附 conversation_history、previous_response_id 或 Rudder 合成工具上下文来冒充原生恢复。默认 workstream/memory key 绑定逻辑 Conversation/Profile/主体，不再每轮使用新的 Run key，也不能用跨主体全局 fixed key。

正式幂等能力以安装协议为准；支持 `Idempotency-Key` header 时使用该头，不把 JSON `idempotency_key` 当等价物。持久化 Rudder 操作映射，验证同 key 同 payload、冲突 payload、重启和原生去重窗口过期。旧源码与渲染文档对保留期的描述不一致，所以测试实际契约，不能把未知失败自动重发。[H-API][S4]

**状态与完整工具过程。**使用声明可用的 run status、events、stop 和 approval 端点。SSE 的工具 preview 不代表完整工具结果；完整详情从原生 SessionDB/产品历史 Reader 获取，缺项以明确对象补充保留。显示实际 provider/model 结果，区分用户请求的模型与实际服务模型。

**只有一个后端拥有在途执行。**不能通过 HTTP 启动 AIAgent，然后用另一个独立 TUI 进程试图 Steer 它。后端切换只在安全终态且持久化状态兼容时显式进行。HTTP 缺少完整产品提问/Steer 时应补原生产品桥接，不以正常文字请求成功作为整个 Hermes 完成。

**压缩、子 Agent 与保留。**遵循原生逻辑 Session 到压缩后继的解析机制，保留旧 Run 区间，不每次轮询替换所有旧 ID。后台子结果在主 SSE 结束后到达时，保存因果关系，下一真实用户回合从原生历史获得结果；不无授权启动新模型轮次，不重新打开父 Run 或重复计费。

**Side Chat。**原生有 Fork 不等于支持任意助手锚点。校准具体 payload 和包含边界；无法通过外部接口实现时使用同原生 SessionDB/产品服务的版本化分支 helper，不能分 latest head 冒充所选历史。保留 Memory、Skills 的权限与原生裁剪策略；长期 Keep 的资源引用覆盖整个压缩/子会话依赖。

**必须实测。**在同一授权 Profile 下对照原生 Hermes 产品：多轮工具信息连续性、重启、压缩、工具完整详情、审批/澄清/secret、输入排队/Steer、子 Agent、精确分支、Side Chat 原地 Keep、离线晋升、原生自动裁剪后的保留保证。不能只提交一份 HTTP adapter 单测。

### 8.4 OpenCode：受管理原生 Server

**协议依据。**OpenCode 官方提供原生 Server/OpenAPI、Session、Message/Part、事件、异步提交、Fork、Abort 和命令接口；异步 prompt 的 204 是接受语义而非完成。[S5]

**改动入口。**在 `opencode-local` 拆分 server lifecycle、API client、Session mapping 与 Transcript projection。启动或连接明确归属的原生 Server，默认 loopback 并认证，远程通过受保护 Host relay。不能连接熟悉端口上任意一个其他用户的 server。

**创建与输入。**从安装实例 `/doc` 或等价 schema 校准字段，提交当前 input parts 到相应 Session。保留原生 config/providers/agents/plugins/MCP；现有 `--pure` 对加载行为的影响必须核对，不盲保留或盲删除。媒体/附件使用原生部分类型，不展平成字符串。

**Run 边界与状态。**记录用户 message ID、因果 assistant messages、parts 与终态。原生允许 client message ID 不等于保证持久化幂等，需要测试。共享流的 session idle 不能单独证明某条输入完成；必须关联该 Run 的原生消息和结果。

**交互与读取。**按当前 schema 回答 permission/question，处理工具结果和文件 Diff。历史 Reader 按 message/part 范围读取，SSE 按实例/Profile/Session 隔离，正确处理多行 data 与断线恢复。原生命令通过 command API，终态核对后完成 Run。

**Side Chat。**检查 `/session/{id}/fork` 的 messageID 是含/不含边界、是否完整包含选中助手及关联工具链。达不到完成助手前缀时，补原生 Session 服务级 helper，不能用前一个用户消息替代。不能用 revert/文件回滚实现聊天分支。

**必须实测。**三轮以上连续对话、精确消息 Fork、提问/权限/命令、204 后断线接受状态、共享 SSE 串流隔离、完整详情及重启历史。

### 8.5 Pi：原生 RPC 与会话树

**协议依据。**Pi RPC 区分低层 agent_end 与完整 settled，支持提问/扩展 UI、Steer、follow-up 及会话条目读取。其常规 fork 面向历史用户消息，clone 可复制当前分支；扩展可取消 Fork。SessionManager 的分支提取能力与高层扩展生命周期需配合。[S6][S7]

**改动入口。**在 `pi-local` 使用 `pi --mode rpc` 或同等受支持 SDK Host，明确指定原生 Session 文件/资源，保留现有 managed extensions、MCP、Skills、模型和配置。不启用 no-session，不在每轮生成无关联文件。

**输入与完成。**普通输入、原生 steer、follow_up 按单队列规则映射。输入 RPC ID 只做关联，未知接受状态不能靠重复发同一 JSON 判断去重。支持 agent_settled 的版本使用该完整结束语义；低层结束之后可能仍有重试/压缩。旧版本需要经验证的原生 idle/重试/队列核对，不用等待定时器猜结束。若委托原生 follow-up 队列，仍为每条独立用户输入维护 Run 归属。

**会话树与 Reader。**捕获原生 session header、稳定 entry ID 和当前 leaf。Run 用开始 exclusive、结束 inclusive、leaf/祖先版本定位。get_entries 可能包含被放弃的其他分支与压缩前记录，必须按祖先和执行范围过滤。get_messages 用于恢复视图，不替代完整历史。安装版本支持稳定增量 cursor 时直接利用；大量返回时在 Host 建可重建索引和受限读取。

**Side Chat 的助手边界。**禁止把助手 entryId 直接传给只接受历史用户消息的 fork。当前位置可在隔离分支上下文中使用原生 clone；较早助手边界通过安装版本支持的 SessionManager 分支提取实现，例如文档中的 createBranchedSession 能力，但同时必须经过合法高层校验/扩展事件。

不移动父会话 leaf，不截断源 JSONL，不制造假用户消息，不绕过 session_before_fork。扩展返回 cancelled=true 即取消，即使 RPC success=true；不能自动交接来绕过扩展决定。新增 helper 明确是 Rudder 集成，不虚构为标准 navigate_tree RPC。

**扩展与流。**支持选择、确认、文本输入、取消和可移植扩展卡。无法直接表现的终端自定义组件要有明确路径，不能默默忽略。JSON framing 只按协议 LF，U+2028/U+2029 和跨块 UTF-8 不作为传输断点；未完成帧内存受限。

**必须实测。**原生持久化续聊、旧助手锚点、父会话并发、扩展 veto、完整祖先历史、低层结束后重试、Unicode 和扩展 UI、增量计费不重复累计整个 Session。

### 8.6 Cursor：ACP 原生集成及真实能力缺口

**协议依据。**当前官方 ACP 文档包含 `agent acp`、会话创建/恢复、输入/更新、权限与取消。Cursor 自定义 ask_question/create_plan 是阻塞请求；任务、Todo 和图片更新是通知。文档也明确了部分 MCP 支持范围差异。[S8]

**改动入口。**保留 `cursor-local` 与认证/配置兼容，支持的安装版本采用 ACP，不把旧 print CLI 当永久能力上限。initialize/auth 后使用明确 session/new、session/load、session/prompt、session/update、session/cancel、session/request_permission，按安装协议核对字段。

**交互。**回答 Cursor 的问题和计划批准，保留 agent/plan/ask 等模式；通知通过结构化 UI 展示，不能因通知不需响应就遗漏用户所需信息。保留授权的项目/用户 MCP，并如实标注团队级等原生传输限制。

**历史和 Fork 独立验证。**session/load 能恢复不代表完整工具历史可长期读取。验证完整性、分页/受限读取和重启稳定性；只保证续聊时，继续使用原生 Session，并用对象补充保存该次执行可展示过程，不重新塞回 SQL。

不能因 ACP 允许扩展而杜撰 session/fork。探测安装版本原生精确分支与 Steer；确实没有时，Side Chat 使用显式可见上下文交接，产品生命周期仍完整保留。该兼容记录不能声称无损原生分支，也不能作为其他五种 Runtime 的降级借口。不抓取私有 IDE 数据库作为未经验证的核心契约。

**必须实测。**重启恢复、问题/计划/权限、完整历史或对象补充、Side Chat 生命周期、能力差异准确展示。老版本仍保留兼容使用，但未完成的 ACP 路径不能标全量原生通过。

## 9. 存储优化、保留与云端部署

### 9.1 数据放在哪里

| 数据 | 默认保存策略 | 原因 |
|---|---|---|
| Run/Attempt 状态、费用、来源关联 | 业务数据库，小型结构化记录 | 可靠调度、审计与业务结果 |
| Binding/Segment/Span | 数据库引用与边界 | 知道去哪读、读哪一段 |
| 用户消息与最终正文 | 一份产品消息；大附件/大产物用资产引用 | 列表、基本历史与搜索不能全依赖 Host 在线 |
| 原生完整工具/推理展示过程 | 原生持久化存储 | 避免 Rudder 重复完整保存 |
| 逐 token/逐 stdout 通知 | 有限时/限大小的临时缓冲 | 活跃流与短断线恢复 |
| 操作意图、审批决策、提交回执 | 小型持久记录 | 不重复副作用、不丢控制 |
| 用户批注/Stop 前缀 | 必要的短精确副本 | 原生重写后仍还原产品状态 |
| 原生缺失的完整可见过程 | 明确的对象/日志补充 | 保留功能，不伪装 native-only |
| 旧 Run 日志 | 保留兼容 Reader，按既有保留规则 | 非破坏迁移 |

### 9.2 所有写入路径都要审计

检查 Generation events、message transcript、Run events、原始 run log、stdout/stderr 累积、resultJson、contextSnapshot、recoveryCheckpoint、Fork 复制、学习数据、调试导出和遥测。不能只停写一个表，却在另外一个 JSON 字段继续放全量工具输出。

原始 Run 日志本来可能在独立 Log Store，因此改造前分别测 SQL 增长和独立日志增长，不把两者混淆。正文预览、错误摘要和 hash 都设合理限额；hash 不能代替需要恢复的原文。长期持有全部 stdout 大字符串也要移除，服务器与浏览器缓存均按大小/时间/数量受限。

### 9.3 启用只存引用的门槛

每个 Runtime/Profile/版本分别通过下列验证，再关闭重复写入：原生状态可持久恢复；旧 Run 完整范围可读；压缩/Fork 后边界稳定；允许展示的工具详情不只有 preview；权限和停止截止点一致；已有保留策略不会清掉永久 Chat；Host 与备份的寿命满足部署要求。

过渡模式是：`legacy` → `native_mirrored` → `native_reference`，真实缺口可用明确的 `native_plus_objects`。mirrored 只对同一次执行做临时双写和对照，不让模型跑两遍；限定验证范围并在验收后退出。长期停在 mirrored 或 feature flag 未启用，不算完成存储目标。

“原生还记得”不等于“用户完整历史还在”；缺少可展示数据时先补可靠读取/对象保存，再关闭旧副本。不得为了 native-only 标签损失功能。

### 9.4 Host 与云端边界

```text
本地：UI → Rudder → 本地 Runtime Host → 原生持久卷
云端：UI → Rudder 控制服务 → 已认证 Host 连接 → 原生持久卷
可选：原生持久卷/必要过程对象 → 受权限控制的对象归档
```

第一版 Host 是内部代码边界，可与 Rudder 同进程；不用先建完整云平台。必须把本地路径、读取、进程控制、Profile 与资源定位留在 Host 一侧，使后续远程部署不需要推翻接口。

云端业务数据库不保存完整原始 Transcript，但原生数据仍需占用可靠存储。无持久卷的临时容器不允许启用唯一原生副本模式。若采用对象恢复，验证版本、完整清单、必要 Workspace/checkpoint 依赖和子资源；模型 Session 恢复不等于文件系统恢复。

Host 离线时显示产品已保存内容和明确的原生过程不可用状态，不将不可达显示成空历史。要保证任何设备离线看完整过程，就必须另有已授权副本/归档，不可能同时要求没有任何副本。

### 9.5 保留、清理与故障

Keep 将资源 claim 变成长期保留。清理前重新检查真实引用、来源祖先、后代依赖、活跃 Run、清理 epoch 和原生删除级联。原生有自动裁剪时，受管理 Profile 配置与 claim 必须协调；借用用户 Profile 不能擅改全局保留策略。

“永久 Chat”表示无产品 TTL，不表示能够从已被用户手动删除的唯一磁盘副本恢复数据。缺失须真实显示。Mirror 上传成功提示不足以证明可恢复，必须校验完整清单/摘要，确认子文件与对象均存在后才讨论删除最后本地副本。

磁盘满、权限不足、原生库锁定、备份失败、局部写入和协议升级都要测试。容量不足时阻止不可靠的新执行或退回已经显式配置的可靠存储策略，不偷偷丢弃过程。不要每个 Run 都全量复制不断增长的整个 Session，归档应按原生增量、去重对象或受控快照完成。

## 10. API、代码落点与 TS/Rust 边界

### 10.1 保留产品 API，迁移底层实现

既有 Chat/Side Chat 发送、控制、Keep 和关闭 URL 与 UI 行为保持兼容。底层改造不要求用户切换到新页面，也不要求调用方直接提供任意 native Session ID。

新增能力优先放在现有 Agent Run facade；没有对应能力时可新增以下等价接口。这些是建议的 Rudder API，不是当前已存在路径，也不是上游 Runtime URL：

```text
POST /api/agent-runs                         提交新输入与 SessionIntent
GET  /api/agent-runs/:runId/transcript        分页读取该 Run
GET  /api/agent-runs/:runId/transcript/:itemId 受限详情读取
POST /api/agent-runs/:runId/control           带期望 Attempt 的控制
POST /api/agent-runs/:runId/requests/:id      回复有效原生人类请求
GET  /api/chats/:id/history                  授权后的会话读取投影
```

复用现有同义 endpoint 即可，不为了符合文档重复提供两套公共 API。访问任何 item 都从 Run/Conversation 重新校验权限；所有 mutation 采用既有错误格式、活动日志与幂等机制。

### 10.2 重点代码地图

| 范围 | 已知入口或目录 | 预期改变 |
|---|---|---|
| Chat 调用 | `server/src/services/chat-assistant.ts`、helpers | 场景组装调用 Run；原生输入不重放历史；移除原生普通结果 repair |
| Run 核心 | `server/src/services/runtime-kernel/`、`packages/shared/src/agent-run.ts` | 统一 SessionIntent、租约、恢复、区间和费用 |
| 数据模型 | `packages/db/src/schema/heartbeat_runs.ts`、chat schema 与迁移 | 兼容增加绑定/区间/引用，不全库改名 |
| Runtime 公共边界 | `packages/agent-runtime-utils/` 与现有 shared types | 类型化原生输入/事件/能力与 Reader |
| 六种 Adapter | `packages/agent-runtimes/{codex-local,claude-local,hermes-gateway,opencode-local,pi-local,cursor-local}` | 各自原生 transport/session/control/history |
| Side Chat | `server/src/services/side-chats.ts`、family/annotation helpers | First Send 分支、原地 Keep、保留、独立取消 |
| 控制与事件 | chats stream routes、chat-generation-protocol、run-events 等继任模块 | 状态可靠持久化；原始 delta 不重复存储 |
| UI | `ui/src/pages/Chat*`、`SideChatPanelView.tsx`、`RunTranscriptView*` | 同一语义投影、独立状态、懒加载、请求往返 |
| 原生 Rust | `native/crates/runtime-core`、`runtime-attempt-core`、`run-evidence-core` 等实际调用链 | 在已迁移权威层变更契约与桥接 |

路径来自此前审计，是导航线索；实现前按本地文件提取情况定位。目录存在不代表已经接入生产，必须追踪 Router → Service → bridge → runtime 的真实调用链。

### 10.3 与进行中的 Rust 迁移协作

已归 Rust 的状态/持久化/证据逻辑在 Rust 修改，更新公共协议及 TS 调用桥接；仍由 TypeScript 管理的 Runtime I/O 在当前层修改。禁止平行维护两套 Run 状态机，禁止只写 Rust 函数而实际入口仍运行旧逻辑。

保护工作树中其他正在进行的迁移，不覆盖、不重置、不把无关重构全部带入本 PR。涉及 schema/shared/server/ui/native 的修改同步完成，保留现有兼容读取。此项目的完成不以“全仓 Rust 迁移结束”为前提。

## 11. 执行顺序：按可验证的功能切片推进

每个工作项都包含实现、调用接线、相关测试和修复，不以添加接口或写完方案为完成。按当前仓库约定分阶段提交，保护无关工作，不直接推 main、merge 或部署。无需新增进度模板、状态 JSON、空报告目录或一整套管理脚本；真实测试、提交、PR 与必要的方案修改即可承载证据。

### W00 — 确认真实基线和原生契约

读取当前 AGENTS、工作树、分支和现有实现。追踪六种场景到执行进程的实际调用链，确认 TS/Rust 权威模块。定位所有 Session 重建、recentMessages/sentinel、Transcript 读写与 Sidebar/Side Chat 调用方。记录实际安装二进制、配置/Profile、传输、原生 schema 与历史存储位置，不更改用户凭证或全局默认。

同时验证每种 Runtime 的创建、resume、完整历史、精确助手 Fork、控制、保留和使用量证据级别。这里产物是后续代码的可靠起点和具体差异，不要求另写一堆 inventory 文件；可用本 Plan 的实现说明或 PR 记录。完成条件是知道当前生效路径及未知项，而不是列出看起来存在的目录。

### W01 — 先锁住主 Chat 与 Side Chat 现有行为

运行并补齐主/侧聊天的 characterization tests，尤其父草稿与当前 Run 不受影响、首次 Send 幂等、复制批注/附件、过期触发点、同 ID Keep、分组、关闭与权限。覆盖 Keep/expiry/close 并发，源删除失败与待审批晋升。先证明现有语义，再换底层驱动，避免将产品行为变化当成不可避免的重构副作用。

主要落点是 `side-chats.ts`、主 Chat 与 `SideChatPanelView` 相关服务/UI 测试和 `tests/e2e/chat-side-chat.spec.ts` 等当前继任套件。完成条件：明确基线与失败路径；不能用小规模纯 mock 取代产品生命周期测试。

### W02 — 增量增加 Binding、Segment、Span 与保留关系

在既有 DB/shared/native 持久层补充必要引用，保留旧字段兼容。支持创建意图、封闭范围、来源版本、原生分支/祖先、只读历史别名与清理 epoch。加组织/主体校验、关联索引和单写入唯一性；别给 Pi 的共享会话文件设错误全局 unique。

迁移支持空库和带旧 Run 的库，不删除真实实例。先做假线性 Thread 与树形 Entry 的小 Fixture，证明 R1/R2/R3 同 Session 却能精确分开，原生物理 ID 变化不改变旧 Run。完成条件：结构能表达全部生命周期，不要求已接全 Runtime。依赖 W00。

### W03 — 将所有场景接到统一 Run/Driver

扩展现有 Agent Run submission 与 SessionIntent，迁移 Chat 原生调用到共同底座。接好准入、预算、Attempt、session writer fencing、创建/提交接受未知、恢复、控制、人类请求与终态。原生提交不接受完整历史数组，Task/Review 特有认领只在对应场景运行。

加多场景交错、旧 worker 迟到、真实进程仍在时租约过期、双队列、按 Run 凭证等测试。至少通过线性与树形两种 Driver Fixture，不能让通用结构暗藏 Codex-only 假设。完成条件：真实入口接线，无第二套 scheduler；依赖 W02。

### W04 — Reader、流与完整历史对照

实现共同 Reader 与旧日志 Reader，并接入原生 Reader 契约。支持单 Run/Conversation scope、稳定游标、单 item 详情、Stop 截止点、ID 重写和权限。事件直达语义投影，短期缓冲、重连快照合并、背压与异常状态均可测试。

用大历史、跨块 Unicode、多分支、压缩前记录、来源缺失和旧审批快照攻击读取路径；读历史不得移动当前执行的原生会话/leaf 或新建模型执行。完成条件：旧 Run 和新 Fixture 都经共同 Reader，不依赖完整 SQL transcript；依赖 W02/W03。

### W05 — Codex 原生 Chat 与 Run 接线

按 8.1 改 App Server；第一次绑定、后续只发新增输入、Turn 范围、普通原生 final、审批/提问、Steer/Stop、精确 Fork 和完整历史都接到主/侧 UI。先保留临时镜像便于读写对照，不先删旧存储。

跑 CD 与共同 RN/TR/SC/GC 用例并做小规模真实 Codex 验证。完成条件：多轮和重启确实同逻辑会话，无重放和 sentinel repair；依赖 W03/W04。

### W06 — Claude Code 原生控制与 raw history

按 8.2 接支持的 SDK/control，保护配置、工具和权限，使用显式 Session ID。完成原生人类请求、Fork 与 UUID 映射、压缩前 Reader 和保留策略。采用 SessionStore 时单独处理镜像与 checkpoint，不强制引入新的持久化依赖。

跑 CL 用例和共同场景测试；真实会话验证与 mock 结果分开。完成条件：不是只加 resume flag，主/侧 Chat 和 Run Detail 均可使用。依赖 W03/W04。

### W07 — Hermes 产品交互与原生 Session-backed Runs

按 8.3 在一个 Adapter 内建立明确 RPC/HTTP 后端。先验证原生 Profile、会话加载、使用量与可恢复历史，然后移除已验证 native 路径的合成上下文。补齐产品级人类请求、Steer、Memory/Skills、子 Agent、压缩与精确助手分支。HTTP 路径的幂等 key、完整详情与真实终态独立验收。

必须进行原生 Hermes 产品与 Rudder 的授权同配置对照，尤其过去易被剪掉的交互。完成条件：HE 与共同 Side Chat 场景通过，不能用普通 HTTP 文本成功代替。依赖 W03/W04；这是必交，不是 Codex 做完后的可选 backlog。

### W08 — OpenCode 原生 Server

按 8.4 加受管理原生 Server、安装 OpenAPI 校准、Session/message/part 范围、SSE、提问/权限、命令、Abort 与精确 Fork。保护实例隔离及配置加载。异步提交与完成、全局流与当前输入分开。

跑 OC 用例及 Side Chat/Fork/恢复；完成条件：不再用一串全量 prompt 模拟连续对话，204 不误报完成，历史读取范围稳定。依赖 W03/W04。

### W09 — Pi RPC/SDK 与助手边界分支

按 8.5 保留原生持久 Session 与扩展，完成树形 selector、完整历史、原生控制和 settled 判断。实现生命周期感知的助手边界分支 helper，验证 veto 与父 leaf 不变。核对增量费用和原生 follow-up 的 Run 分属。

跑 PI 用例与并发父子、较早助手、压缩和 Unicode Fixture；完成条件：不靠伪造用户消息或手改 JSONL 完成 Fork。依赖 W03/W04。

### W10 — Cursor ACP

按 8.6 接 ACP，支持原生问题、计划与权限请求及通知。实际验证历史/Fork/Steer，不猜能力。确实缺少完整读取或精确 Fork 的安装版本，使用已说明的对象补充/context_handoff，用户仍能 Side Chat 和 Keep。

完成条件：CU 用例与基本主/侧 Chat 均接线，已支持能力不被旧 CLI 上限压住，限制明确且不假绿。依赖 W03/W04。

### W11 — 迁移全部产品消费者

将主 Chat、Side Chat、Run Detail、批注、反馈、Debug、学习、搜索预览、导出、文件/Skill 详情都移到共同输入/控制/Reader；旧记录仍通过 legacy Reader。Keep 原地保留和清理 claim 接入真实数据，UI 不暴露多余的底层概念。

测试新 Run 完全没有旧 transcript 行时全部路径依然工作。覆盖刷新、长列表、滚动不丢位置、多窗口、键盘菜单、窄屏、失败保留和来源权限。完成条件：没有“某个角落仍直接读旧表”的隐藏依赖；依赖 W01/W04/W05–W10。

### W12 — 验证后停写与安全回收

逐 Runtime/Profile 通过原生可恢复/完整历史/保留验证后，关闭所有重复原始数据 writer，并移除全量 stdout 累积。对需要对象补充的能力缺口设置明确策略；旧数据不删除、不批量重新注入 Session。

执行唯一大文本标记扫描、磁盘满/镜像失败、原生剪枝、Keep/GC 竞争和删除级联测试。相同负载测量前后 SQL、独立日志、Host/服务端/浏览器内存与读取延迟。完成条件：真正减少重复数据，完整用户能力不丢；依赖 W11。

### W13 — 两轮独立审查、集成验收和交付

第一轮在共同底座、Side Chat 保护与 Codex/Pi 两种不同结构的真实切片完成后执行，重点攻击架构假设和产品回归。第二轮在六种 Runtime、全部消费者和停写/清理完成后执行，重点验证遗漏与真实行为。各轮都由实际独立 Reviewer 和 Verifier 检查代码/调用链与运行行为，修复后复测。

Reviewer 查状态与引用、权限、范围、双队列、费用、原生命令、数据保留；Verifier 从 UI/接口黑盒复现多轮、侧聊、过期/Keep、重启、压缩、分支、断线和清理。要求具体反例与测试证据，不以作者总结代替审核。确实无法 spawn 时如实记录未执行，不把自审写成独立通过。

阶段提交与 PR 汇总真实版本、测试命令、必要截图、性能结果、迁移/回滚与未验证项即可，不另建空白管理包。完整交付需全部范围实际接线、必需验证通过且阻塞性问题闭环。缺凭证等外部问题先做其他不受影响的实现，最后准确报告不能完成的验证，而不是伪造完成或无限重试。

### 11.1 可并行与不可并行部分

共同数据模型、调度状态与迁移由一个 owner 维护。共享契约稳定后，六种 Adapter 可各自独立文件范围并行；Codex 和 Pi 可先构成两种结构的验证切片，同时推进 Claude/Hermes/OpenCode/Cursor，不能将其他四种变成未接线桩。产品集成与存储停写在其依赖通过后进行。

不要求人为扩大 PR 数量。一个工作分支中多个可验证 commit 即可，或按当前仓库规则使用堆叠 PR。任何切片完成后继续下一项，不把第一项通过当成整个任务完成。

## 12. 迁移、灰度与回滚

旧 Conversation 可能每轮对应不同 Session，不能把最后一轮 Session 赋给整个旧聊天。对旧数据先做只读盘点，只有原生 ID、执行范围、权限和保留都能核实的记录才增加原生引用；其余维持 legacy Reader。

新合格会话直接用原生绑定。旧聊天继续时，可选择经过验证的末端原生续接，或明确执行一次可见上下文交接；记录迁移边界。不能手工合并多个原始会话文件，不能把迁移称为全部内部状态无损恢复。

灰度按 Runtime/Profile/版本，不靠一个全局开关。原生执行模式随 Binding 固定，不允许同一会话时而只发增量、时而完整重放。原生升级导致不兼容时暂停受影响的新提交并保留读取/修复路径，不自动建空白 Session。

回滚关闭新的 admission，不删除已创建的新结构或 Reader。已经产生的原生引用 Run 仍然能读；在途执行安全收敛后再切换。数据库变更初期保持增量可兼容，不能用回滚丢掉全部新历史。旧日志清理是保留策略，不是迁移的默认删除步骤。

## 13. 验收方法、资源指标与完成标准

### 13.1 验证层次

单元/契约测试检查 selector、序号、幂等、事件、配置与来源；集成测试检查真实 DB 事务、Run/Attempt、资源与故障恢复；E2E 检查主/侧 Chat 用户行为。真实原生测试验证 mock 不能证明的 Session 持久化、压缩、分支、权限、插件、工具与 Profile 一致性。不能用“命令执行成功”代替这些层次。

下节保留原方案 97 个验收 ID 和实质要求，直接写在本文，不再配独立 JSON 账本。受条件影响的测试仅在对应功能启用时适用，例如 Claude 对象镜像；必须明确条件，而不是把前五种必需原生适配全标 N/A。Mock 通过不等于 native verified。

### 13.2 资源测试负载

用确定性工具/会话 Fixture 构造同一套前后对照：例如 100 个 Conversation、各 100 次输入，工具结果混合 1 KiB–1 MiB；单会话 10,000 个 item；10 个并发活跃会话；慢客户端与重连突发；磁盘满和对象存储故障。数值是建议测试形状，不是声称已测出的性能或新用户配额。

测量 SQL 行数与写入字节、SQL 增长、独立原始日志增长、控制服务 RSS、Host RSS、浏览器 heap、首屏历史与详情读取延迟、Stop/审批响应、恢复延迟。统计原生持久卷和对象补充增长，避免把数据从数据库转移到别处后宣称总存储归零。

原生连续会话使用的模型上下文不保证变小，模型费用也不保证下降；不要把减少 Rudder 重复写入等同于降低模型 token。进程常驻可能降低启动延迟却增加空闲内存，分别测量并设回收策略。

### 13.3 检查命令与真实环境

使用当前本地 package scripts 和 AGENTS 的要求，不盲执行旧版本命令。此前基础检查包括以下路径，实际以当前仓库为准：

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
# Run the affected current E2E suites and the repository's required CI checks.
# Run relevant cargo test/check/clippy when native crates/bridges change.
# Run pnpm desktop:verify when packaged startup, profiles, or migrations change.
```

数据库迁移在隔离实例验证，不 reset 用户实例，不删除真实 Session 来做测试。大规模负载用 Fixture，真实模型调用在现有授权与预算内小规模验证。编译通过不替代浏览器/桌面运行；受影响界面保留必要截图作为验收证据。

### 13.4 Definition of Done

完成时，主 Chat 已真正沿原生会话连续运行并显示/控制全部必需交互；Agent Run 是所有场景共同底座，各自精确关联原生区间；Side Chat 的所有既有生命周期与父子交互不退化；六条 Adapter 实际接线，真实能力和限制可核对；历史在重启/压缩/分支后仍按权限可读。

符合只存引用条件的 Runtime 已实际停写重复原始过程，必要对象补充有清晰范围；所有消费者走共享 Reader；保留、备份、GC、旧记录和回滚经过验证；费用、权限、审批和用户数据未被破坏；两轮独立审查真实执行并闭环。未验证项不能通过绿色状态、文档或未启用的开关掩盖。

提交、PR 和最终说明准确列出实现、实际测试、性能结果及仍受阻的项目。不要求新增项目管理文件，也不以填完模板作为完成证据。

## 14. 内联验收清单：97 个具体场景

以下均为待执行要求，不是本次已通过结果。同一场景需按适用 Runtime 运行；对应 Reader/调度公用 Fixture 和少量真实原生验证互补。

### Side Chat 产品回归

| ID | 条件、操作与必须满足的结果 |
|---|---|
| SC-01 | 草稿入口：从 /side、助手动作及空面板打开；在首次 Send 前，服务器 Conversation、原生 Session、Run 与模型调用均不新增，父草稿不变。 |
| SC-02 | 首次发送幂等：同时发送同一创建请求只能产生一个隐藏子聊天和一次输入；同 mutation ID 改来源或 Agent 应冲突，不重复 Fork。 |
| SC-03 | 临时会话可恢复：第一轮只有工具结果包含关键信息；重启 Rudder 和 Host 后在期限内追问，仍从同一逻辑子会话原生恢复，不重放历史。 |
| SC-04 | 父子并发：父 Chat 有在途 Run、未发草稿与附件时运行、Steer、Stop 子 Chat；父草稿、滚动、变体、Transcript 与控制句柄不变。 |
| SC-05 | 复制来源：来源包含工具详情、批注、附件与已批准操作；子 Chat 可读、可引用已授权片段，但不取得源 Run、费用或审批权，附件归属正确。 |
| SC-06 | 隐藏与创建者：同组织另一人和另一组织分别尝试列表、搜索、Chat/Run/原生引用、导出、资产读取；只有获准主体可读，native ID 不能绕过授权。 |
| SC-07 | 到期只读：服务器时钟到达期限后，历史仍可读，新未接纳输入被拒绝，不因 TTL 到达而调用原生删除。 |
| SC-08 | 关闭只影响子执行：父子都有在途任务，关闭临时子 Chat 并在清理中重启；只停止子执行，清理可恢复，父任务继续。 |
| SC-09 | 原地 Keep：子 Chat 有多次 Run 时重复 Move to Messenger；Conversation、Binding、Run 与费用身份不变，不因 Keep 调用原生 create/fork/start，原生自身压缩单独记录。 |
| SC-10 | 流式/审批中晋升：在输出中或等待原生请求时 Keep，在普通 Chat 继续响应；仍命中同一请求和 Attempt，无重启、丢请求或重复答复。 |
| SC-11 | Keep/Close/GC 竞争：旧 epoch 清理任务迟到；只有一个合法产品状态获胜，已 kept 资源不可被旧任务删除，已销毁记录不可复活。 |
| SC-12 | 分组兼容：无组、已有组、嵌套 Fork、冲突组分别 Keep 并并发重试；按当前家族规则创建/复用一次，不在幂等重试时重新乱分组。 |
| SC-13 | Host 离线 Keep：资源或创建意图已持久、来源有效且期限未到；原地晋升不依赖 provider RPC，历史状态如实显示 offline。 |
| SC-14 | 更换 Agent/Runtime：子 Chat 选另一 Agent/Profile 后发送；兼容且授权时原生 Fork，不兼容时明确上下文交接，后续仍原生连续，不伪称无损迁移。 |
| SC-15 | Composer/面板：文件、图片、引用、model/effort、plan mode、失败重试、滚动、文件/Skill 查看和键盘菜单均保持原功能，缺口明确展示。 |
| SC-16 | 标题与 override：长源标题和非默认模型下创建、发送、再重命名源聊天并 Keep；子标题按原规则快照/截断，override 清空规则不被原生继承模型反向覆盖。 |
| SC-17 | Keep 后长期恢复：多个原生 Segment 的子会话晋升后经历原生裁剪及重启；旧 Run 与原生恢复状态都保留，不能只有 kept 元数据。 |
| SC-18 | 过期 Keep：恰好到截止点、超过截止点和已提交 expired 三种状态均保持现有拒绝规则，不新增永久聊天或原生操作。 |
| SC-19 | TTL 刷新：对照实际持久化消息与 token、轮询、读取、重连、迟到回调；只有现有允许活动刷新期限，不能复活已提交 expired 状态。 |
| SC-20 | 来源删除：Keep 事务前来源消失，晋升与分组一并回滚；面板和草稿保留，不留半晋升记录。 |
| SC-21 | 精确选择：来源有回答变体、后续轮次和停止前缀；分别创建 Side Chat，仅含所选授权前缀，不混入别的变体、后续信息或未见尾部。 |
| SC-22 | 不同关闭入口：关闭未发送草稿不产生服务器工作；关闭已 kept 的面板只移除视图，不删永久聊天；inline、菜单、快捷键均一致，失败保留状态。 |

### Agent Run 与统一执行

| ID | 条件、操作与必须满足的结果 |
|---|---|
| RN-01 | 实际入口：追踪当前 TS/Rust 下 Chat、Issue、Review、Automation、Heartbeat 与六种 Adapter；公共底座必须真的被调用，不存在新建但未接线的调度器。 |
| RN-02 | 旧 Run 不增长：同 Binding 连续 R1/R2/R3，之后刷新读取 R1；只返回 R1 的原生范围，其状态与费用不和其他 Run 合并。 |
| RN-03 | 物理身份变化：原生压缩后继或 leaf 改变后继续并读旧 Run；逻辑绑定一致，旧选择器仍定位正确来源，不靠时间猜。 |
| RN-04 | 接受未知：带副作用输入被原生接受但响应丢失，重启后重试；先核对，未解决仍 unknown，不重复副作用。 |
| RN-05 | 旧租约与控制：旧执行未停却租约过期，尝试接管并发送迟到 Steer/Stop；不出现无 fence 双写，旧控制不能击中新任务。 |
| RN-06 | 队列唯一：Rudder follow-up 与原生 guidance 队列并存时重连/重放 mutation；每条新输入一个 Run、一次提交，Steer 留在当前 Run。 |
| RN-07 | 常驻凭证：第二轮凭证与第一轮不同，复用 Host 调用 Rudder 工具；每次按精确当前 Attempt 授权，不复用第一轮 Token 或全局 currentRunId。 |
| RN-08 | 外部原生写入：CLI/Desktop 与 Rudder 同时使用物理 Session；采用可证明的原生协调或拒绝不安全并发，不把 DB 锁当成外部 fence。 |
| RN-09 | 跨场景交错：同 Agent 执行 Chat A、Issue B 和 Automation，再回 A；A 不被劫持，任务认领只在任务场景触发，预算/终态规则保留。 |

### Transcript 与界面读取

| ID | 条件、操作与必须满足的结果 |
|---|---|
| TR-01 | 模型上下文不等于历史：便利 Reader 已压缩旧工具内容时打开旧 Run；必须读取完整获准原始历史/对象补充，不把摘要标成完整过程。 |
| TR-02 | 只读不执行：统计原生调用，读历史、展开、分页、刷新均不触发模型/工具/审批，也不改变正在执行的原生 leaf。 |
| TR-03 | 大历史：10,000 item、压缩前条目及大工具输出下加载首屏、详情、断线恢复；Host/服务端/浏览器资源有界，游标稳定，空/partial/offline/missing 可区分。 |
| TR-04 | Stop 前缀单调：Stop 接受后原生又输出内容，再刷新/反馈；可见正文仍为精确截止前缀，隐藏尾部不变成最终回复或新分支模型上下文。 |
| TR-05 | 迟到子结果：父已结束，子后到；附属证据因果关联一次，父终态不重开，费用不覆盖/重复。 |
| TR-06 | 历史非控制回放：快照含旧审批与提问，同时存在新 live request；旧记录只读，不自动回答或错路由到新请求。 |
| TR-07 | 流 framing：跨块 UTF-8/JSON、多行 SSE、重复帧、缓冲外重连；无乱码/重复工具行/重新执行，快照可校准且解析有界。 |
| TR-08 | 全部消费者：新 native-reference Run 没有任何旧 transcript 行；主/侧 Chat、Run Detail、批注、反馈、搜索、学习和导出仍走 Reader 正常工作。 |
| TR-09 | 未知事件/来源消失：检查 Nice/Raw/详情；未知安全显示，不扩大私有数据展示，缺失明确，不静默重建或显示成空成功。 |

### 原生保留、清理与备份

| ID | 条件、操作与必须满足的结果 |
|---|---|
| GC-01 | 祖先保留：已 Keep 分支依赖父 Segment/子会话时触发原生裁剪；依赖保持或先合法独立保存，完整获准历史仍可读。 |
| GC-02 | 删除级联：删除临时 owner 会影响原生后代，其中后代另有保留引用；必须检查实际级联范围，不能按根 ID 盲删。 |
| GC-03 | 清理 fence：执行仍在或 claim 已变时重放 GC，并经历晋升/重启；重新校验 epoch、owner 和真实终态，不删除活跃/永久资源。 |
| GC-04 | 持久化前置：只有内存 Session 或无备份临时 worker 磁盘时尝试开启 native-reference；拒绝并说明需要的持久化条件。 |
| GC-05 | 孤儿创建：原生 Fork 成功而 DB 提交失败，重试和清理核对；追认同身份或安全回收，不重复模型执行、不无限积累孤儿。 |
| GC-06 | 备份完整性：镜像缺子 Agent、checkpoint 或原生条目/报告失败时尝试删最后本地副本并换 Host 恢复；不得当成完整备份，不允许先删。 |

### 权限、秘密与来源隔离

| ID | 条件、操作与必须满足的结果 |
|---|---|
| SEC-01 | 同 ID 不同主体：不同用户/Profile 有相似 native ID，交叉访问游标/对象/别名/缓存；不能跨组织、创建者和 Profile，展开与导出重新授权。 |
| SEC-02 | 复制不复制权力：子 Chat 显示父审批/工具回执，尝试用复制 ID 响应或记费用；只读来源不能获得原控制权或源消耗归属。 |
| SEC-03 | 凭证恢复：旧 Token 已过期，重启恢复 Profile 后用新 Run/旧引用调用；只允许当前授权，诊断/产物无秘密。 |
| SEC-04 | 低权限子分支：较少工具/不同主体从高权限来源 Fork/交接；校验内容和权限，不通过复制原生状态扩大权力。 |
| SEC-05 | 原生检索隐私：另一操作人的 Agent 用 session_search、插件或 Memory 搜索私有 Side Chat 唯一标记；必须在原生检索层也无法越权。 |
| SEC-06 | secret 与撤销：答秘密问题、取消审批，再重放迟到浏览器响应；秘密不入库/日志，旧响应不能批准后续动作。 |

### Codex

| ID | 条件、操作与必须满足的结果 |
|---|---|
| CD-01 | Codex 连续性：工具独有信息后先三轮再超过十二条消息，中途重启进程；同具体 Thread、仅新增输入，无 Rudder 历史重放。 |
| CD-02 | Codex 旧 Turn Fork：父已前进，从较早完成 Turn 建 Side Chat；新具体 Thread、根关系正确、父在途工作不动，含边界准确。 |
| CD-03 | Codex 控制：原生权限/用户输入请求往返，指定 Turn Steer、Stop 与迟到回调；不空答、不默认批准、不误击其他 Turn。 |
| CD-04 | Codex 缺 Session/分页不支持：读取并追问；不静默 thread/start，显示真实来源/能力，只用经验证的有界替代 Reader。 |
| CD-05 | Codex 原生 final：无 Rudder sentinel 的 commentary/tool/final 正常结束一次；无额外修复推理，commentary 不冒充 final。 |
| CD-06 | Codex 后代清理：隔离测试 Thread 有已保留后代；清理必须反映原生级联，不删除 kept 子或另有引用的证据。 |

### Claude Code

| ID | 条件、操作与必须满足的结果 |
|---|---|
| CL-01 | Claude 显式恢复：同 cwd 两个 Session 加另一 Profile，重启交错恢复；始终选正确 ID/配置，不用目录最近会话。 |
| CL-02 | Claude 压缩前读取：getSessionMessages 不含旧条目时打开早期 Run；raw Reader/补充仍提供完整获准来源。 |
| CL-03 | Claude Fork ID：按助手边界 Fork 后继续并引用来源；边界与重映射准确，旧 UUID 不控制子 Session。 |
| CL-04 | Claude 配置与交互：同授权原生 Code 与 Rudder 比较指令/Skills/MCP/模型/提问；不因 SDK 默认丢能力或扩大权限。 |
| CL-05 | Claude checkpoint：已有文件检查点时配置所选云镜像并分支/rewind；不启用不兼容组合、不静默关闭 checkpoint。 |
| CL-06 | Claude 镜像失败：mirror error/缺 listSubkeys/子条目后完成 Run 并恢复/清理；保留最后本地副本，不把不完整子恢复标通过。 |

### Hermes

| ID | 条件、操作与必须满足的结果 |
|---|---|
| HE-01 | Hermes 原生历史：已有工具结果，用 Session ID 仅发新 input、不带 caller history/response chain；验证真实原生续接，合成上下文未再注入。 |
| HE-02 | Hermes 幂等：支持正式 Idempotency-Key 时同 payload 重试/重启、改 payload 冲突、模拟过期；契约内复用原 Run，过期不允许盲重发未知副作用。 |
| HE-03 | Hermes 压缩后继：原生转到后继 Session，通过原生 resolver 继续并读旧 Span；逻辑绑定不乱改，原身份/范围保留。 |
| HE-04 | Hermes 完整详情：工具输出超过 SSE preview，流结束且 Host 重启后展开；完整获准详情可达，preview 不标无损。 |
| HE-05 | Hermes 产品控制：approval/clarify/secret 等待中答复、取消、queue、Steer、interrupt；同一个 native owner，secret 瞬时，无 HTTP/TUI 两进程误控制。 |
| HE-06 | Hermes Profile 一致：有 Memory、Skills、所选工具/模型的授权配置做原生/Rudder 连续对照并测另一用户；不裁剪工具集冒充原生，检索不泄露。 |
| HE-07 | Hermes 迟到子结果：子执行超出父 SSE 生命周期，等待原生投递后读详情并发下一真实输入；一次交付、不重开父 Run、不自发推理、不重复费用。 |
| HE-08 | Hermes Gateway 恢复/分支：刷新浏览器、重连 Host，再从旧助手回复分支；不每次刷新建新 Session，不分 latest head，待请求行为准确。 |
| HE-09 | Hermes 裁剪与 Keep：老历史/压缩祖先与永久子聊在隔离配置下执行实际裁剪；claim/备份保住读与恢复，不擅改借用的全局设置。 |

### OpenCode

| ID | 条件、操作与必须满足的结果 |
|---|---|
| OC-01 | OpenCode 原生服务器：认证隔离实例中创建、连续输入、重启；Session/Workspace 正确，message/part Run 范围明确，不用纯文字历史重放。 |
| OC-02 | OpenCode 分支边界：user/tool/assistant 链后还有新输入，从旧助手 Fork 并比较祖先；含/不含边界实证，不替代相邻用户边界，不 revert 父文件。 |
| OC-03 | OpenCode 请求/命令：插件/MCP 提问、权限、原生命令和中断；使用安装 schema，不自动批准或猜 endpoint，输出保留。 |
| OC-04 | OpenCode 204：异步接受后立即断线且后续输入排队；自己的原生终态到来前 Run 不完成，重连不重复提交。 |
| OC-05 | OpenCode 共享 SSE：两个 Session 的全局事件、慢客户端及重启某实例；只投影各自范围，缓冲有界，不 dispose 无关 server。 |

### Pi

| ID | 条件、操作与必须满足的结果 |
|---|---|
| PI-01 | Pi 显式持久化：有 managed extensions 的 Session，RPC 输入、重启、再输入；正确文件/Profile，不 no-session 或目录 latest。 |
| PI-02 | Pi 助手边界：父正在更新但选择旧助手，调用合法生命周期 helper；子准确到助手，父 leaf 不变，无伪 RPC/假用户插入。 |
| PI-03 | Pi 扩展否决：session_before_fork veto，RPC success=true/cancelled=true；按取消处理，不换 Fork/交接绕过决定。 |
| PI-04 | Pi 树形 Reader：源含废弃分支和压缩前历史，分别读旧/新 Run；只取对应祖先范围，不把所有 entries 重放成上下文。 |
| PI-05 | Pi settled：turn_end/agent_end 后仍重试/压缩；Run 不提前完成，不重复准入下一条，以经验证完整终态结束。 |
| PI-06 | Pi Unicode/扩展：JSON 字符串含 U+2028/U+2029 并有扩展问题，跨块接收、答复/取消；LF framing 正确，交互不静默 no-op。 |
| PI-07 | Pi 费用：累计 stats 已含历史与压缩/工具消耗，再完成一轮；仅记新的因果使用量，不把累计总额重复记入每个 Run。 |

### Cursor

| ID | 条件、操作与必须满足的结果 |
|---|---|
| CU-01 | Cursor ACP 续聊：安装版本支持 ACP new/load，创建、连续、重启、明确 ID load；原生连续性和模式保留。 |
| CU-02 | Cursor 阻塞扩展：ask_question/create_plan/permission 同步到 Rudder，用户答或取消；正确回复，不因忽略扩展卡死。 |
| CU-03 | Cursor 历史：load replay 可能缺项，重启后读旧 Run 对照原生可见信息；足够证据才 native-reference，否则对象补充，不造完整假象/SQL 全量副本。 |
| CU-04 | Cursor 无精确 Fork：所装版本不支持边界时建 Side Chat 并 Keep；生命周期可用、交接明确，不标无损 Fork、不猜私有数据库。 |
| CU-05 | Cursor 能力细分：项目/用户/团队 MCP、模式和任务/计划/图片通知逐项检查；支持者映射，真实限制不被单个绿色 badge 掩盖。 |

### 全局验收与交付

| ID | 条件、操作与必须满足的结果 |
|---|---|
| OP-01 | 能力证据：有文档但缺安装/凭证的 Runtime；配置与报告区分 unknown/documented/observed/verified，不缺证据判通过，六条范围均明确。 |
| OP-02 | 重复写入扫描：确定性工具输出大唯一标记，扫描 SQL、日志、result、recovery、telemetry；只在声明原生源/对象例外出现，短批注/Stop 另计。 |
| OP-03 | 性能前后：相同大历史、并发、重连负载测 SQL/日志/服务端/Host/浏览器资源与延迟；不以全量读取后浏览器切片冒充优化。 |
| OP-04 | 回滚混合历史：legacy/native-reference 混用且原生 Chat 活跃，禁新入口并重启；旧新 Reader 仍可用，不交替重放/增量，不删旧数据。 |
| OP-05 | 其他场景/Runtime：Task/Review/Automation/Heartbeat 及 Gemini/OpenClaw 既有套件；预算、准入、执行不退化，Chat 无新增 Issue 依赖。 |
| OP-06 | 真实两轮审查：用可用的独立 Reviewer/Verifier 执行并修复；报告基于实际身份/上下文和测试，未运行如实说明，不自审冒充独立通过。 |
| OP-07 | 最终交付诚实：mock 通过但部分原生凭证/测试缺失时汇总；列明真实调用、版本、验证、截图、指标与阻塞，休眠开关和 legacy 桩不算完成。 |

## 15. 实施时使用的证据入口

下面是此前代码基线与官方协议入口。它们用于查证，不是额外必填报告，也不代表所有功能已经在本机验证。若线上文档与安装源码不一致，记录差异并以实际已验证的版本契约实施，不能静默扩大或降低功能要求。

[R-BASE] Rudder 此前代码基线：`https://github.com/Undertone0809/rudder/tree/c54001819ca38079b627994557db0a18ed278fc0`。重点为 `server/src/services/side-chats.ts`、`chat-assistant.ts`、`runtime-kernel/`、六种 `packages/agent-runtimes`。当前本地新代码优先，不回退 SHA。

[R-SIDE] Side Chat 代码与后续家族分组：上述基线下 `server/src/services/side-chats.ts`、`doc/plans/2026-07-21-side-chat-title-and-fork-grouping.md`、`server/src/__tests__/side-chats.test.ts`。7 月 19 日较早文档有已被后续修订覆盖的分组说明，不作为当前优先契约。

[R-HERMES] Rudder 同基线 `packages/agent-runtimes/hermes-gateway/src/server/execute.ts`。此前已读 Session 映射、合成工具上下文、HTTP 提交和控制；并非重新声称当前本地尚未改变。

[S1] Codex App Server：`https://developers.openai.com/codex/app-server`。当前入口可能重定向；读取实际版本的原生协议/schema。不要只因文档列出实验分页就认为存储引擎支持。

[S2] Claude sessions：`https://code.claude.com/docs/en/agent-sdk/sessions`。指定 Session 恢复、Fork 与初始化身份；SDK/CLI 版本需对应。

[S3] Claude storage：`https://code.claude.com/docs/en/agent-sdk/session-storage`。恢复消息链、完整原始条目、镜像/子资源及 checkpoint 限制分别验证，不把便利读取当完整历史保证。

[S4] Hermes API rendered docs：`https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/`。包含 Runs/Session/capabilities 入口；其缓存/版本与固定源码描述有差别，尤其去重保留与原生加载语义必须验证安装版本。

[H-API] 前次已读 Hermes 固定源码：`https://github.com/NousResearch/hermes-agent/blob/25d88ad0c44ccf0dcf8228f184b5a495c16b9f9f/website/docs/user-guide/features/api-server.md`。其中的原生 Session-backed Runs、幂等及子结果描述是该版本证据，不是全部部署的通用保证。

[H-TUI] Hermes 产品桥接：`https://github.com/NousResearch/hermes-agent/blob/main/ui-tui/README.md` 与同版本 `tui_gateway/`。main 是可变引用；本地实现锁定已安装对应版本并读实际 registry/contracts，新增 Rudder helper 不冒充上游 RPC。

[S5] OpenCode Server：`https://opencode.ai/docs/server/`。实现按安装实例 `/doc` 或相应 OpenAPI 校准，特别是消息边界、permission/question 路由。

[S6] Pi RPC：`https://pi.dev/docs/latest/rpc`。校准低层/settled、queue、entry、fork/clone 及扩展取消。latest 文档不替代本机版本检查。

[S7] Pi Session format：`https://pi.dev/docs/latest/session-format`。原生树/祖先和合法分支 API 是基础；仅调用低层文件 API 不证明已保留扩展生命周期。

[S8] Cursor ACP：`https://cursor.com/docs/cli/acp`。原生 Session、控制、扩展请求与具体限制；未证明的精确 Fork/历史能力不得凭类比补造。

---

**交付原则：原生 Chat 的连续性与交互完整性、Agent Run 的统一执行与精准归属、Side Chat 的产品不退化、六种 Runtime 的真实适配、可验证的存储优化，五者同时成立才是完成。**
