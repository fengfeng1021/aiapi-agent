# Agent Note：Codex 子代理委派

狀態：已實作

[English](2026-09-12-codex-subagent-delegation.md) | 中文

## 問題

Codex 驅動的回合（`CodexLoopAgent`）無法 spawn 或 fork 子代理：Codex 迴圈構造自己的 agent 型別，`delegate` 能力從未跟上，而且不帶 MCP 工具的 `turn/start` 讓模型無法回呼宿主的子代理服務。

## 決策

委派走 `thread/start.dynamicTools`（背後是交握時 daemon 宣告的 `experimentalApi` 客戶端能力），而不另起 MCP 橋：

- `packages/core/agent-loop/src/codex-delegation.ts`（新增）：`delegateToolSpec()` 發布唯一的 `delegate(task, provider?)` 函式工具；`parseDelegateArguments()` 校驗模型 JSON（task 非空、`spawn` 為預設、`fork` 需顯式、未知 provider 大聲拒絕）；`executeDelegation()` 經由宿主子代理服務、帶著所屬回合的取消訊號執行，把 completed 映射為成功結果，其餘結局（拒絕啟動、基礎設施故障、非完成停止、空輸出）一律映射為模型可讀的失敗文字。
- `codex-server.ts`：每次 `thread/start` 都發布該 spec；`handleServerRequest` 把 `item/tool/call` 路由給所屬回合的 `CodexThreadToolOwner`，以 owner 結果原文直接回答請求（`{ contentItems, success }`——按 request id 配對、不回顯 id、不轉換大小寫，已對真實 app-server 證實）。無 thread id 或無存活所屬回合的呼叫以 `-32603` 大聲失敗。
- `codex-agent.ts`：每個 Codex 回合安裝一個 `toolOwner`，經由回合訊號對 `loopCtx` 子代理執行 `delegate`，並把 `dynamicToolCall` 項目記為 `tool/call`＋`tool/result` 會話行（失敗行帶 `isError`）。
- 線上雙向一律 camelCase（`callId` 而非 `toolCallId`；參數原文送出）——已用 codex 0.149.1 的真實流量釘住。

## 考慮過的替代方案

**另起 MCP server 把委派橋進 thread。** 為單一工具每回合多跑一個 server 進程，增加生命週期、授權與故障面；`dynamicTools` 正是 app-server 為此預留的原生槽位，且 live probe 證實模型會呼叫它、收到直接回應後繼續。

**以獨立 `response` 訊息回答 `item/tool/call`。** 真實流量顯示僅直接 JSON-RPC 回應就足以讓回合繼續（模型逐字複述結果且回合完成）；額外訊息是未經承認的協議發明。

**移植已刪除的 `dsh-client-runtime` 層來做委派。** 無關：該包零引用、未掛載、上游已移除（見 workspace-session-deletion note）；委派只需要 `dsh-subagent` 服務加迴圈上下文。

## 驗證

- `codex-delegation.spec.ts` 釘住 spec 形狀、參數解析／預設／拒絕、provider 路由、結果映射（完成、非完成、空輸出、啟動／結果故障）與取消傳遞。
- `codex-server-dynamic-tool.spec.ts` 對腳本化 app-server 釘住完整線上往返（owner 路由、結果原文、無存活回合拒絕、owner 失敗拒絕且回合不中斷）。
- `codex-thread-instructions.spec.ts` 釘住 `thread/start` 上的 `dynamicTools` 發布。
- `codex-agent-dynamic-tool.spec.ts` 經由真實 `CodexLoopAgent` 組合釘住 `tool/call`＋`tool/result` 會話行。
- 對 codex 0.149.1 的真實回合強迫一次 `delegate` 呼叫端到端：模型呼叫了它，owner 回答了，模型逐字回報結果（`PINEAPPLE`）。
- `tsc -b tsconfig.host.json` 全綠。

## 後果

- 每個 Codex 回合現在都提供 `delegate`；`spawn` 起全新子任務，`fork` 讓子任務繼承對話。
- Codex 回合要求組合中有 `dsh-subagent` 服務：缺席時工具呼叫大聲失敗（`subagent service is unavailable`），不會卡死。
- `CodexTurnItem` 新增真實存在的 `status` 欄位；`DynamicToolCallParams` 採用線上的 `callId`。
