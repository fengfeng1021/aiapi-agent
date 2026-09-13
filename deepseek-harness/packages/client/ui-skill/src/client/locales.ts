/** `skill` namespace dictionaries for the dedicated tool row. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'skill'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'row.title': 'Skill',
  'row.running': '正在加载 skill',
  'row.failed': 'skill 加载失败',
  'row.stopped': 'skill 加载已中止',
  'row.instructions': '说明',
  'row.inspect': '查看',
  'menu.userOnly': '仅用户',
  'sidebar.label': '外掛程式',
  'marketplace.count': '{count} 个技能',
  'marketplace.search': '搜索技能',
  'marketplace.search.placeholder': '按名称或描述过滤',
  'marketplace.empty': '没有符合的技能',
  'marketplace.loading': '正在加载技能…',
  'marketplace.failed': '技能目录读取失败',
  'marketplace.retry': '重试',
  'marketplace.noSession': '开始一个会话后即可浏览技能',
  'marketplace.detail.whenToUse': '使用时机',
  'marketplace.detail.modelOn': '模型可用',
  'marketplace.detail.modelOff': '仅用户可用',
  'marketplace.copyInvoke': '复制调用',
  'marketplace.copyDescription': '复制描述',
  'marketplace.copied': '已复制',
  'marketplace.creator.label': '新增 skill',
  'marketplace.creator.placeholder': '描述你想要的 skill…',
  'marketplace.creator.add': '新增',
  'marketplace.creator.hint': '复制后粘贴到对话框发送',
  'marketplace.pluginsHint': '外掛程式在「设置 → 插件」中管理',
} satisfies Record<string, string>

/** The skill namespace key union. */
export type SkillKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'row.title': 'Skill',
  'row.running': 'Loading skill',
  'row.failed': 'Skill load failed',
  'row.stopped': 'Skill load stopped',
  'row.instructions': 'Instructions',
  'row.inspect': 'Inspect',
  'menu.userOnly': 'user-only',
  'sidebar.label': 'Plugins',
  'marketplace.count': '{count} skills',
  'marketplace.search': 'Search skills',
  'marketplace.search.placeholder': 'Filter by name or description',
  'marketplace.empty': 'No matching skills',
  'marketplace.loading': 'Loading skills…',
  'marketplace.failed': 'Skill catalog failed to load',
  'marketplace.retry': 'Retry',
  'marketplace.noSession': 'Start a session to browse skills',
  'marketplace.detail.whenToUse': 'When to use',
  'marketplace.detail.modelOn': 'Available to model',
  'marketplace.detail.modelOff': 'User-only',
  'marketplace.copyInvoke': 'Copy invoke',
  'marketplace.copyDescription': 'Copy description',
  'marketplace.copied': 'Copied',
  'marketplace.creator.label': 'New skill',
  'marketplace.creator.placeholder': 'Describe the skill you want…',
  'marketplace.creator.add': 'Add',
  'marketplace.creator.hint': 'Copy, then paste into the composer to send',
  'marketplace.pluginsHint': 'Manage plugins in Settings → Plugins',
} satisfies Record<SkillKey, string>
