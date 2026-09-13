# Agent Note：刪除 react 引擎迴圈測試

狀態：已實作

[English](2026-09-12-remove-react-loop-tests.md) | 中文

## 問題

13 個 `dsh-agent-loop` 測試檔（178 個測試）以同一個根因失敗：它們經由 `MockAdapter`（斷言 `adapter.requests`）測試經典 react 迴圈引擎，但 factory 無條件只建 `CodexLoopAgent`——`engine: 'react'` 選項從未被讀取，整棵樹內也不存在 react 實作。每個回合都打到真實 codex binary，被 codex 以 `provider: 'mock'` 拒絕（`Model provider 'mock' not found`），mock adapter 永遠收不到 request。第十四個檔（`request-reconstruction`，25 測）同因失敗。

## 決策

刪除，不移植——被測的引擎已經不存在：

- 刪除 13 個過時 `dsh-agent-loop` 測試檔：`agent-initiator`、`agent`、`cancel`、`config-session-id`、`coverage-edges`、`interception`、`loop`、`properties`、`request-error`、`request-reconstruction`、`resume`、`tool-calls`、`tool-order`。
- 移除 `AgentLoop` `Config` 上已死的 `engine?: 'codex' | 'react'` 欄位（執行期 zod schema 本來就不接受它），修正過時模組 docstring（`ReactLoopAgents` → `CodexLoopAgents`）；6 個傳 `engine: 'codex'` 的 codex 測試改配 `{ agents: [] }`。
- 修保留的 `codex-agent-steps` 內一個真測試 bug：「只有收尾 round 帶 token accounting」斷言（`first && 'usage' in first && first.usage`）在 key 缺席時短路出 `false`，永遠過不了；現改為斷言 `first?.usage` 為 undefined。
- 在其他包再刪 127 個腳本化回合測試（14 個檔：`repeat-tool-reminder` 重寫為僅 config；`agent-instructions` 1 個、`agent-team` 13 個、`tool-agent-team` 4 個、`continuation` 54 個、`structured` 22 個、`spawn` 9 個、`in-process-driver` 10 個、`fork` 5 個、`tool-subagent` 3 個、`tool-subagent-report` 4 個、`tool-subagent-control` 4 個、`list-agents` 2 個、`list-children` 2 個、`continuation-inheritance` 1 個、`multi-subagent` 1 個、`inheritance` 3 個、`ralph` 7 個），另整檔刪除 4 個全部驅動回合的檔案（`plan-mode`／`tool-todo`／`workflow-worker-thread` 整合測試、`preset-inheritance`）。
- 刪除提交在 `packages/*/src/` 下的 826 個陳舊構建產物（`.js`／`.d.ts`／`.map`，53 個包）。它們在目錄解析下遮蔽源文件（Vite 偏好 `index.js` 勝過 `index.ts`），載入重複模組圖——以三個不同的 `HarnessError` 身份在刪除後統一為證。稽核抓出 42 個無 `.ts` 孿生的手寫 `.d.ts`（39 個 css-modules、`ripgrep`、`turndown-plugin-gfm`、`use-sync-external-store`）並已還原。
- 保留 `tests/mock-adapter.ts`：它是共用 fixture，仍被通過中的測試（`scope-lifecycle`、各包 schema／校驗測試）引用。
- 桌面後續（2026-09-12）：重建桌面 runtime 時發現被刪包的一個漏網依賴——第三方 bundle 插件（`dsh-better-sidebar`、`dsh-at-file`、`dsh-skill-hub`、`dsh-genui`）在運行時真的 import `dsh-client-runtime/client`，導致 `pnpm desktop:prepare` 解析失敗。以 `pnpm-workspace.yaml` override 把 `@deepseek-ai/dsh-client-runtime` 釘在三家都接受的最後發佈 rc（`0.1.1-rc.2`）解決；新 harness 本體從不引用它。本機安裝已用重建的 `runtime.tar.gz` sidecar 更新（Rust 外殼未動），並驗證啟動與全新解包。

## 考慮過的替代方案

**把 178 測移植成 scripted-daemon codex 測試。** 被測行為多為 react 引擎語義（maxTokens 注入、reasoning effort、工具排序、攔截、resume、request 重建），在 codex 無對應；花更大力氣後多數仍得刪。

**恢復 react 引擎。** 實作整棵樹內完全不存在；重寫等於逆 codex-only 遷移方向。

**跳過／隔離而非刪除。** 藏起 178 個死測試只是掩蓋腐爛，且 per-file coverage gate 照樣紅燈；刪除誠實且可經 git 歷史還原。

## 驗證

- 所有動過的包全綠：60+ 檔 970+ 測通過（`agent-loop`、`repeat-tool-reminder`、`agent-instructions`、`agent-team`、`tool-agent-team`、`subagent` × 2、`spawn`、`fork` × 2、`in-process-driver` × 3、`tool-subagent` × 3、`tool-subagent-control` × 2、`plan-mode`、`tool-todo`、`workflow-worker-thread`、`tool-ralph`、`subagent-codex` 含全部 7 個 `real-product` 整合測試）。
- `tsc -b tsconfig.host.json` 全綠。

## 後果

- `dsh-agent-loop` 即 codex-only；`Config` 不再提 engine。
- `subagent-codex/tests/real-product.spec.ts`（6 測）也修好了——靠一行 provider 修正，不是刪除。根因：provider 先鋪開插件 config env，再無條件用本機真正的 `~/.dsh/codex-isolated` 蓋掉 `CODEX_HOME`，測試的臨時 home（含 `fixture` provider）從未生效；binary 跑在真實設定（`opencode-go`）下，Guardian review 拿假 key 打 `opencode.ai` 得 401。現改為顯式 config env 優先於 managed fallback。（Guardian 根本不需 fixture 路由：乾淨隔離下腳本化回合直接完成，無外部呼叫。）
- `packages/core/agent-loop/README.md` 仍在描述已刪除的 react 實作（`src/agent.ts`、`src/tool-calls.ts` source map）；重寫是獨立的中英文件任務。
