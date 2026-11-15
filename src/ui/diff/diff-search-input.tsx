// Desktop MIT port of ui/diff/diff-search-input.tsx; written as a function component.
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { TextBox } from "../desktop/text-box"

interface IDiffSearchInputProps {
  /**
   * Called when the user indicated that they either want to initiate a search
   * or want to advance to the next hit (typically done by hitting `Enter`).
   */
  readonly onSearch: (query: string, direction: "next" | "previous") => void

  /**
   * Called when the user indicates that they want to abort the search,
   * either by clicking outside of the component or by hitting `Escape`.
   */
  readonly onClose: () => void
}

export function DiffSearchInput({ onSearch, onClose }: IDiffSearchInputProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState("")

  const onKeyDown = (evt: React.KeyboardEvent<HTMLInputElement>) => {
    if (evt.key === "Escape" && !evt.defaultPrevented) {
      evt.preventDefault()
      onClose()
    } else if (evt.key === "Enter" && !evt.defaultPrevented) {
      evt.preventDefault()
      onSearch(value, evt.shiftKey ? "previous" : "next")
    }
  }

  return (
    <div className="diff-search">
      <TextBox
        placeholder={t("diffSearchInput.search")}
        displayClearButton={true}
        autoFocus={true}
        onValueChanged={setValue}
        onKeyDown={onKeyDown}
        onBlur={onClose}
        value={value}
      />
    </div>
  )
}
