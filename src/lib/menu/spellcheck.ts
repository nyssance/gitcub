// Desktop MIT: exact language menu option selection. Webview-native spelling remains platform owned.
interface ISpellCheckMenuItemOption {
  /**
   * Dynamic label based on spellchecker's state
   */
  readonly label: string

  /**
   * An array with languages to set spellchecker
   */
  readonly languages: string[]
}

export const SpellcheckEnglishLabel = "Set spellcheck to English"
export const SpellcheckSystemLabel = "Set spellcheck to system language"

/**
 * Method to get a menu item options to give user the choice to use English or
 * their system language.
 *
 * If system language is english or it's not part of the available languages,
 * it returns null. If spellchecker is not set to english, it returns options
 * that can set it to English. If spellchecker is set to english, it returns
 * the options that can set it to their system language.
 *
 * @param userLanguageCode Language code based on user's locale.
 * @param spellcheckLanguageCodes An array of language codes the spellchecker
 * is enabled for.
 * @param availableSpellcheckLanguages An array which consists of all available
 * spellchecker languages.
 */
export function getSpellCheckLanguageMenuItemOptions(
  userLanguageCode: string,
  spellcheckLanguageCodes: string[],
  availableSpellcheckLanguages: string[]
): ISpellCheckMenuItemOption | null {
  const englishLanguageCode = "en-US"

  if (
    (userLanguageCode === englishLanguageCode && spellcheckLanguageCodes.includes(englishLanguageCode)) ||
    !availableSpellcheckLanguages.includes(userLanguageCode)
  ) {
    return null
  }

  const languageCode =
    spellcheckLanguageCodes.includes(englishLanguageCode) && !spellcheckLanguageCodes.includes(userLanguageCode)
      ? userLanguageCode
      : englishLanguageCode

  const label = languageCode === englishLanguageCode ? SpellcheckEnglishLabel : SpellcheckSystemLabel

  return {
    label,
    languages: [languageCode]
  }
}
