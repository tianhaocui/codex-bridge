# LAN Multi-Agent Bridge Design

## 1. Background

`codex-bridge` 当前更偏向单机内的双会话桥接：

- Project A / Project B
- Session A / Session B
- 本地消息互发
- `bridge_stage` 阶段完成控制

这个模型适合在一台机器内做 AI ↔ AI 协作，但当目标变成“让插件在局域网内和其他机器的 AI 交互”时，现有抽象层级不够。

需要把系统从“本机双会话桥接”升级为“多节点、多 Agent、多 Session 的局域网桥接工作台”。

---

## 2. Goals

### 2.1 Primary goals

1. 允许插件连接局域网中的其他机器。
2. 允许查看远端机器上的可用 Agent / Session。
3. 允许把本地消息发送给远端 AI，并接收流式回复。
4. 允许建立本地与远端、远端与远端之间的桥接链路。
5. 保留现有 `autoRelay`、`interrupt`、`bridge_stage=done` 等能力。
6. 在 VSCode / IDEA 插件 UI 中统一呈现。

### 2.2 Non-goals for MVP

以下内容不作为第一版必须目标：

1. 公网穿透
2. 多租户协作
3. 复杂权限系统
4. 端到端加密体系
5. 跨组织共享
6. 多跳自动路由

---

## 3. Design principles

1. **先直连，后扩展到 Hub**：第一版优先支持局域网内点对点连接。
2. **先手动配置，后自动发现**：先保证稳定可用，再补 mDNS/Bonjour 自动发现。
3. **插件轻、服务层稳**：IDE 插件负责 UI 与操作，网络通信和会话适配放到 bridge daemon。
4. **兼容现有本地桥接能力**：新模型应能兼容当前 A/B 本地双会话逻辑。
5. **协议优先于实现细节**：先定义清晰的数据模型与 API，再推进 UI 和代码改造。
6. **默认仅局域网暴露**：不默认暴露公网，避免误开放。

---

## 4. Target architecture

整体建议拆成三层：

### 4.1 IDE Plugin Layer

负责：

- VSCode / IDEA UI
- 节点选择
- 会话选择
- 路由控制
- 消息展示
- 调用本地或远端 bridge API

### 4.2 Bridge Daemon Layer

每台机器运行一个轻量 bridge daemon，负责：

- 节点身份
- Agent 适配
- Session 列表查询
- 消息发送
- 流式输出转发
- 中断控制
- 局域网发现
- 鉴权与配对

### 4.3 Agent Adapter Layer

为不同 AI 运行时提供适配器：

- OpenClaw
- Codex
- Claude Code
- 自定义本地 agent
- 未来可扩展到 Ollama / OpenAI-compatible / MCP 风格接入

---

## 5. Recommended topology

## 5.1 Phase 1: Direct LAN connection

每台机器运行一个 bridge daemon。
插件可直接连接：

- 本机 daemon
- 局域网内其他机器上的 daemon

优点：

- 简单
- 易调试
- 易落地
- 易和现有插件结构集成

### 5.2 Phase 2: Optional Hub mode

后续可引入一个局域网中枢：

- 所有节点注册到 hub
- 插件通过 hub 发现和路由节点
- 支持更复杂的多机编排

但 **Hub 模式不建议作为第一版前提**。

---

## 6. Core domain model

现有的 `projectAPath / projectBPath / sessionA / sessionB` 建议逐步演进为以下模型：

### 6.1 BridgeNode

表示一台机器或一个 bridge endpoint。

建议字段：

- `id`
- `name`
- `host`
- `port`
- `protocol`
- `authMode`
- `paired`
- `status` (`online` / `offline` / `busy`)
- `latencyMs`
- `version`
- `capabilities`
- `lastSeenAt`

### 6.2 BridgeAgent

表示某个节点上的一个 AI agent 实例。

建议字段：

- `id`
- `nodeId`
- `kind` (`openclaw` / `codex` / `claude-code` / `custom`)
- `displayName`
- `status`
- `supportsStreaming`
- `supportsInterrupt`
- `supportsRelay`

### 6.3 BridgeSession

表示某个 agent 上的具体会话。

建议字段：

- `id`
- `nodeId`
- `agentId`
- `cwd`
- `projectName`
- `title`
- `busy`
- `lastActiveAt`
- `summary`

### 6.4 BridgeRoute

表示一条桥接链路。

建议字段：

- `id`
- `sourceNodeId`
- `sourceAgentId`
- `sourceSessionId`
- `targetNodeId`
- `targetAgentId`
- `targetSessionId`
- `autoRelayEnabled`
- `stopOnStageDone`
- `stageDoneMarkers`
- `status`

### 6.5 RemoteBridgeMessage

表示消息和流式事件。

建议字段：

- `id`
- `routeId`
- `nodeId`
- `sessionId`
- `role`
- `side`
- `text`
- `turnId`
- `streaming`
- `createdAt`
- `metadata`

---

## 7. Communication protocol

推荐采用：

- **HTTP**：用于查询、配置、发送命令
- **WebSocket**：用于流式消息、状态推送、节点事件

### 7.1 Suggested HTTP endpoints

#### Node info
- `GET /api/v1/node/self`
- `GET /api/v1/node/capabilities`

#### Sessions and agents
- `GET /api/v1/agents`
- `GET /api/v1/sessions`
- `GET /api/v1/sessions/:id`

#### Messaging
- `POST /api/v1/messages/send`
- `POST /api/v1/messages/interrupt`

#### Routes
- `GET /api/v1/routes`
- `POST /api/v1/routes`
- `PATCH /api/v1/routes/:id`
- `DELETE /api/v1/routes/:id`

#### Pairing and auth
- `POST /api/v1/pair`
- `POST /api/v1/unpair`
- `GET /api/v1/peers`

### 7.2 Suggested WebSocket channels/events

可统一为一个 WS 连接，推送事件类型：

- `node.status`
- `session.updated`
- `message.delta`
- `message.completed`
- `route.updated`
- `route.stopped`
- `error`

---

## 8. Node discovery

建议分两步做：

### 8.1 Step 1: Manual node registration

用户手动录入：

- name
- host
- port
- token
- optional note

这是第一版必须支持的模式。

### 8.2 Step 2: mDNS / Bonjour discovery

第二步加入自动发现能力：

- 服务类型建议：`_codexbridge._tcp.local`

广播信息可包含：

- node name
- service port
- protocol version
- optional capabilities summary

自动发现只负责“发现”，不应自动信任。仍需显式配对/确认。

---

## 9. Security model

局域网不等于安全，第一版至少要有基础鉴权。

### 9.1 MVP security requirements

1. 每个 bridge daemon 具备本机身份。
2. 写操作必须带 token。
3. 默认只监听局域网地址或显式指定地址。
4. 默认不暴露公网。
5. UI 上明确显示当前连接是否已认证。

### 9.2 Better pairing model

后续可增强为：

1. 首次配对码
2. 节点指纹
3. 已信任节点列表
4. 可撤销授权
5. Token 轮换

### 9.3 Security UX requirements

插件 UI 中应可见：

- 当前目标节点
- 认证状态
- 是否加密/受保护
- 最近错误
- 是否为手动添加节点

---

## 10. UI design implications

## 10.1 Current UI limitation

当前 UI 核心仍偏向：

- Project A / B
- Session A / B
- 单机桥接

这在多机场景下会越来越难扩展。

### 10.2 Recommended UI evolution

建议把 UI 升级为“Node-aware workspace”。

#### Left panel

- Local Node
- Remote Node / Saved Nodes
- Agent picker
- Session picker
- Bridge policy
- Discovery status

#### Right panel

- Unified conversation timeline
- Connection / network state
- Stream state
- Composer

#### Message card metadata

建议在消息上显示：

- node name
- session label
- agent kind
- local / remote tag
- streaming / completed state

### 10.3 UI priorities

优先保证：

1. 节点和会话来源清晰
2. 正在和哪台机器通信清晰
3. 自动 relay 是否开启清晰
4. 断线、超时、认证失败清晰

---

## 11. Compatibility with existing codex-bridge concepts

为降低重构风险，建议采用兼容层策略：

### 11.1 Keep existing concepts as shorthand

当前本地模式下：

- `Project A` = Local Node default workspace
- `Project B` = Local Node alternate workspace
- `Session A/B` = Local Node sessions

### 11.2 Introduce generalized model underneath

UI 可暂时保留 A/B 表达，但内部模型逐步切到：

- source node/session
- target node/session
- route policy

这样不会一次性把现有逻辑全部推翻。

---

## 12. MVP scope

第一版建议只做下面这些：

1. 本机 bridge daemon 抽象
2. 手动添加远端节点
3. 查询远端 agent / session 列表
4. 给远端 session 发消息
5. 接收流式回复
6. 支持 interrupt
7. 支持 `bridge_stage=done`
8. 保存最近节点与最近连接

### 12.1 Explicitly deferred

延期项：

1. mDNS 自动发现
2. Hub 模式
3. 多人协作
4. 跨公网安全访问
5. 复杂 ACL
6. 多跳自动 relay 编排

---

## 13. Implementation roadmap

### Phase 0: Design and refactor groundwork

1. 定义节点/agent/session/route 数据模型
2. 在插件中引入新的类型层
3. 把现有 A/B 桥接逻辑收敛为统一 route 抽象

### Phase 1: Local daemon abstraction

1. 为本机交互加一个统一 daemon API
2. 让 VSCode / IDEA 都通过统一接口访问本机 session
3. 保持现有 UI 能跑

### Phase 2: Remote node support

1. 手动添加远端节点
2. 拉取远端 sessions
3. send / interrupt / stream 打通
4. 增加基础连接状态与错误提示

### Phase 3: Better UX

1. 节点列表
2. 已保存连接
3. 会话过滤
4. 网络状态展示
5. 统一 VSCode / IDEA UI

### Phase 4: Discovery and advanced routing

1. mDNS / Bonjour discovery
2. 自动刷新节点状态
3. 更复杂路由
4. optional hub mode

---

## 14. Risks

### 14.1 Conceptual risk

如果继续把核心模型绑死在 `Project A/B` 上，后续扩展到多机时会越来越别扭。

### 14.2 Product risk

如果第一版同时做：

- 自动发现
- 配对
- 多机路由
- 新 UI
- VSCode + IDEA 双端改造

范围会失控。

### 14.3 Security risk

如果直接允许局域网裸连，后续很容易留下默认开放的安全坑。

### 14.4 Protocol risk

如果先写死实现、后补协议，后续每增加一种 agent/runtime 都会导致插件层重复改造。

---

## 15. Recommendation

推荐采用下面的策略推进：

1. **先写清楚协议和类型**
2. **先做本机 daemon 抽象**
3. **先支持手动添加远端节点**
4. **先打通 send / stream / interrupt / stage done**
5. **最后再把 UI 全面升级成多节点工作台**

一句话总结：

> 第一版不要试图一次做成“局域网 AI 编排平台”，而是先把 `codex-bridge` 升级成“可连接局域网远端节点的桥接工作台”。

---

## 16. Suggested next deliverables

下一步建议产出以下文档/代码之一：

1. 协议草案（HTTP + WebSocket）
2. TypeScript 类型定义草案
3. VSCode / IDEA 的多节点 UI 草图
4. bridge daemon 的目录结构设计

如果继续推进开发，建议优先顺序为：

1. 协议草案
2. 类型定义
3. 本机 daemon abstraction
4. 远端节点 MVP
