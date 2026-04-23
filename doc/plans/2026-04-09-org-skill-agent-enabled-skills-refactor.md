# Org Skills / Agent Enabled Skills 模型重构计划

## Summary
把 Rudder 的 skills 体系重置成三层清晰模型，并一次性修掉当前的空列表、100+ required、命名残留和 adapter 越权问题。

目标结果：

- 新 org 创建后，组织技能库稳定显示 4 个 Rudder 自带技能：
  - `para-memory-files`
  - `rudder`
  - `rudder-create-agent`
  - `rudder-create-plugin`
- 新 agent 默认 `0` 个 enabled skills
- Agent 运行时只加载该 agent 在 Skills 页明确 enable 的 skills
- `Codex`、`Claude Code` 默认不读取用户 home 下的 skills
- UI / API / shared types 不再使用 `company skill` 语义

## Key Changes

### 1. 统一产品模型与命名
- 把当前 skills 语义明确拆成三层：
  - `bundled organization skills`：Rudder 自带的 4 个核心技能，属于组织技能库的一部分
  - `organization skill library`：当前组织可供 agent 选择的技能库
  - `agent enabled skills`：某个 agent 当前启用的技能集合，默认空
- 所有 public surface 改成 `organization` 术语，不再出现 `company skill`：
  - UI 文案
  - route helper / service helper 名称
  - shared skill origin value 从 `company_managed` 改成 `organization_managed`
- shared validator 保留对旧值的兼容读取一版，但新写入和新返回只用 `organization_*` 命名

### 2. 把 4 个 Rudder 自带技能移出 `/.agents/skills`
- 新建专用 bundled 目录，作为 Rudder 产品资产，不再混在开发者/工作区 skill root 里
- 目录位置定为：`server/resources/bundled-skills/<slug>/SKILL.md`
- `organization-skills` 的 bundled seeding 只从这个目录读取，不再扫 repo `.agents/skills`
- 这 4 个技能在组织库中显示为 `Bundled by Rudder`，不是 `Required by Rudder`
- 它们默认存在于每个 org 的技能库，但默认不为任何 agent 自动 enable

### 3. 停止递归 skill 扫描，修正新 org / 老 org 异常
- 删除当前对 `.agents/skills` 根目录的递归导入逻辑，禁止把 `build-advisor-workspace/...`、缓存目录、eval 目录里的 `SKILL.md` 当成 bundled 或 local skills
- 自动发现只允许两种标准结构，不递归：
  - `<root>/skills/<slug>/SKILL.md`
  - `<root>/<slug>/SKILL.md`
- 组织技能页不再在首次打开时自动做 project workspace scan；改为：
  - 先同步/显示 bundled 4 skills
  - 通过显式按钮执行本地扫描或手动导入
- 本轮把“本地扫描”的默认根限定为用户本机的 `~/.agents`，按上面两层结构找 skill；repo / workspace 内的技能如需加入组织库，走显式导入
- 加一轮 legacy cleanup：
  - 清理所有 `sourceKind = rudder_bundled` 但不在 4 个 canonical bundled skills 内的旧记录
  - 为缺失 org 补齐 4 个 bundled skills
  - 清理 agent 上指向已删除 legacy bundled skills 的旧引用

### 4. 把 Agent enabled skills 从 adapter config 中独立出来
- 新增独立持久化模型，作为 agent 的真实 source of truth：
  - 建议新增表：`agent_enabled_skills`
  - 最小字段：`id`, `org_id`, `agent_id`, `skill_key`, `created_at`
  - 唯一约束：`(agent_id, skill_key)`
- `agentRuntimeConfig.rudderSkillSync.desiredSkills` 不再作为真实状态来源
- `POST /agents/:id/skills/sync` 保留现有接口形状，但改成读写 `agent_enabled_skills`
- `GET /agents/:id/skills` 返回的 `desiredSkills` 改为来自 `agent_enabled_skills`
- 旧数据迁移规则：
  - 保留 agent 当前显式选择的非 bundled skills
  - 不信任历史 `required` 注入出的 bundled 勾选状态
  - 4 个 bundled core skills 在迁移后默认全部视为未 enable
- `create agent` 仍允许传 `desiredSkills`，但只写入 `agent_enabled_skills`，不回写 adapter config

### 5. 重写 Agent Skills 页语义
- Agent Skills 页改成“为这个 agent 配置可用技能”，不再是 adapter sync 诊断页
- 页面结构调整为：
  - Summary
  - Enabled skills（来自 organization skill library，可开关）
  - External / adapter-discovered skills（默认关闭；当 adapter 有 Rudder-managed ephemeral surface 时也可显式开关，否则保持只读观测）
- 移除 `Required by Rudder` section
- `Bundled by Rudder` 只作为 skill source badge 出现在库项上，不锁定，不自动勾选
- 默认所有 skills 关闭
- 增加批量操作菜单：
  - Enable selected
  - Disable selected
  - Enable all visible
  - Disable all visible
- organization skills page 显示 bundled + imported 两类，不再把 bundled 整体隐藏
- organization skills page 不再出现新 org `0 available` 的空状态，除非 bundled seeding 本身失败

### 6. 收紧 adapter 职责，取消 adapter 对 active skill set 的决定权
- adapter 的职责缩成两件事：
  - `realize(enabledSkills)`：把 Rudder 指定的 enabled skills 实际挂载/注入到运行环境
  - `observe()`：返回 adapter 观测到的 external/discovered skills
- adapter 不再有“fallback to required skills”或“自己决定默认要加载什么 skills”的逻辑
- 移除 `resolveRudderDesiredSkillNames` 里“无显式配置时回退到所有 required”的默认行为
- `Codex`：
  - 保留 per-org managed `CODEX_HOME`
  - 运行时只注入该 agent enabled 的技能到 repo-scoped `.agents/skills`
  - 不再依赖或暴露 `~/.codex/skills` 作为实际加载来源
- `Claude Code`：
  - 新增 Claude managed home / isolated skill surface
  - 默认不读取 `~/.claude/skills`
  - 运行时只挂载该 agent enabled 的技能
  - 用户 home 中已有的 skills 如果要显示，只能作为外部观测项，不参与默认运行时加载
- 其他 local adapters 跟随同一规则：是否支持 `observe` 可以有差异，但 `enabled set` 的决定权统一在 Rudder

### 7. 文档与规格更新
- 更新技能相关实现规格，明确：
  - bundled 4 skills
  - organization library 与 agent enabled skills 分离
  - adapter 不拥有 active skill set 决策权
- 更新 CLI / adapter 文档，删除或改写所有“Rudder 会安装到 `~/.codex/skills` / `~/.claude/skills`”的表述
- 把用户可见的 skill reference / skill source 文案统一成 org 语义

## Public / Interface Changes
- 数据新增：
  - `agent_enabled_skills` 持久化模型
- 共享类型变更：
  - skill origin `company_managed` -> `organization_managed`
  - `required` / `requiredReason` 从主流程语义中退场；如保留字段，仅用于兼容旧客户端，不再被新 UI 使用
- 路由语义变更：
  - `GET /agents/:id/skills`：`desiredSkills` 来自独立 attachment store，不再来自 adapter config 推导
  - `POST /agents/:id/skills/sync`：更新 attachment store，并触发 adapter reconcile，但不再让 adapter 决定默认集
- 组织技能列表语义变更：
  - 新 org 默认能看到 bundled 4 skills
  - 不再自动扫描 project workspace
  - 本地扫描改为显式动作

## Test Plan
- 后端单测 / 集成测试：
  - 新 org 第一次访问 skills 时自动补齐 4 个 bundled skills
  - bundled discovery 只接受两层标准结构，不会递归导入 `build-advisor-workspace` 等深层目录
  - 旧 org 清理后只保留 canonical bundled 4 skills，其余 legacy bundled 记录被删除
  - `POST /agents/:id/skills/sync` 写入 `agent_enabled_skills`，不再写 `rudderSkillSync.desiredSkills`
  - 新 agent 默认 `desiredSkills = []`
  - 迁移后 old agent 的非 bundled custom skills 仍保留
  - `Codex` 运行时只注入 enabled skills，不读取 shared home skills
  - `Claude` 运行时在隔离 home 下只加载 enabled skills，不读取 `~/.claude/skills`
- UI / E2E：
  - 新 org 的 org skills 页显示 bundled 4 skills，而不是空页
  - Agent skills 页默认全部未选中
  - 勾选 / 取消勾选 / 批量开启 / 批量关闭都正确保存
  - Agent skills 页不再出现 `Required by Rudder`
  - 外部 adapter skills 若存在，默认灰掉；只有 Rudder 能真实 gate 运行时挂载的 adapter 才允许在 external section 显式 enable
- 文档校验：
  - CLI / adapter docs 不再宣称运行时依赖 `~/.codex/skills` 或 `~/.claude/skills`

## Assumptions / Defaults
- 这 4 个 Rudder 核心技能属于“bundled skills”，不是“required per-agent skills”
- 新 agent 默认不自动 enable 任何 skill，包括这 4 个 bundled skills
- legacy agent 上历史 bundled 勾选状态不可信，本轮迁移统一清空；自定义非 bundled skills 尽量保留
- organization skill library 是每个 org 自己的库；新 org 默认只有 bundled 4 skills，其它本地 skills 通过显式扫描或导入进入该 org
- 本轮先把问题彻底收束到 `organization skill library + agent enabled skills + adapter external observation/import` 三层，不额外扩展更复杂的 skill marketplace 或 cross-org sharing
