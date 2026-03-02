# Codex Bridge

Codex Bridge 是一个面向跨项目协作调试的桥接工具集。  
它把两个 Codex 会话（A/B）放到同一视图中，支持手动或自动互发，帮助你在两个项目、两个上下文之间快速协同。

当前包含三个版本：
- `macOS App`（SwiftUI 桌面应用）
- `VSCode 插件`
- `IntelliJ IDEA 插件`

## 为什么做这个项目

当你需要同时推进两个项目（例如主服务与 SDK、前后端联调、跨仓修复）时，常见痛点是：
- 对话分散在不同窗口，很难跟踪阶段推进
- A/B 会话之间转述成本高，容易丢信息
- Diff、回复、阶段状态不在一个上下文里

Codex Bridge 的目标是把这些动作整合到一条协作流里。

## 核心能力

- 双侧会话：`发给A` / `发给B` / `同时发送`
- 自动互发：A 回复可自动转发给 B（反之亦然）
- 阶段完成约束：支持单行 JSON 协议识别  
  - `{"bridge_stage":"continue"}`
  - `{"bridge_stage":"done"}`
- 实时状态：显示 A/B 是否忙碌、生成中动画、可一键打断
- 会话复用：按 `session_id` 续接历史会话
- 项目/会话下拉：自动读取本机 Codex 配置与历史进行筛选

## 仓库结构

- `Sources/CodexBridgeApp/`：macOS App（Swift）
- `plugins/vscode-codex-bridge/`：VSCode 插件（TypeScript）
- `plugins/idea-codex-bridge/`：IDEA 插件（Kotlin）
- `LICENSE`：Apache License 2.0

## 环境要求

- 已安装并可执行 `codex` CLI
- 已完成 Codex 登录认证
- 推荐先验证：

```bash
codex --version
codex app-server --help
```

## 快速开始

### 1) macOS App

```bash
cd /Users/wulingren/codex-bridge-macapp
swift run
```

或用 Xcode 打开：

```bash
open /Users/wulingren/codex-bridge-macapp/Package.swift
```

### 2) VSCode 插件

```bash
cd /Users/wulingren/codex-bridge-macapp/plugins/vscode-codex-bridge
npm install
npm run build
```

在 VSCode 中使用 `Install from VSIX` 安装打包产物（如需发布请用 `vsce package`）。

### 3) IDEA 插件

```bash
cd /Users/wulingren/codex-bridge-macapp/plugins/idea-codex-bridge
GRADLE_USER_HOME=.gradle-home ./.tooling/gradle-8.10.2/bin/gradle clean buildPlugin
```

安装方式：
- `Settings` -> `Plugins` -> `⚙` -> `Install Plugin from Disk...`
- 选择 `build/distributions/*.zip`

## 使用建议

1. A 固定当前项目，B 选择目标项目
2. 优先通过下拉选择会话；手动输入会覆盖下拉选择
3. 开启“自动互发 + 阶段完成自动停止”时，建议在系统提示中明确要求输出协议 JSON
4. 大改动场景建议固定一个“阶段目标”，每轮只推进一个可验收点

## 常见问题

- 报错 `Cannot run program "codex"`：  
  IDEA 进程环境找不到 `codex`，请确认 `PATH` 或配置 `CODEX_BIN`

- 报错 `codex app-server 已断开连接`：  
  通常是 CLI 环境依赖问题（例如 shell 环境与 IDE 环境不一致）。先在终端验证 `codex app-server --help` 是否正常。

- 会话下拉为空：  
  检查 `~/.codex/config.toml` 与 `~/.codex/history.jsonl` 是否存在且有有效记录。

## 许可证

本项目基于 **Apache License 2.0** 开源，详见 [LICENSE](./LICENSE)。
