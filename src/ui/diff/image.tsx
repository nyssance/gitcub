import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { formatBytes } from "@/lib/format-bytes"
import { cn } from "@/lib/utils"
import type { ImageDiff as ImageDiffData, ImageSide } from "@/models/app-state"
import { Empty, EmptyHeader, EmptyTitle } from "@/ui/base/empty"
import { Slider } from "@/ui/base/slider"
import { ToggleGroup, ToggleGroupItem } from "@/ui/base/toggle-group"
import { getAspectFitSize, getMaxFitSize, type ISize } from "@/upstream/ui/diff/image-diffs/sizing"

/** 怎么看两版图片。四种都留着——它们各自擅长的场合不一样：
 *   - 并排：整体看构图变没变
 *   - 滑动：同一位置左右拉，看细节挪动
 *   - 洋葱皮：半透明叠着，看错位
 *   - 差值：只有改了的地方会亮，一眼找出改哪儿了
 * 这四种取自原版（ModifiedImageDiff）。 */
type Mode = "two-up" | "swipe" | "onion" | "difference"

const url = (i: ImageSide) => `data:${i.mediaType};base64,${i.data}`

const size = (bytes: number) => formatBytes(bytes, 1)

export function ImageDiffView({ data }: { data: ImageDiffData }) {
  const [source, setSource] = useState({ previous: data.previous, current: data.current, revision: 0 })
  if (source.previous !== data.previous || source.current !== data.current) {
    setSource({ previous: data.previous, current: data.current, revision: source.revision + 1 })
  }
  // Reset load state for a new pair without copying potentially large base64 strings into React keys.
  return <ImageComparison key={source.revision} data={data} />
}

function ImageComparison({ data }: { data: ImageDiffData }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<Mode>("two-up")
  // Desktop bebc062: Swipe starts at 0%, OnionSkin at 1%; each mode remount resets its slider.
  const [percentage, setPercentage] = useState(0)
  const ratio = percentage / 100
  const changeMode = (next: Mode) => {
    if (next === mode) return
    setMode(next)
    setPercentage(next === "onion" ? 1 : 0)
  }

  const { previous, current } = data
  const [failed, setFailed] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const [container, setContainer] = useState<ISize>({ width: 0, height: 0 })
  const [dimensions, setDimensions] = useState<{ previous?: ISize; current?: ISize }>({})
  useEffect(() => {
    const element = stage.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setContainer({ width, height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [failed])
  const loaded = (side: "previous" | "current") => (event: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth: width, naturalHeight: height } = event.currentTarget
    setDimensions(value =>
      value[side]?.width === width && value[side]?.height === height ? value : { ...value, [side]: { width, height } }
    )
  }
  const limit = {
    width: Math.max(0, mode === "two-up" && previous && current ? (container.width - 16) / 2 : container.width),
    height: Math.max(0, container.height - (mode === "two-up" && previous && current ? 24 : 0))
  }
  const fit = (side: "previous" | "current") =>
    dimensions[side] && limit.width > 0 && limit.height > 0 ? getAspectFitSize(dimensions[side], limit) : undefined
  const maximum =
    dimensions.previous && dimensions.current && limit.width > 0 && limit.height > 0
      ? getMaxFitSize(dimensions.previous, dimensions.current, limit)
      : undefined
  const shot = (side: "previous" | "current", image: ImageSide, alt: string) => (
    <Shot src={url(image)} alt={alt} style={fit(side)} onLoad={loaded(side)} onError={() => setFailed(true)} />
  )
  if (failed)
    return (
      <Empty role="alert">
        <EmptyHeader>
          <EmptyTitle>{t("diff.imageLoadFailed")}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )

  // 只有一侧时没什么可比的，直接把那一侧摆出来
  if (!previous || !current) {
    const only = current ?? previous
    if (!only) return <Centered>{t("diff.imageTooBig")}</Centered>
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-auto p-4">
        <Caption>{current ? t("diff.imageAdded") : t("diff.imageDeleted")}</Caption>
        <div ref={stage} className="flex min-h-0 w-full flex-1 items-start justify-center">
          {shot(current ? "current" : "previous", only, t(current ? "diff.imageAdded" : "diff.imageDeleted"))}
        </div>
        <Caption>{size(only.bytes)}</Caption>
      </div>
    )
  }

  const delta = current.bytes - previous.bytes

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b px-3">
        <ToggleGroup
          size="sm"
          value={[mode]}
          onValueChange={values => {
            const next = values[0] as Mode | undefined
            if (next) changeMode(next)
          }}>
          {(["two-up", "swipe", "onion", "difference"] as const).map(m => (
            <ToggleGroupItem key={m} value={m}>
              {t(`diff.image_${m}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex-1" />
        <span className="text-muted-foreground shrink-0 text-xs whitespace-nowrap">
          {size(previous.bytes)} → {size(current.bytes)}
          {delta !== 0 && ` (${delta > 0 ? "+" : "−"}${size(Math.abs(delta))})`}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center gap-3 p-4">
        <div ref={stage} className="relative flex min-h-0 w-full flex-1 items-start justify-center overflow-hidden">
          {mode === "two-up" ? (
            <div className="flex w-full items-start justify-center gap-4">
              <div className="flex min-w-0 flex-col items-center gap-2">
                <Caption>{t("diff.imageBefore")}</Caption>
                {shot("previous", previous, t("diff.imageBefore"))}
              </div>
              <div className="flex min-w-0 flex-col items-center gap-2">
                <Caption>{t("diff.imageAfter")}</Caption>
                {shot("current", current, t("diff.imageAfter"))}
              </div>
            </div>
          ) : (
            <div className={cn("relative shrink-0", mode === "difference" && "bg-black")} style={maximum}>
              <div
                data-image-revision="previous"
                className="absolute inset-0"
                style={mode === "swipe" ? { clipPath: `inset(0 ${100 - ratio * 100}% 0 0)` } : undefined}>
                {shot("previous", previous, t("diff.imageBefore"))}
              </div>
              <div
                data-image-revision="current"
                className="absolute inset-0"
                style={
                  mode === "swipe"
                    ? { clipPath: `inset(0 0 0 ${ratio * 100}%)` }
                    : mode === "onion"
                      ? { opacity: ratio }
                      : { mixBlendMode: "difference" }
                }>
                {shot("current", current, t("diff.imageAfter"))}
              </div>
            </div>
          )}
        </div>

        {(mode === "swipe" || mode === "onion") && (
          <Slider
            min={0}
            max={100}
            step={0.1}
            value={[percentage]}
            onValueChange={value => setPercentage(Array.isArray(value) ? value[0] : value)}
            className="w-64"
            aria-label={t(`diff.image_${mode}`)}
          />
        )}
      </div>
    </div>
  )
}

function Shot({
  src,
  alt,
  className,
  style,
  onLoad,
  onError
}: {
  src: string
  alt: string
  className?: string
  style?: React.CSSProperties
  onLoad?: React.ReactEventHandler<HTMLImageElement>
  onError?: React.ReactEventHandler<HTMLImageElement>
}) {
  return (
    <img
      onLoad={onLoad}
      onError={onError}
      src={src}
      alt={alt}
      style={style}
      // 棋盘格底：透明的图片（图标最常见）不垫一层就看不出边界
      className={cn(
        "max-w-full shrink-0 object-contain",
        "bg-[length:16px_16px] bg-[position:0_0,8px_8px]",
        "bg-[linear-gradient(45deg,var(--muted)_25%,transparent_25%,transparent_75%,var(--muted)_75%),linear-gradient(45deg,var(--muted)_25%,transparent_25%,transparent_75%,var(--muted)_75%)]",
        className
      )}
    />
  )
}

function Caption({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground text-xs">{children}</span>
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground flex h-full items-center justify-center text-xs">{children}</div>
}
