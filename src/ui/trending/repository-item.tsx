import { openUrl } from "@tauri-apps/plugin-opener"
import { ExternalLinkIcon, LockIcon, StarIcon } from "lucide-react"
import type { ReactNode } from "react"

import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"

interface Props {
  owner: string
  name: string
  url: string
  description: string | null
  language: string | null
  languageColor?: string | null
  stars: number
  private?: boolean
  children: ReactNode
}

/** Shared discovery row: repository identity, description, statistics and actions. */
export function RepositoryItem({ children, ...repo }: Props) {
  return (
    <Item role="listitem" size="sm" className="flex-nowrap">
      <ItemContent className="min-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <ItemTitle className="min-w-0">
            <a
              href={repo.url}
              className="truncate hover:underline"
              onClick={event => {
                event.preventDefault()
                void openUrl(repo.url)
              }}
              title={`${repo.owner}/${repo.name}`}>
              <span className="text-muted-foreground">{repo.owner}/</span>
              {repo.name}
            </a>
            {repo.private && <LockIcon className="size-3.5 shrink-0" aria-hidden="true" />}
          </ItemTitle>
          <ExternalLinkIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
        </div>
        {repo.description && (
          <ItemDescription className="line-clamp-1" title={repo.description}>
            {repo.description}
          </ItemDescription>
        )}
        <div className="text-muted-foreground flex items-center gap-4 text-xs">
          {repo.language && (
            <span className="flex items-center gap-1.5">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: repo.languageColor ?? "var(--muted-foreground)" }}
              />
              {repo.language}
            </span>
          )}
          <span className="flex items-center gap-1 tabular-nums">
            <StarIcon className="size-3.5" />
            {repo.stars.toLocaleString()}
          </span>
        </div>
      </ItemContent>
      <ItemActions className="shrink-0">{children}</ItemActions>
    </Item>
  )
}
