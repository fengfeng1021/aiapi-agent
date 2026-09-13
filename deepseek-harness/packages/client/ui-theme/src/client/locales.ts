/** `settings.theme` namespace dictionaries (the Appearance and font-size rows' copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'appearance.title': '外观',
  'appearance.light': '浅色',
  'appearance.dark': '深色',
  'appearance.system': '跟随系统',
  'fontSize.title': '字号大小',
  'fontSize.description': '仅影响会话内容的字号',
  'fontSize.unit': 'px',
  'fontSection.nav': '外观',
  'font.latin.title': '英文与数字',
  'font.latin.description': '代码、命令与英文内容所用的字体',
  'font.cjk.title': '中文',
  'font.cjk.description': '中文内容所用的字体',
  'font.latin.preview': 'git pull --ff-only · 0123456789 · AaBbCcDdEe',
  'font.cjk.preview': '中文等宽预览 0123456789 AaBb · 繁體測試 · 简体测试',
  'font.weight.title': '字重',
  'font.weight.label': '调整字重粗细',
  'font.note': '正文粗细跟随中文，代码粗细跟随英文与数字',
  'fontSize.increase': '增大字号',
  'fontSize.decrease': '减小字号',
} satisfies Record<string, string>

/** The settings.theme namespace key union. */
export type ThemeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'appearance.title': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',
  'fontSize.title': 'Font size',
  'fontSize.description': 'Only affects conversation content',
  'fontSize.unit': 'px',
  'fontSection.nav': 'Appearance',
  'font.latin.title': 'Latin & digits',
  'font.latin.description': 'Font for code, commands and Latin text',
  'font.cjk.title': 'Chinese',
  'font.cjk.description': 'Font for Chinese text',
  'font.latin.preview': 'git pull --ff-only · 0123456789 · AaBbCcDdEe',
  'font.cjk.preview': '中文等宽预览 0123456789 AaBb · 繁體測試 · 简体测试',
  'font.weight.title': 'Weight',
  'font.weight.label': 'Adjust font weight',
  'font.note': 'Body weight follows Chinese; code weight follows Latin & digits',
  'fontSize.increase': 'Increase font size',
  'fontSize.decrease': 'Decrease font size',
} satisfies Record<ThemeKey, string>
