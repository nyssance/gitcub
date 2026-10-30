import { expect, test } from "@playwright/test"
for (const theme of ["light", "dark"]) {
  test(`Desktop CI popover dimensions and ReUI steps / ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1000, height: 720 })
    const story = "collaboration-pr-and-mr-list--git-hub-failure-automatically-expands"
    await page.goto(`/iframe.html?id=${story}&viewMode=story&globals=theme:${theme};locale:en`)
    await expect(page.locator("html")).toHaveAttribute("data-story-finished", story, { timeout: 20_000 })
    await expect(page.locator("html")).toHaveAttribute("data-story-status", "success")
    const popover = page.locator(".desktop-ci-popover")
    await expect(popover).toBeVisible()
    const box = await popover.boundingBox()
    expect(box?.width).toBe(440)
    const rerun = await popover.getByRole("button", { name: "Re-run", exact: true }).boundingBox()
    expect(rerun?.height).toBeLessThanOrEqual(40)
    const stepIndicator = await popover.locator('[data-slot="stepper-indicator"]').boundingBox()
    expect(stepIndicator?.width).toBe(24)
    await expect(popover.getByText("Build workflow", { exact: true })).toBeVisible()
    await expect(popover.getByText("Compile", { exact: true })).toBeVisible()
    await expect(popover.locator('[data-slot="stepper-item"]')).toHaveCount(1)
    await popover.screenshot({ path: testInfo.outputPath(`desktop-ci-${theme}.png`) })
    await page.keyboard.press("Escape")
    await expect(popover).not.toBeVisible()
  })
}

for (const theme of ["light", "dark"]) {
  test(`Desktop PR rows retain 47px and a single toolbar / ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 800, height: 600 })
    const story = "collaboration-pr-and-mr-list--keyboard-checkout"
    await page.goto(`/iframe.html?id=${story}&viewMode=story&globals=theme:${theme};locale:en`)
    await expect(page.locator("html")).toHaveAttribute("data-story-finished", story, { timeout: 20_000 })
    await expect(page.locator("html")).toHaveAttribute("data-story-status", "success")
    const rows = page.getByRole("listitem")
    await expect(rows).toHaveCount(2)
    for (const row of await rows.all()) {
      const rect = await row.boundingBox()
      expect(rect?.height).toBe(47)
      const content = await row.locator(".list-item-content-wrapper").boundingBox()
      expect(content?.height).toBe(47)
      for (const button of await row.getByRole("button").all()) {
        const box = await button.boundingBox()
        expect(box!.y).toBeGreaterThanOrEqual(rect!.y)
        expect(box!.y + box!.height).toBeLessThanOrEqual(rect!.y + rect!.height)
      }
    }
    const search = await page.getByRole("textbox").boundingBox()
    const refresh = await page.getByRole("button", { name: "Refresh" }).boundingBox()
    expect(Math.abs(search!.y + search!.height / 2 - refresh!.y - refresh!.height / 2)).toBeLessThan(1)
    await page.screenshot({ path: testInfo.outputPath(`pr-list-${theme}.png`) })
  })
}
