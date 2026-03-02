# Codex Bridge (IntelliJ IDEA 插件版)

## 已实现（插件内）
- ToolWindow 内直接使用 Bridge 功能（非外部 App）
- Project A 固定为当前 IDEA 打开项目路径
- 从 `~/.codex/config.toml` / `~/.codex/history.jsonl` 自动加载 Project / Session 下拉
- Project B / Session A / Session B 支持“下拉选择 + 手动输入（手输优先）”
- 发给 A / 发给 B / 同时发送
- 自动互发 + 阶段完成自动停止（识别最后一行 JSON 状态）
- `■` 停止按钮（真实 interrupt），并自动关闭互发
- `Enter` 发送给 A，`Shift+Enter` 换行
- Project B / Session / 自动互发配置支持按项目持久化恢复

## 本地开发
1. 在目录执行：`./gradlew runIde`
2. 在测试 IDE 中打开菜单：`Tools -> Codex Bridge -> Open Tool Window`

## 说明
插件内直接调用 `codex app-server --listen stdio://`。
