# Agent Note: Workspace 会话删除

Status: implemented

[English](2026-09-11-workspace-session-deletion.md) | 中文

## Problem

Workspace 只能注销（其会话回落到 Ungrouped），会话只能归档。没有办法永久删除会话的持久化日志，也没有办法连带会话一起删除 Workspace，陈旧或敏感历史只能越积越多。

## Decision

每一层都把删除做成显式操作，绝不作为其他变更的副作用：

- Host（`dsh-api-workspace-controller`）：`workspace/delete` 接受可选的 `cascadeSessions`，按注册顺序先永久删除全部所属会话；新增 `workspace/deleteSession`，先清注册记账，再删持久化日志。在线（已打开）的会话先经其 owner 关闭（`sessionController.closeSession`）——Agent 停止、进行中的轮次取消、会话退出 store——之后才删除日志；由其他 owner 持有的在线会话（subagent 路由、其他 Host API）没有关闭能力，仍以 `session/live` 大声拒绝。持久化失败中提到会话打开中的映射为 `session/live`，其他持久化失败原样传播。
- Host Session owner（`dsh-api-session-controller`）：Agent 控制器保留它解析出的每个 Agent 的工厂 `AgentHandle`，因此显式关闭能精确 dispose 这些 Agent 且只关一次；它从未打开过的会话没有 handle，关闭为空操作。
- 客户端对象层（`dsh-api-workspace-controller/client`）：`delete` 仅在明确指定时透传标记；`deleteSession` 不等待 Host 帧即从各投影 Workspace 与归档集合摘除该行；与归档同一条清理规则把被删的当前 selection 清空为 New Session 视图。被取代的 `dsh-client-runtime` 对象层直接删除（无引用、未挂载、upstream 已移除），不再移植。
- 浏览器（`dsh-client-ui-workspace`）：Workspace 删除对话框增加默认不勾选的级联复选框；会话行增加危险菜单项，经确认对话框（明示不可撤销）执行。失败时对话框保持打开可重试。
- 无钥匙台架（`dsh-client-connection` fixture、session-controller `FakeApiClient`）实现相同语义，无需 Host 即可跑通全流程。

级联默认关闭：省略标记即保留原有行为。

## Alternatives considered

**先删日志，再清记账。** 颠倒顺序会留出一个窗口：注册仍记账一个日志已消失的 id，分组界面将指向打不开的会话。先记账后日志保证每个中间状态都可加载。

**把删除并入归档。** 归档是保留日志的可逆 bookkeeping；删除销毁日志。合并会迫使所有归档消费方处理消失语义，也破坏归档集合的追加沿袭。

**维持在线会话拒绝删除。** Host 会让解析出的每个 Agent 活到进程结束，拒绝等于让用户打开过的任何会话都无法删除——而这正是本功能要服务的桌面流程。在显式确认的删除请求上关闭会话，只销毁这次删除本就要丢弃的进行中轮次；其 owner 不是 API Session controller 的会话仍会拒绝，Host 关不掉时门槛依然存在。

## Verification

Host spec 锁定级联顺序、经 Session owner 的先关后删、仍在线时的拒绝、与两种持久化失败映射。Session-controller spec 锁定 Agent 关闭为一次性（重复关闭与从未打开的 id 均为空操作）。Fixture spec 锁定级联删除（含归档清理）与所属／未入账／缺失会话的删除。浏览器 spec 锁定两个对话框（确认、防重复提交、失败重试）与级联复选框取值。两个聚合的 `tsc -b` 全绿。

## Consequences

- 用户可以永久清理会话与 Workspace；非级联删除 Workspace 的会话仍落入 Ungrouped。
- 删除在线会话会停止其 Agent 并取消进行中的轮次；由其他 owner 持有的在线会话仍以 `session/live` 拒绝。
- 删除当前打开的会话会落到 New Session；此后该日志永远打不开。
- 没有反删除与取消归档路径：恢复只能靠 harness 之外的备份。
- 已死的 `dsh-client-runtime` 包（零引用、不在任何 bundle 与出货包中、启动清单明示为 upstream 已移除层）直接删除而非移植：其 59 个孤立类型错误随之消失，注册表、生成目录、`pnpm-workspace.yaml` 的 pin 与本 note 已同步。其 `prebuild` 发射器（`scripts/emit-runtime-lib.mjs`）在同一次清理中移除——workspace 包已不存在，无需再发射条目。选择删除而非移植，因为移植无人执行的代码没有行为收益，反而可能凭空发明无消费者观察的语义。
