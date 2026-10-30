// ALwith Desktop 494518376bf1f21ad9bde2cde6952ccff46ac5e6: original release-snap cases.
import { describe, expect, test } from "bun:test"

import { resolveReleaseSnap } from "@nyssance/atlas/core"

/** 三屏画布:snap 坐标 = 引擎 translate(负值),一屏 = 视口 1000px,轻划阈 = 150px。 */
const SNAPS = [0, -1000, -2000] as const
const VIEWPORT = 1000

const resolve = (startIndex: number, displacement: number, flickMinIndex?: number) =>
  resolveReleaseSnap({
    startIndex,
    displacement,
    location: SNAPS[startIndex] + displacement,
    snapPoints: SNAPS,
    viewportWidth: VIEWPORT,
    flickMinIndex
  })

describe("resolveReleaseSnap", () => {
  test("轻划即翻:位移过阈按方向翻一屏,不用过半", () => {
    expect(resolve(1, -200)).toBe(2)
    expect(resolve(1, 200)).toBe(0)
  })

  test("落板抖动不翻:位移不过阈弹回起手屏", () => {
    expect(resolve(1, -80)).toBe(1)
    expect(resolve(1, 80)).toBe(1)
  })

  test("慢扫跟手:拖过半进了别的屏,落在手指所在的屏", () => {
    expect(resolve(1, -600)).toBe(2)
    expect(resolve(0, -1900)).toBe(2) // 一路慢拖近两屏,落在拖到的那屏,不往回拽
  })

  test("边缘钳制:首末屏外没有屏可翻", () => {
    expect(resolve(0, 300)).toBe(0)
    expect(resolve(2, -300)).toBe(2)
  })

  test("flickMinIndex:-1 屏轻划到不了,慢扫拖过半才进", () => {
    // 第一屏往右轻划:原地弹回,不进 -1 屏
    expect(resolve(1, 300, 1)).toBe(1)
    // 慢扫拖过半:跟手落进 -1 屏
    expect(resolve(1, 600, 1)).toBe(0)
    // 已在 -1 屏:轻划往前照常回第一屏,不受下界影响
    expect(resolve(0, -300, 1)).toBe(1)
  })
})

describe("resolveReleaseSnap RTL", () => {
  const rtlSnaps = [0, 1000, 2000] as const
  const resolveRtl = (startIndex: number, displacement: number, flickMinIndex?: number) =>
    resolveReleaseSnap({
      startIndex,
      displacement,
      location: rtlSnaps[startIndex] + displacement,
      snapPoints: rtlSnaps,
      viewportWidth: VIEWPORT,
      flickMinIndex
    })

  test("按 RTL 引擎坐标向前或向后翻屏", () => {
    expect(resolveRtl(1, 200)).toBe(2)
    expect(resolveRtl(1, -200)).toBe(0)
  })

  test("起始特殊区域仍不能通过轻划进入", () => {
    expect(resolveRtl(1, -300, 1)).toBe(1)
    expect(resolveRtl(1, -600, 1)).toBe(0)
  })
})
