// Desktop filter-list types and text accessor.
export interface IFilterListItem {
  /** The text which represents the item. This is used for filtering. */
  readonly text: ReadonlyArray<string>

  /** A unique identifier for the item. */
  readonly id: string
}

/** A group of items in the list. */
export interface IFilterListGroup<Item extends IFilterListItem, Identifier = string> {
  /** The identifier for this group. */
  readonly identifier: Identifier

  /** Whether to render this group's header. Defaults to true. */
  readonly showHeader?: boolean

  /** The items in the group. */
  readonly items: ReadonlyArray<Item>
}

export function getText<T extends IFilterListItem>(item: T): ReadonlyArray<string> {
  return item["text"]
}

import type { SelectionSource as ListSelectionSource } from "../upstream/ui/lib/list/selection"
export interface IFilterSelectionSource {
  kind: "filter"

  /** The filter text at the time the selection event was raised.  */
  filterText: string
}

export type SelectionSource = ListSelectionSource | IFilterSelectionSource
