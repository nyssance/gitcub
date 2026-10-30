import { useLayoutEffect, useRef, useState } from "react"

/** 测量元素尺寸，等价于 GitHub Desktop 里 react-virtualized 的 AutoSizer。
 *
 * Desktop 的 `.list` 是 `flex-grow:1; height:100%`，外面套 AutoSizer 量出
 * 父容器的像素高度再写给 Grid——它不依赖 flex 链一路把高度传下去。
 * 这里同理：量出来给滚动容器写死 px 高度，祖先链上少写一个 min-h-0 也不会塌。 */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect
      setSize(prev =>
        prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }
      )
    })
    ro.observe(el)
    setSize({ width: el.clientWidth, height: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  return [ref, size] as const
}
