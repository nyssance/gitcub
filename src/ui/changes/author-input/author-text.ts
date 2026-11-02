// Desktop MIT port; platform imports adapted to Tauri.
import { type Author, isKnownAuthor } from "../../../upstream/models/author"

export function getFullTextForAuthor(author: Author) {
  if (isKnownAuthor(author)) {
    return author.username === null ? author.name : `@${author.username} (${author.name})`
  } else {
    return `@${author.username}`
  }
}

export function getDisplayTextForAuthor(author: Author) {
  if (isKnownAuthor(author)) {
    return author.username === null ? author.name : `@${author.username}`
  } else {
    return `@${author.username}`
  }
}
