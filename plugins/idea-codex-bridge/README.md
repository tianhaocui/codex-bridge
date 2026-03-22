# Codex Bridge (IntelliJ IDEA 插件版)

## 已实现（插件内）
- ToolWindow 内直接使用 Bridge 功能（非外部 App）
- ToolWindow 固定显示在 IDEA 左侧，便于和 VSCode 侧边栏体验对齐
- 插件内使用左侧导航切换 `桥接对话` / `远程对接`，布局和交互层级对齐 VSCode 版
- A / B 都可选择 `Codex`、`Claude Code` 或 `Remote`
- Project A 默认取当前 IDEA 打开项目，也支持手动覆盖
- 从 `~/.codex/config.toml` / `~/.codex/history.jsonl` / `~/.claude/projects` 自动加载 Project / Session 下拉
- Project A / Project B / Session A / Session B 支持“下拉选择 + 手动输入（手输优先）”
- 发给 A / 发给 B / 同时发送
- 自动互发 + 阶段完成自动停止（识别最后一行 JSON 状态）
- `■` 停止按钮（真实 interrupt），并自动关闭互发
- 中文输入法兼容：有候选词时回车只确认输入，无候选词时回车发送给 A
- `Enter` 发送给 A，`Shift+Enter` 换行
- Project B / Session / 自动互发配置支持按项目持久化恢复
- 支持 `Remote` 主机 / 客户端模式
- 支持直连和 Hub 两种远端链路
- 支持 Hub 节点注册、发现、刷新和链路健康检查
- 支持复制 / 粘贴 Remote 连接配置片段，一键接入远端
- 复制配置会自动带上目标工具、项目路径和线程 ID，并支持在 Remote 页直接镜像选择导出线程
- 远端对话流支持 Local / Remote 双侧消息展示、流式输出和跨设备自动接力
- Host 模式下可把远端请求映射到本机 A 或 B，并在插件内看到完整远端对话

## 本地开发
1. 在目录执行：`./gradlew runIde`
2. 在测试 IDE 中打开菜单：`Tools -> Codex Bridge -> Open Tool Window`
3. 打包命令：
   `GRADLE_USER_HOME=.gradle-home ./.tooling/gradle-8.10.2/bin/gradle buildPlugin`
4. 纯 Kotlin 远端逻辑校验：
   `GRADLE_USER_HOME=.gradle-home ./.tooling/gradle-8.10.2/bin/gradle runRemoteSupportChecks`

## 说明
插件内直接调用本地 `codex` / `claude` CLI。
跨设备 Remote / Hub 功能已补齐到接近 VSCode：支持 Host / Client、Hub 注册发现、配置片段复制粘贴和远端 AI 对话流。
当前唯一已知工程告警是 IntelliJ Gradle Plugin 仍为 `1.x`，后续建议升级到 `2.x`。
