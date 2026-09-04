/**
 * Localized copy for the Mixture-of-Agents (MoA) settings page.
 */

export const zh = {
  nav: 'MoA 多模型協同',
  title: 'Mixture of Agents (MoA) 多模型盲區協同',
  subtitle: '打破單一模型訓練盲區：透過 1~3 個不同背景模型互相補位，以三段檔位（效率/均衡/質量）實現極簡、低成本、高質量的智慧調度。',
  enabled: '啟用 MoA 盲區協同',
  enabledHint: '開啟後，會話將依據選定檔位自動進行模型互補與交叉校驗',
  
  // 3-Tier Slider
  sliderTitle: '協同檔位調度 (Collaboration Mode)',
  modeSpeed: '⚡️ 效率優先',
  modeSpeedTagline: '又快又不出問題 · 不精雕細琢',
  modeSpeedDesc: '兼顧極速響應與基礎防呆：由模型快速起草，同行模型秒級掃描排版遮擋、邊界超出或基礎 Bug，不進行多餘爭論，以最快速度交付可用方案。',
  modeBalanced: '⚖️ 均衡協同 (推薦)',
  modeBalancedTagline: '快速前提下保證最高質量',
  modeBalancedDesc: '多模型雙向互補：一個側重功能實作，一個側重邊界防護與健壯性，在保持快速交付的同時消除單一模型訓練盲區。',
  modeQuality: '🏆 質量攻堅',
  modeQualityTagline: '疑難難題或追求極致時三方合力攻堅',
  modeQualityDesc: '攻克單一模型始終修不好的頑疾 Bug、複雜架構或無時間壓力時，3 個平等模型各自提出見解並互相質疑討論，三方合力達到最高質量。',
  
  // Model Slots (Equal Peers)
  slotsTitle: '協同模型席位 (1 ~ 3 個平等專家席位)',
  slotsSubtitle: '三席模型地位完全平等，無論選用同級模型還是不同廠牌，皆以不同訓練視角互相消除盲區',
  slot1Title: '協同席位 1',
  slot1Desc: '提供第一實作視角，參與快速起草與平行思路探索',
  slot2Title: '協同席位 2',
  slot2Desc: '提供互補視角，防範樣式遮擋、邊界超出與隱蔽邏輯陷阱',
  slot3Title: '協同席位 3',
  slot3Desc: '提供第三研判視角，在質量模式下與前兩席合力攻堅疑難盲區',
  
  // Metrics & Flow
  tokenMultiplierLabel: '預期 Token 消耗',
  speedEstimateLabel: '預期響應速度',
  workflowFlowLabel: '動態協同流水線',
  changeModel: '更換模型',
  activePresetLabel: '當前作用方案',
  defaultBadge: '預設方案',
  customBadge: '自訂',
  builtInBadge: '內建方案',
  newPreset: '新增協同方案',
  editPreset: '編輯方案',
  copyPreset: '複製方案',
  deletePreset: '刪除方案',
  setDefault: '設為預設',
  liveTest: '即時協同測試',
  pipelineView: '協同拓撲架構',
  presetsView: '預設方案列表',
  
  // Pipeline nodes
  fanOutLayer: 'Layer 1: 參考模型群 (Reference Models)',
  fanOutDesc: '多模型並行接收 Prompt 獨立生成多維度見解',
  aggregatorLayer: 'Layer 2: 裁判/聚合模型 (Aggregator Model)',
  aggregatorDesc: '交叉研判所有參考模型回答，過濾矛盾與幻覺，合成最優解',
  finalOutput: '最終回答輸出 (Final Synthesized Response)',
  
  // Card details
  refModelsCount: '個參考模型並行',
  aggregatorModelLabel: '聚合裁判',
  refTemp: '參考溫度',
  aggTemp: '聚合溫度',
  maxTokens: 'Token 上限',
  
  // Modal form
  presetId: '方案 ID',
  presetName: '方案名稱',
  presetDescription: '方案描述',
  refModelsConfig: '參考模型配置 (Reference Models)',
  addRefModel: '新增參考模型',
  selectProvider: '選擇供應商',
  selectModel: '選擇模型',
  aggregatorConfig: '聚合模型配置 (Aggregator Model)',
  hyperparameters: '超參數微調',
  refTemperatureLabel: '參考模型溫度 (Reference Temperature)',
  aggTemperatureLabel: '聚合模型溫度 (Aggregator Temperature)',
  maxTokensLabel: '最大輸出 Token (Max Output Tokens)',
  save: '儲存方案',
  cancel: '取消',
  deleteConfirmTitle: '確認刪除此 MoA 方案？',
  deleteConfirmDesc: '刪除後將無法恢復，請確認是否繼續。',
  
  // Playground
  playgroundTitle: 'MoA 即時協同測試場',
  playgroundSubtitle: '輸入測試問題，即時檢視多個 Reference 模型的並行輸出與 Aggregator 的最終綜合研判過程。',
  promptPlaceholder: '請輸入您想測試的複雜編程、演算法或深度推理問題...',
  runTest: '執行 MoA 協同測試',
  running: '協同推理中...',
  examplePrompts: '推薦測試問題：',
  examplePrompt1: '請設計一個高效能、無鎖且支援並發過期的 Rust LRU 快取結構。',
  examplePrompt2: '比較深入分析 Transformer 架構中 Multi-Head Attention 與 Mixture of Experts 的優缺點。',
  examplePrompt3: '請寫出一個能自動偵測並修復分散式交易死鎖的演算法方案。',
  refOutputsTitle: 'Layer 1: 各參考模型獨立輸出',
  aggOutputTitle: 'Layer 2: Aggregator 綜合裁決與最終解答',
  synthesisSummary: '💡 綜合評語：Aggregator 已綜合交叉驗證上述參考觀點，過濾細微幻覺並完成最終代碼重構與結論總結。',
  
  // Validation
  nameRequired: '方案名稱為必填項',
  refModelsMin: '請至少添加 1 個參考模型（建議 2~4 個）',
  aggregatorRequired: '請指定聚合模型',
}

export const en = {
  nav: 'MoA Multi-Agent',
  title: 'Mixture of Agents (MoA) Blind-Spot Elimination',
  subtitle: 'Break individual model training blind spots: pair 1~3 diverse models to complement each other with a simple 3-stage slider (Speed / Balanced / Quality).',
  enabled: 'Enable MoA Blind-Spot Synergy',
  enabledHint: 'When enabled, turns intelligently collaborate across complementary models based on your selected tier.',
  
  // 3-Tier Slider
  sliderTitle: 'Collaboration Tier',
  modeSpeed: '⚡️ Speed Priority',
  modeSpeedTagline: 'Fast & Bug-free · No Over-polishing',
  modeSpeedDesc: 'Balanced speed and baseline sanity: one model drafts quickly while a peer model scans for overlapping styles, bounds overflow, or basic bugs. Rapid delivery without redundant debate.',
  modeBalanced: '⚖️ Balanced Synergy (Recommended)',
  modeBalancedTagline: 'Maximum Quality at High Velocity',
  modeBalancedDesc: 'Dual-peer complementarity: one focuses on functional implementation, the other on boundary defense and robustness, eliminating blind spots while maintaining swift responsiveness.',
  modeQuality: '🏆 Peak Quality',
  modeQualityTagline: 'Tri-Peer Deep Ensemble for Stubborn Problems',
  modeQualityDesc: 'For stubborn bugs that a single model fails to fix, complex architectures, or unconstrained time: 3 equal models debate and cross-examine to achieve peak code quality.',
  
  // Model Slots (Equal Peers)
  slotsTitle: 'Collaborative Model Slots (1 ~ 3 Equal Peer Slots)',
  slotsSubtitle: 'All slots share equal status. Whether using identical tiers or different providers, diverse training perspectives eliminate blind spots.',
  slot1Title: 'Collab Slot 1',
  slot1Desc: 'First perspective for rapid drafting and parallel solution generation',
  slot2Title: 'Collab Slot 2',
  slot2Desc: 'Complementary perspective to prevent overlapping, overflow, and edge-case bugs',
  slot3Title: 'Collab Slot 3',
  slot3Desc: 'Third perspective to collaborate with Slots 1 & 2 in Quality mode for stubborn challenges',
  
  // Metrics & Flow
  tokenMultiplierLabel: 'Expected Token Multiplier',
  speedEstimateLabel: 'Response Speed',
  workflowFlowLabel: 'Dynamic Workflow Pipeline',
  changeModel: 'Change Model',
  activePresetLabel: 'Active Preset',
  defaultBadge: 'Default',
  customBadge: 'Custom',
  builtInBadge: 'Built-in',
  newPreset: 'New Preset',
  editPreset: 'Edit Preset',
  copyPreset: 'Duplicate Preset',
  deletePreset: 'Delete Preset',
  setDefault: 'Set as Default',
  liveTest: 'Live Collaborative Test',
  pipelineView: 'Pipeline Topology',
  presetsView: 'Preset Configurations',
  
  // Pipeline nodes
  fanOutLayer: 'Layer 1: Reference Models',
  fanOutDesc: 'Multiple models run in parallel to generate diverse candidate perspectives',
  aggregatorLayer: 'Layer 2: Aggregator Model',
  aggregatorDesc: 'Cross-verifies candidate outputs, eliminates hallucinations, and synthesizes the optimal response',
  finalOutput: 'Final Synthesized Response',
  
  // Card details
  refModelsCount: 'reference models in parallel',
  aggregatorModelLabel: 'Aggregator',
  refTemp: 'Ref Temp',
  aggTemp: 'Agg Temp',
  maxTokens: 'Max Tokens',
  
  // Modal form
  presetId: 'Preset ID',
  presetName: 'Preset Name',
  presetDescription: 'Description',
  refModelsConfig: 'Reference Models Configuration',
  addRefModel: 'Add Reference Model',
  selectProvider: 'Select Provider',
  selectModel: 'Select Model',
  aggregatorConfig: 'Aggregator Model Configuration',
  hyperparameters: 'Hyperparameters',
  refTemperatureLabel: 'Reference Temperature',
  aggTemperatureLabel: 'Aggregator Temperature',
  maxTokensLabel: 'Max Output Tokens',
  save: 'Save Preset',
  cancel: 'Cancel',
  deleteConfirmTitle: 'Delete MoA Preset?',
  deleteConfirmDesc: 'This action cannot be undone. Are you sure you want to delete this preset?',
  
  // Playground
  playgroundTitle: 'MoA Collaborative Playground',
  playgroundSubtitle: 'Input a complex prompt to see live parallel outputs from reference models and the final synthesis from the aggregator.',
  promptPlaceholder: 'Enter a complex coding, architectural, or multi-step reasoning prompt...',
  runTest: 'Run MoA Pipeline Test',
  running: 'Collaborating...',
  examplePrompts: 'Example Prompts:',
  examplePrompt1: 'Design a lock-free, concurrent-safe Rust LRU Cache with TTL expiration.',
  examplePrompt2: 'Compare architectural trade-offs between Multi-Head Attention and Mixture of Experts in modern LLMs.',
  examplePrompt3: 'Propose an algorithm to automatically detect and resolve distributed transaction deadlocks.',
  refOutputsTitle: 'Layer 1: Individual Reference Model Outputs',
  aggOutputTitle: 'Layer 2: Aggregator Synthesis & Final Response',
  synthesisSummary: '💡 Synthesis Note: The aggregator cross-checked reference points, reconciled discrepancies, and produced the refined solution.',
  
  // Validation
  nameRequired: 'Preset name is required',
  refModelsMin: 'Please add at least 1 reference model (2~4 recommended)',
  aggregatorRequired: 'Aggregator model is required',
}

export type MoaKey = keyof typeof zh
