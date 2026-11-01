import { useEffect, useMemo, useRef, useState } from "react"

import { EMOJI } from "@/lib/emoji"
import { cn } from "@/lib/utils"
import type { Issue } from "@/models/app-state"
import { Button as StandardButton } from "@/components/ui/button"
import { findNextSelectableRow } from "@/upstream/ui/lib/list/selection"

/** 一条候选。 */
interface Candidate {
  key: string
  /** 列表里显示的主文本 */
  label: string
  /** 右边的补充说明 */
  detail?: string
  /** 选中后真正插进去的文本（不含触发字符） */
  insert: string
}

/** 触发规则照原版（emoji/issues 两个 provider 的 getRegExp）：
 *  行首、换行后或空格后的 `:` / `#`，后面跟着还没打完的词。
 *  必须限制前一个字符，否则 URL 里的 `#` 和时间里的 `:` 全会弹菜单。 */
const TRIGGER = /(?:^|\n| )([:#])([a-z\d+_-]*)$/i

const MAX = 8

/** 给提交信息用的补全。
 *
 * 只做两种：
 *   - `:` → emoji。纯本地，一张表的事
 *   - `#` → issue 号。这是唯一还去网络取的一项，理由是它服务的是本地动作：
 *     你正在写这次提交的信息，想写对号码，而不是去浏览器里翻
 *
 * 弹窗挂在输入框下方而不是插入符位置：插入符定位要把文本重排一遍去量坐标，
 * 为这点收益不值得；输入框本来就不宽，挂下面一样够得着。 */
export function useCompletion(issues: Issue[]) {
  const [state, setState] = useState<{
    sigil: string
    query: string
    /** 触发字符在文本里的下标 */
    at: number
    /** 插入符位置 */
    caret: number
  } | null>(null)
  const [index, setIndex] = useState(0)
  // 选中后要把插入符放回正确位置，得拿到真正的 DOM 元素
  const elRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const caretRef = useRef<number | null>(null)

  useEffect(() => {
    const el = elRef.current
    const c = caretRef.current
    if (el && c !== null) {
      el.setSelectionRange(c, c)
      caretRef.current = null
    }
  })

  const list = useMemo<Candidate[]>(() => {
    if (!state) return []
    const q = state.query.toLowerCase()
    if (state.sigil === ":") {
      return (
        Object.entries(EMOJI)
          .filter(([name]) => name.includes(q))
          // 前缀匹配排前面：打 `art` 时想要的是 :art:，不是 :heart:
          .toSorted((a, b) => Number(b[0].startsWith(q)) - Number(a[0].startsWith(q)))
          .slice(0, MAX)
          .map(([name, ch]) => ({
            key: name,
            label: `${ch} :${name}:`,
            insert: `${name}: `
          }))
      )
    }
    return issues
      .filter(i => String(i.number).startsWith(q) || i.title.toLowerCase().includes(q))
      .slice(0, MAX)
      .map(i => ({
        key: String(i.number),
        label: `#${i.number}`,
        detail: i.title,
        insert: `${i.number} `
      }))
  }, [state, issues])

  const open = state !== null && list.length > 0

  /** 输入框内容变了：看插入符前面是不是刚好构成一个触发 */
  const onInput = (el: HTMLInputElement | HTMLTextAreaElement) => {
    elRef.current = el
    const caret = el.selectionStart ?? el.value.length
    const before = el.value.slice(0, caret)
    const m = TRIGGER.exec(before)
    setIndex(0)
    setState(m ? { sigil: m[1], query: m[2] ?? "", at: caret - (m[2]?.length ?? 0) - 1, caret } : null)
  }

  /** 把选中的候选替换进去。返回新的文本，由调用方写回 state */
  const accept = (value: string, c: Candidate) => {
    if (!state) return value
    const next = value.slice(0, state.at + 1) + c.insert + value.slice(state.caret)
    caretRef.current = state.at + 1 + c.insert.length
    setState(null)
    return next
  }

  /** 上下选、回车/Tab 确定、Esc 关掉。没打开时一律不拦 —— 否则回车提交会失灵 */
  const onKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    value: string,
    setValue: (v: string) => void
  ) => {
    if (!open) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setIndex(i => findNextSelectableRow(list.length, { row: i, direction: "down" }) ?? i)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setIndex(i => findNextSelectableRow(list.length, { row: i, direction: "up" }) ?? i)
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault()
      const c = list[index]
      if (c) setValue(accept(value, c))
    } else if (e.key === "Escape") {
      e.preventDefault()
      setState(null)
    }
  }

  const popup = (value: string, setValue: (v: string) => void) =>
    open && (
      <div className="bg-popover absolute inset-x-0 bottom-full z-50 mb-1 overflow-hidden rounded-md border shadow-md">
        {list.map((c, i) => (
          <StandardButton
            variant="ghost"
            key={c.key}
            type="button"
            // 鼠标按下会先让输入框失焦，那样插入符就没了
            onMouseDown={e => {
              e.preventDefault()
              setValue(accept(value, c))
            }}
            onMouseEnter={() => setIndex(i)}
            className={cn(
              "flex w-full items-center gap-2 px-2 py-1 text-left text-xs",
              i === index ? "bg-accent" : ""
            )}>
            <span className="shrink-0">{c.label}</span>
            {c.detail && <span className="text-muted-foreground truncate text-[11px]">{c.detail}</span>}
          </StandardButton>
        ))}
      </div>
    )

  return { onInput, onKeyDown, popup, close: () => setState(null) }
}
