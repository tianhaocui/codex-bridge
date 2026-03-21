# Codex Bridge (IntelliJ IDEA 插件版)

## 已实现（插件内）
- ToolWindow 内直接使用 Bridge 功能（非外部 App）
- ToolWindow 固定显示在 IDEA 左侧，便于和 VSCode 侧边栏体验对齐
- A / B 都可选择 `Codex` 或 `Claude Code`
- Project A 默认取当前 IDEA 打开项目，也支持手动覆盖
- 从 `~/.codex/config.toml` / `~/.codex/history.jsonl` / `~/.claude/projects` 自动加载 Project / Session 下拉
- Project A / Project B / Session A / Session B 支持“下拉选择 + 手动输入（手输优先）”
- 发给 A / 发给 B / 同时发送
- 自动互发 + 阶段完成自动停止（识别最后一行 JSON 状态）
- `■` 停止按钮（真实 interrupt），并自动关闭互发
- 中文输入法兼容：有候选词时回车只确认输入，无候选词时回车发送给 A
- `Enter` 发送给 A，`Shift+Enter` 换行
- Project B / Session / 自动互发配置支持按项目持久化恢复

## 本地开发
1. 在目录执行：`./gradlew runIde`
2. 在测试 IDE 中打开菜单：`Tools -> Codex Bridge -> Open Tool Window`
3. 打包命令：
   `GRADLE_USER_HOME=.gradle-home ./.tooling/gradle-8.10.2/bin/gradle buildPlugin`

## 说明
插件内直接调用本地 `codex` / `claude` CLI。  
当前已完成 Codex / Claude 双侧桥接与最近会话下拉，跨设备 Remote / Hub 能力仍在补齐中。
