# Rudder public documentation terminology

Use this glossary as a shared fact brief, not as a word-for-word translation
table. Capitalized English terms in the Chinese column are retained only when
they are interface names a reader must recognize.

| Meaning | English | Simplified Chinese | Note |
| --- | --- | --- | --- |
| durable task record | Issue | Issue（任务单） | Define with the approved full definition; never use “structured task” or “结构化任务” |
| person or agent responsible for the next execution step | owner / assignee | 负责人 / 执行者 | Use `Assignee` only when naming the UI field |
| person or agent making an independent quality decision | reviewer | 评审人 | Use `Reviewer` only when naming the UI field |
| bounded execution attempt | agent run | Agent 运行 / 一次运行 | Use `Agent Runs` for the UI page |
| system used to execute an agent | runtime | 运行环境 | Use `Runtime` only for the UI field or exact runtime name |
| preserved messages and execution events | transcript | 对话记录 / 运行记录 | Choose the natural term for the surface |
| inspectable work product | artifact / output | 产物 / 输出 | `Outputs` may be retained as a UI section name |
| governed permission to proceed | approval | 审批 | Distinguish from review, which judges output quality |
| review judgment | review decision | 评审结论 | Examples: approve, request changes, blocked |
| money or token limit | budget | 预算 | Use `Budget` only for the UI label |
| historical mutation record | activity log | 活动记录 | Use `Activity` only for the UI page or tab |
| ongoing conversational work surface | Chat | Chat | UI name |
| cross-work attention surface | Messenger | Messenger | UI name |
| scheduled work and run history surface | Calendar | Calendar | UI name |
| organization summary surface | Overview / Dashboard | Overview / Dashboard | UI names |
| reusable operating instructions | skill | 技能 | Use `Skills` for the UI page |
| repeated triggered work | automation | 自动化 | Use `Automations` for the UI page |
| files and reusable organization context | Library | Library（资料库） | UI name; explain once on first use |
| filesystem execution area | workspace | 工作区 | Use `Workspace` only for the UI field |

## Required Issue definitions

English:

> An issue is a durable task record with an explicit status and lifecycle. Use
> one when work needs a named owner, dependencies, or a review path; comments,
> agent runs, artifacts, and review decisions can stay with the same record.

Chinese:

> Issue（任务单）是带有明确状态和生命周期的任务记录。需要指定负责人、跟踪依赖或安排评审时使用；评论、Agent 运行、产物和评审结论可以留在同一条记录中。
