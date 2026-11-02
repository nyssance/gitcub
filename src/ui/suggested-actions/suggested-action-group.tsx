// Desktop MIT port; platform imports adapted to Tauri.
//
// 原版用 react-css-transition-replace（React 16 时代，靠 findDOMNode 拿子组件的 DOM）做「替换」动画。
// 本项目是 React 19，照 ALwith Desktop 的写法用 motion 的 AnimatePresence：旧的向右滑出淡出、
// 新的从左滑入淡入，时序照原版 _suggested-actions.scss 的 replace-leave / replace-enter。
import { AnimatePresence, motion } from "motion/react"
import type * as React from "react"

interface ISuggestedActionGroup {
  /**
   * `primary` groups are visually distinct from `normal`
   * ones for emphasis. Defaults to `normal`.
   */
  type?: "normal" | "primary"

  /**
   * What animation, if any, should be applied to the group.
   * `replace` animation should only be used with a single
   * component at once.
   */
  transitions?: "replace"

  /**
   * Pass `false` to skip enter/exit transitions, which
   * can be useful during initial component loading. Only used
   * if `transitions` is also included.
   *
   * Defaults to `true` (enabled transitions)
   */
  enableTransitions?: boolean
}

// 原版 CSS：离开 opacity 200ms ease-in、transform 250ms cubic-bezier(0.6,-0.28,0.735,0.045)，500ms 后移除；
// 进入在 500ms 延迟后 opacity 200ms ease-in、transform 250ms cubic-bezier(0.175,0.885,0.32,1.275)。
// AnimatePresence mode="wait" 等离开动画（250ms）结束再进入，再补 250ms 延迟，总时序与原版一致。
const leave = {
  opacity: { duration: 0.2, ease: "easeIn" as const },
  x: { duration: 0.25, ease: [0.6, -0.28, 0.735, 0.045] as const }
}
const enter = {
  opacity: { duration: 0.2, ease: "easeIn" as const, delay: 0.25 },
  x: { duration: 0.25, ease: [0.175, 0.885, 0.32, 1.275] as const, delay: 0.25 }
}
const instant = { duration: 0 }

/**
 * Wraps a list of suggested action components with extra styling
 * and animations.
 */
export const SuggestedActionGroup: React.FunctionComponent<React.PropsWithChildren<ISuggestedActionGroup>> = props => {
  const cn = `suggested-action-group ${props.type || "normal"}`
  if (props.transitions === "replace") {
    const enableTransitions = props.enableTransitions ?? true
    // 同一时刻只有一个子元素；key 变了就是「替换」
    const child = props.children as React.ReactElement | null | undefined
    return (
      <div className={cn}>
        <AnimatePresence mode="wait" initial={false}>
          {child && (
            <motion.div
              key={child.key ?? "action"}
              initial={{ opacity: 0, x: "-100%" }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: "100%", transition: enableTransitions ? leave : instant }}
              transition={enableTransitions ? enter : instant}>
              {child}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )
  }
  return <div className={cn}>{props.children}</div>
}
