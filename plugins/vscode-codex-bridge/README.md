# Codex Bridge (VSCode 插件版)

在 VSCode 内桥接 A/B 两个 Codex 会话：A 固定为当前项目，B/会话可选择或手输，支持自动互发、阶段完成自动停止、手动打断，以及 `Enter` 发送给 A（`Shift+Enter` 换行）。  
使用前需先配置好 `codex`（可在终端执行 `codex --help` 验证可用）；本插件主要用于解决跨项目协作与联调问题。

## 已实现（插件内）
- Project A 固定为当前 VSCode 打开的 workspace（只读）
- 可配置 Project B，以及支持候选建议和手动输入的 Session A / Session B
- 插件面板内统一对话流
- 发给 A / 发给 B / 同时发送
- 自动互发 + 阶段完成自动停止（支持 `{"bridge_stage":"done|continue"}`）
- 实时流式输出与 Thinking 摘要展示

## 本地开发
1. 在目录执行 `npm install`
2. 执行 `npm run build`
3. VSCode -> Run and Debug -> `Run Extension`
4. 命令面板执行：`Codex Bridge: Open With Current Project`

## 说明
插件直接调用 `codex app-server --listen stdio://`，不依赖桌面 App。
