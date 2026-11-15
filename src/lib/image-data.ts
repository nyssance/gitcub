import type { ImageDiff, ImageSide } from "../models/app-state"
import { convertDDSImage } from "../upstream/ui/diff/image-diffs/dds-converter"

/** Convert DDS once, while loading the diff, so render failures use the normal error path. */
export function prepareImageSide(side: ImageSide | null): ImageSide | null {
  if (side?.mediaType !== "image/vnd-ms.dds") return side
  const bytes = Uint8Array.from(atob(side.data), character => character.charCodeAt(0))
  const url = convertDDSImage(bytes.buffer)
  return { ...side, mediaType: "image/png", data: url.slice(url.indexOf(",") + 1) }
}
export function prepareImageDiff(diff: ImageDiff): ImageDiff {
  return { previous: prepareImageSide(diff.previous), current: prepareImageSide(diff.current) }
}
