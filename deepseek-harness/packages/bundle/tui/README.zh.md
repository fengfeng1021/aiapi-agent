# @deepseek-ai/dsh-tui

[English](README.md) | 中文

`dsh --profile tui` 的交互式终端表层组合包。[`cordis.patch.yml`](cordis.patch.yml) 叠加在 [`dsh-base`](../base/README.zh.md) 之上，提供终端 persona 与工具呈现设置，并插入通过 stdio 服务的 [`dsh-sdk-jsonrpc-server`](../../sdk/server/README.zh.md)。终端前端是协议客户端；profile 进程的 stdout 只允许承载以换行分隔的 JSON-RPC 帧。

本组合包刻意不复制 base 的 agent 配置树。凭据、设置、持久会话、工程指令、技能、文件系统与 shell 工具、权限策略、压缩、目标、工作流和子代理仍全部由 `dsh-base` 持有。profile 自己的 `$DSH_HOME/profiles/tui/cordis.patch.yml` 应用在本组合包之后，共享的 `$DSH_HOME/cordis.patch.yml` 又应用在 profile 层之后，因此两者都能覆盖本组合包的配置行或插入外部插件行。终端运行时存活期间，标准 profile watcher 会重新应用这两层用户配置。

## 模型体验

间接来自完整的 `dsh-base` 组合以及后续用户插件层。本包只改变表层 persona 与传输；JSON-RPC server 不贡献模型提示词或工具。

#### KV Cache 影响

终端 persona 会进入系统提示词前缀。用户 patch 若替换 `system-prompt`，该前缀会变化并使受影响的缓存失效；传输本身没有缓存影响。

## 已知限制与暂缓事项

- **stdout 仅限协议**——用户插件若向 stdout 写入普通文本会破坏 JSON-RPC 流；诊断信息应写入 stderr。
- **人机交互呈现由终端前端负责**——本组合包只暴露当前 SDK 协议，本身不实现审批或提问提示。
