import { useTranslation } from "react-i18next"

import type { UnknownAuthor } from "@/upstream/models/author"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "../base/alert-dialog"

/** Don't list more than this number of authors. */
const MaxAuthorsToList = 10

/** Desktop unknown-authors-dialog.tsx：加了查不到的共同作者时确认是否照样提交 */
export function UnknownAuthors({
  authors,
  onCommit,
  onDismissed
}: {
  authors: readonly UnknownAuthor[]
  onCommit: () => void
  onDismissed: () => void
}) {
  const { t } = useTranslation()
  const many = authors.length > MaxAuthorsToList
  return (
    <AlertDialog open onOpenChange={open => !open && onDismissed()}>
      <AlertDialogContent id="unknown-authors">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("unknownAuthors.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {many
              ? t("unknownAuthors.countUsersWerentFound", { count: authors.length })
              : t("unknownAuthors.theseUsersWerentFound")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!many && (
          <ul className="author-list max-h-40 overflow-y-auto font-mono text-xs">
            {authors.map(author => (
              <li key={author.username} className="truncate" title={author.username}>
                {author.username}
              </li>
            ))}
          </ul>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onDismissed}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onCommit()
              onDismissed()
            }}>
            {t("unknownAuthors.commitAnyway")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
