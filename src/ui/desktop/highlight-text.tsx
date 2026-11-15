// Desktop MIT port; platform imports adapted to Tauri.
import type * as React from "react"

interface IHighlightTextProps {
  /** The text to render */
  readonly text: string
  /** The characters in `text` to highlight */
  readonly highlight: ReadonlyArray<number>
}

export const HighlightText: React.FunctionComponent<IHighlightTextProps> = ({ text, highlight }) => (
  <span>
    {
      [
        ...text.split("").map((ch, i): [string, boolean] => [ch, highlight.includes(i)]),
        ["", false] as [string, boolean]
      ].reduce(
        (state, [ch, matched], i, arr) => {
          if (matched === state.matched && i < arr.length - 1) {
            state.str += ch
          } else {
            const Component = state.matched ? "mark" : "span"
            // Preserve the original Desktop component contract.
            state.result.push(<Component key={i}>{state.str}</Component>)
            state.str = ch
            state.matched = matched
          }
          return state
        },
        {
          matched: false,
          str: "",
          // Preserve the original Desktop component contract.
          result: [] as React.ReactElement[]
        }
      ).result
    }
  </span>
)
