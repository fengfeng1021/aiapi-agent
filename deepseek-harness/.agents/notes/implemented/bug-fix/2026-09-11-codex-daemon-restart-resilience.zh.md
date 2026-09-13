# Agent Note: Codex daemon 重启韧性

Status: implemented

[English](2026-09-11-codex-daemon-restart-resilience.md) | 中文

## Problem

两个 daemon 生命周期缺口把一次短暂的 app-server 死亡变成永久卡死的 Codex 会话。生产实测：app-server 退出（-1）后 daemon 重拉，但之后每一轮都因缓存的 thread id 报 `thread not found`——重试、新提示、重开本轮全部失败，直到整个 Host 进程重启。

1. `CodexLoopAgent` 永久缓存 Codex thread id。而 app-server 的 thread 只活在服务进程内存里（`turn/start` 只查内存表，不读盘），所以任何 daemon 重启（崩溃、被杀、Host 重启）都会让所有缓存 id 永久失效，agent 却每轮重试这个死 id。
2. `CodexAppServerDaemon.ensureStarted` 闩死失败的 start promise：一次启动失败毒化所有后续调用者，它们永远等同一个 rejection，不再重试。

## Decision

- daemon 把 code 为 `-32600` 且消息含 `thread not found` 的 `turn/start` 拒绝映射为带 stale id 的类型化 `CodexThreadGoneError`。code 锚定匹配（invalid request），消息收窄到 thread 缺失而非其他 malformed 请求。
- agent 在 attempt 预算内捕获自己当前 id 的该错误：丢掉旧 id、建新 thread、用同一输入重跑。命名其他 id 的 miss、其他失败、预算内第二次 miss 都大声失败——恢复永不循环。
- 失败的 `start()` 清掉 `startPromise`（按 identity 比对，绝不误伤并发成功的启动），让下一个调用者重试而不是等一个死的 rejection。

## Alternatives considered

**miss 时从盘里 reload thread。** app-server 故意只把 live thread 放内存（盘上是 rollout，不是可运行句柄）；教 daemon 复活它们等于复制 server 的 session 生命周期。建新 thread 更便宜且永远一致。

**重生后重试旧 id。** 新进程无论问多少次都不认识旧 id；不重建的重试只烧 attempt 预算。

**只按消息文本匹配。** 裸子串匹配会把无关的 `-32600` 失败误判为 thread 丢失，静默抛弃活 thread。code+message 双重匹配让分类器保持收窄。

## Verification

Agent spec 锁定自愈一次后重跑（调用顺序、thread id、completed turn 与恢复答案）、连续两次 miss 大声失败、外部 id 与无关错误透传、启动失败后重试（两次不同错误证明是两次独立尝试，无闩锁）。Wire spec 用脚本化 app-server 锁定映射：thread-miss 变 `CodexThreadGoneError`，其他 invalid-request 与其他 code 的拒绝以 `JsonRpcResponseError` 原样透传。

## Consequences

- daemon 重启现在最多花一次 turn attempt 和一个新 Codex thread（旧 Codex 侧上下文不继承），永不卡死会话。
- `CodexThreadGoneError` 是 stale thread id 的唯一词汇；新调用方必须重建处理，绝不重试旧 id。
