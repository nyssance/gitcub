import { expect, test } from "@playwright/test"

for (const theme of ["light", "dark"]) {
  test(`standard shadcn navigation spacing, transparent surface and stable hover / ${theme}`, async ({
    page
  }, info) => {
    await page.goto(`/iframe.html?id=repositories-navigation--grouped&viewMode=story&globals=locale:en;theme:${theme}`)
    await expect(page.locator("html")).toHaveAttribute("data-story-finished", "repositories-navigation--grouped")
    const rail = page.locator(".repository-rail")
    await expect(rail).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
    const rows = rail.locator('[data-slot="sidebar-menu-button"]')
    const bounds = await rail.boundingBox()
    for (const row of await rows.all()) {
      const before = (await row.boundingBox())!
      // Standard base-vega SidebarMenuButton: h-8, p-2, gap-2, text-sm.
      expect(before.height).toBe(32)
      expect(before.x - bounds!.x).toBe(8)
      expect(bounds!.x + bounds!.width - before.x - before.width).toBe(8)
      await expect(row).toHaveCSS("column-gap", "8px")
      await expect(row).toHaveCSS("font-size", "14px")
      await row.hover()
      expect(await row.boundingBox()).toEqual(before)
    }
    const heading = rail.getByRole("button", { name: "Repositories", exact: true })
    await expect(heading.locator("svg")).toHaveCount(0)
    const selected = rail.getByRole("button", { name: "gitcub", exact: true })
    const next = rail.getByRole("button", { name: "atlas", exact: true })
    await next.hover()
    await expect(next).toHaveCSS(
      "background-color",
      await selected.evaluate(el => getComputedStyle(el).backgroundColor)
    )
    const first = (await selected.boundingBox())!
    const second = (await next.boundingBox())!
    expect(second.y - first.y - first.height).toBe(4)
    await page.screenshot({ path: info.outputPath("navigation.png") })
  })
}

test("long repository groups collapse without changing horizontal geometry or moving fixed controls", async ({
  page
}) => {
  await page.goto("/iframe.html?id=repositories-navigation--long-groups&viewMode=story&globals=locale:en;theme:light")
  await expect(page.locator("html")).toHaveAttribute("data-story-finished", "repositories-navigation--long-groups")
  const rail = page.locator(".repository-rail")
  const github = rail.getByRole("button", { name: "GitHub 30", exact: true })
  const gitlab = rail.getByRole("button", { name: "gitlab.example 1", exact: true })
  const viewport = rail.locator('[data-slot="scroll-area-viewport"]')
  const fixed = rail.locator('[data-slot="sidebar-header"], [data-slot="tabs-list"], [data-slot="sidebar-footer"]')
  const fixedBefore = await fixed.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()))
  const groupBefore = await github.boundingBox()
  for (let index = 0; index < 6; index++) {
    if (index % 2 === 0) await github.click()
    else {
      await github.focus()
      await page.keyboard.press("Enter")
    }
    await expect(github).toHaveAttribute("aria-expanded", String(index % 2 !== 0))
    await expect(github).toBeFocused()
    const frames = await rail.evaluate(async element => {
      const frames = []
      for (let frame = 0; frame < 12; frame++) {
        await new Promise(requestAnimationFrame)
        const viewport = element.querySelector('[data-slot="scroll-area-viewport"]')!
        const group = element.querySelector('[data-slot="sidebar-group-label"]')!
        frames.push({
          x: group.getBoundingClientRect().x,
          width: group.getBoundingClientRect().width,
          overflow: viewport.scrollWidth - viewport.clientWidth,
          left: viewport.scrollLeft
        })
      }
      return frames
    })
    for (const frame of frames) {
      expect(frame.x).toBe(groupBefore!.x)
      expect(frame.width).toBe(groupBefore!.width)
      expect(frame.overflow).toBe(0)
      expect(frame.left).toBe(0)
    }
    expect(await fixed.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()))).toEqual(
      fixedBefore
    )
  }
  // The second host remains independently collapsible after a long list has scrolled.
  await gitlab.click()
  await expect(gitlab).toHaveAttribute("aria-expanded", "false")
  await expect(rail.getByRole("button", { name: "team", exact: true })).toHaveCount(0)
  await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
  await github.click()
  await expect(github).toHaveAttribute("aria-expanded", "false")
  await expect.poll(() => viewport.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0)
})

test("browser controls keep Chrome order and stop replaces reload without a separate spinner", async ({ page }) => {
  await page.clock.install()
  await page.goto("/iframe.html?id=discovery-trending--connecting&viewMode=story&globals=locale:en;theme:light")
  await expect(page.locator("html")).toHaveAttribute("data-story-finished", "discovery-trending--connecting")
  const buttons = page.locator("header button")
  await expect(buttons).toHaveCount(4)
  await expect(buttons.nth(0)).toHaveAccessibleName("Back")
  await expect(buttons.nth(1)).toHaveAccessibleName("Forward")
  await expect(buttons.nth(2)).toHaveAccessibleName("Stop loading")
  await expect(page.locator('[data-slot="spinner"]')).toHaveCount(0)
  const stopBounds = await buttons.nth(2).boundingBox()
  await buttons.nth(2).click()
  await expect(buttons.nth(2)).toHaveAccessibleName("Refresh")
  expect(await buttons.nth(2).boundingBox()).toEqual(stopBounds)
  await page.clock.fastForward(31000)
  await expect(page.getByRole("alert")).toHaveCount(0)
  await buttons.nth(2).click()
  await expect(buttons.nth(2)).toHaveAccessibleName("Stop loading")
})

test("discovery connection timeout is recoverable before native page-load callbacks arrive", async ({ page }) => {
  await page.clock.install()
  await page.goto("/iframe.html?id=discovery-trending--connecting&viewMode=story&globals=locale:en;theme:light")
  await expect(page.locator("html")).toHaveAttribute("data-story-finished", "discovery-trending--connecting")
  await expect(page.getByRole("button", { name: "Stop loading", exact: true })).toBeVisible()
  await page.clock.fastForward(31000)
  await expect(page.getByRole("alert")).toBeVisible()
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByRole("alert")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Stop loading", exact: true })).toBeVisible()
})

for (const width of [800, 1000]) {
  test(`discovery scrolling keeps toolbar and sidebar controls fixed at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 })
    await page.goto("/iframe.html?id=discovery-window--long-lists&viewMode=story&globals=locale:en;theme:light")
    await expect(page.locator("html")).toHaveAttribute("data-story-finished", "discovery-window--long-lists")
    const toolbar = page.getByRole("tablist", { name: "Discover", exact: true })
    const categories = page.getByRole("tablist", { name: "Repositories", exact: true })
    const toolbarBefore = await toolbar.boundingBox()
    const categoriesBefore = await categories.boundingBox()
    const board = await page.locator('[data-floating-board="workspace"]').boundingBox()
    expect(board!.x).toBeGreaterThan(0)
    expect(board!.x + board!.width).toBeLessThan(width)
    const viewports = [
      page.getByRole("tabpanel", { name: "Mine", exact: true }).locator('[data-slot="scroll-area-viewport"]'),
      page.locator('main [data-slot="scroll-area-viewport"]')
    ]
    for (const viewport of viewports) {
      await expect.poll(() => viewport.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
      const scrollbar = viewport.locator("..").locator('[data-slot="scroll-area-scrollbar"]')
      await page.mouse.move(width - 2, 710)
      await expect(scrollbar).toHaveCSS("opacity", "0")
      await viewport.hover()
      await page.mouse.wheel(0, 4000)
      await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
      await expect(scrollbar).toHaveCSS("opacity", "1")
      await expect(viewport).toHaveCSS("scrollbar-width", "none")
      await expect.poll(() => viewport.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2)
    }
    expect(await toolbar.boundingBox()).toEqual(toolbarBefore)
    expect(await categories.boundingBox()).toEqual(categoriesBefore)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test("discovery floating canvas preserves workspace state and separates swiping from scrolling", async ({
  page
}, info) => {
  await page.setViewportSize({ width: 1000, height: 720 })
  await page.goto("/iframe.html?id=discovery-window--overview&viewMode=story&globals=locale:en;theme:light")
  await expect(page.locator("html")).toHaveAttribute("data-story-finished", "discovery-window--overview")
  const canvas = page.locator("[data-floating-workspace]")
  const canvasBounds = await canvas.boundingBox()
  const workspaceBounds = await page.locator('[data-floating-board="workspace"]').boundingBox()
  expect(workspaceBounds!.y - canvasBounds!.y).toBe(32)
  expect(canvasBounds!.y + canvasBounds!.height - workspaceBounds!.y - workspaceBounds!.height).toBe(8)
  expect(canvasBounds!.x + canvasBounds!.width - workspaceBounds!.x - workspaceBounds!.width).toBe(8)
  const search = page.getByPlaceholder("Search repositories")
  await search.fill("gitcub")
  const discover = page.getByRole("button", { name: "Discover", exact: true })
  const repositories = page.getByRole("button", { name: "Repositories", exact: true })
  await expect(repositories).toHaveAttribute("aria-current", "page")
  await discover.click()
  await expect(canvas).toHaveAttribute("data-page", "0")
  await expect(discover).toHaveAttribute("aria-current", "page")
  await expect(repositories).not.toHaveAttribute("aria-current", "page")
  await expect
    .poll(async () => Math.round((await page.locator('[data-floating-board="trending"]').boundingBox())!.x))
    .toBe(8)
  const trending = page.getByRole("region", { name: "GitHub Trending", exact: true })
  await expect(trending.getByRole("button", { name: "Stop loading", exact: true })).toHaveCount(0)
  await expect(trending.getByRole("alert")).toHaveCount(0)
  await page.setViewportSize({ width: 1100, height: 760 })
  await trending.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(trending.getByRole("button", { name: "Stop loading", exact: true })).toHaveCount(0)
  await expect(trending.getByRole("alert")).toHaveCount(0)
  await page.setViewportSize({ width: 1000, height: 720 })
  await repositories.click()
  await expect(canvas).toHaveAttribute("data-page", "1")
  await expect(repositories).toHaveAttribute("aria-current", "page")
  await expect(discover).not.toHaveAttribute("aria-current", "page")
  await expect(page.getByRole("tablist", { name: "Discover", exact: true })).toBeVisible()
  await expect(search).toHaveValue("gitcub")
  await expect
    .poll(async () => Math.round((await page.locator('[data-floating-board="workspace"]').boundingBox())!.x))
    .toBe(256)
  await page.mouse.move(500, 400)
  await page.mouse.wheel(800, 0)
  await expect(canvas).toHaveAttribute("data-page", "1")
  await page.mouse.move(280, 550)
  await page.mouse.down({ button: "middle" })
  await page.mouse.move(950, 550, { steps: 24 })
  await page.mouse.up({ button: "middle" })
  await expect(canvas).toHaveAttribute("data-page", "0")
  await expect
    .poll(async () => Math.round((await page.locator('[data-floating-board="trending"]').boundingBox())!.x))
    .toBe(8)
  await page.screenshot({ path: info.outputPath("trending.png") })
  const navigation = page.locator("[data-canvas-navigation]")
  await expect(search).toBeVisible()
  await expect(search).toHaveValue("gitcub")
  expect((await navigation.boundingBox())!.x).toBeGreaterThan(700)
  await page.getByRole("button", { name: "Discover", exact: true }).click()
  await expect(canvas).toHaveAttribute("data-page", "0")
  await expect(page.getByRole("button", { name: "Discover", exact: true })).toHaveAttribute("aria-current", "page")
  await page.getByRole("button", { name: "Repositories", exact: true }).click()
  await expect(canvas).toHaveAttribute("data-page", "1")
  await expect(search).toHaveValue("gitcub")
  await expect
    .poll(async () => Math.round((await page.locator('[data-floating-board="workspace"]').boundingBox())!.x))
    .toBe(256) // 4px viewport inset + 248px navigation + 4px panel gutter.
  // Middle-button drag follows the same synthetic mouse stream as ALwith's native three-finger input.
  await page.mouse.move(280, 550)
  await page.mouse.down({ button: "middle" })
  await page.mouse.move(950, 550, { steps: 24 })
  await page.mouse.up({ button: "middle" })
  await expect(canvas).toHaveAttribute("data-page", "0")
  await expect
    .poll(async () => Math.round((await page.locator('[data-floating-board="trending"]').boundingBox())!.x))
    .toBe(8)
})
