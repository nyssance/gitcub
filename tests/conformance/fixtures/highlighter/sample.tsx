import type { FC } from "react"

interface Props<T extends object = {}> { items: readonly T[]; onPick?: (t: T) => void }
type Id = `id-${number}`
enum Kind { A = 1, B }

export const List: FC<Props<{ id: Id }>> = ({ items, onPick }) => {
  const first = items[0] as unknown as { id: Id } | undefined
  return (
    <ul className="list" data-kind={Kind.A}>
      {items.map(it => (
        <li key={it.id} onClick={() => onPick?.(it)}>
          {it.id} <b>bold</b>
        </li>
      ))}
    </ul>
  )
}
