import type { Locale } from "date-fns"
import { enUS, zhCN } from "date-fns/locale"

/** UI 语言 → date-fns locale（照 alwith-desktop src/lib/date-locales.ts，只列本项目的两种 UI 语言）。 */
const DATE_FNS_LOCALES: Record<string, Locale> = {
  en: enUS,
  "zh-CN": zhCN
}

export function dateFnsLocale(lang: string): Locale {
  return DATE_FNS_LOCALES[lang] ?? enUS
}
