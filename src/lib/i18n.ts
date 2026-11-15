import i18n from "i18next"
import { initReactI18next } from "react-i18next"

import en from "../locales/en/app.json" with { type: "json" }
import zhCN from "../locales/zh-CN/app.json" with { type: "json" }

/** 从第一天就上 i18n。
 *
 * GitHub Desktop 的反面教材：867 个文件、10 万行 UI 全是硬编码英文，
 * 零 i18n 基础设施，现在想加等于重写整个 UI 层。 */
void i18n.use(initReactI18next).init({
  resources: {
    en: { app: en },
    "zh-CN": { app: zhCN }
  },
  lng: navigator.language.startsWith("zh") ? "zh-CN" : "en",
  fallbackLng: "en",
  defaultNS: "app",
  interpolation: { escapeValue: false }
})

export default i18n
