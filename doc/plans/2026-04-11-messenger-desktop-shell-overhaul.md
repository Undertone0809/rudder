# Messenger 与 Desktop Shell 视觉/交互整顿

## Summary

当前问题的主层是 **interaction design**，次层是 **visual design / standards gap**：

- Messenger 左侧 thread list 没有复用既有 chat list 交互，导致 chat 和 system thread 不是同一种产品语言。
- 新 org 的空状态被错误地建模成“展示很多空线程”，这其实是信息架构错误，不是文案问题。
- 主内容区把 object thread 做成了“页面详情页”，而不是“像聊天一样的消息流对象块”，所以 chat 与 approvals / errors / alerts 的阅读节奏断裂。
- Desktop shell、settings modal、card 包裹和顶部留白没有遵守同一套 surface 规则，导致毛玻璃材质、边距、遮罩和内容容器各说各话。

## Key Changes

- **Messenger 线程列表**
  - 在 `ui/src/components/MessengerContextSidebar.tsx` 中把 chat row 改成与旧 chat list 同构的交互：更大的左侧图标容器、右侧时间 hover 淡出、仅 chat 显示 hover `more` 图标并弹出 menu。
  - `New chat` 保留在列表顶端，并在 rail 的 `+` 菜单里新增 `Create new chat`。
  - system / object row 保持无 `more` 菜单，但提升图标尺寸、行高和层级，使其与 chat row 同族。

- **Messenger 信息架构**
  - 在 `server/src/services/messenger.ts` 调整 `listThreadSummaries` 的构造逻辑：默认仅返回有真实历史/待处理内容的 synthetic threads。
  - 空 org 默认仅显示 chat 入口；`approvals / budget-alerts / agent-errors / failed-runs / join-requests / issues` 都不应因“空状态描述”而出现在列表中。
  - 右侧 `MessengerPanelHeader` 去掉 system/object 页面右上角跳转按钮；这些线程不再表现成“跳往别页的中转页”。

- **Messenger 主内容区**
  - `ui/src/pages/Messenger.tsx` 中把 approvals、agent errors、budget alerts、failed runs、join requests 的主内容统一收敛到消息流语义。
  - 对象内容落在统一的 object message block 中，使 chat 与 object thread 共享相近的消息节奏与容器语言。
  - landing / empty 状态更收敛，避免大面积空洞说明块。

- **Workspace Shell / Card / Padding**
  - 调整 `ui/src/components/Layout.tsx` 与相关 CSS，收紧 card header 到 main content 的顶部间距。
  - 两栏页面也落到与三栏一致的 `workspace-main-card / workspace-context-card` 体系内，不再只有三栏页有 card 包裹。
  - Dashboard 等页面保留内部业务卡片，但页面外层也进入统一 workspace card/surface。

- **Desktop 材质与 Modal**
  - 恢复 `workspace-shell`、`surface-shell`、`app-shell-backdrop` 的 macOS 半透明模糊表现，不让主工作区退化成普通实色。
  - 修正 `ui/src/components/ui/dialog.tsx` 与 settings modal 容器的 overlay/material，使 modal 外侧区域也是真正的 translucent backdrop，而不是灰色遮罩。
  - 确保 settings modal sidebar / main / backdrop 是一套完整材质，不出现局部发灰。

- **Scrollbar**
  - 保持 `scrollbar-auto-hide` 作为默认滚动容器规范。
  - 排查并补上 Messenger middle column、main content、settings sidebar、main panel 等关键区域的 ref/class 绑定。
  - 必要时收敛全局 `*::-webkit-scrollbar` 与局部 auto-hide 的优先级，确保“静止不显示，滚动时才显示”。

## Test Plan

- 新建一个全新 org：
  - 打开 Messenger，只应看到 `New chat`，不应看到空的 approvals / alerts / errors / issues / join requests 线程。
- Messenger 左列：
  - chat row hover 时，时间淡出，右侧出现 `more` 按钮，菜单行为与旧 chat list 一致。
  - system row 无 `more` 菜单，但图标尺寸、对齐、信息层级明显更稳。
- rail `+` 菜单：
  - 出现 `Create new chat`，点击后进入 `/messenger/chat` 或等价新聊天入口。
- Messenger 右侧：
  - approvals / budget alerts / agent errors / failed runs / join requests 不再显示右上角跳转按钮。
  - 这些线程内容表现为消息流式对象块，而不是“详情页 + 空白大片区域”。
- 布局与材质：
  - Dashboard 和两栏页面都有统一 card 包裹。
  - 顶部 header 与内容区的缝隙明显缩小。
  - settings modal 外侧为半透明模糊背景。
  - macOS desktop shell 恢复毛玻璃/半透明色感。
- 滚动条：
  - 所有相关区域静止时不显示；滚动中显示；停止后自动消失。

## Assumptions

- “除了 chat 之外的这些消息类型” 按实现包含 `issues`、`approvals`、`budget-alerts`、`agent-errors`、`failed-runs`、`join-requests`，默认都走“有数据才出现”的规则。
- chat thread 才有 hover `more` 菜单；system/object thread 暂不加该菜单。
- rail `+` 的新菜单项命名采用英文现有风格：`Create new chat`。
- 这次先以现有 `doc/DESIGN.md` 为准执行，不额外先写新标准文档；如实施中发现重复原则缺口，再补文档。
