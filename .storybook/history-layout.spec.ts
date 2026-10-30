import { expect, test } from "@playwright/test"

for (const width of [800, 1200]) {
  test(`history keeps paths, avatars and diff inside their columns at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 740 })
    await page.route("https://avatars.githubusercontent.com/**", route =>
      width === 800
        ? route.abort()
        : route.fulfill({
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#444"/><circle cx="16" cy="12" r="6" fill="#fff"/><path d="M5 32v-5a11 11 0 0 1 22 0v5" fill="#fff"/></svg>'
          })
    )
    await page.goto("/iframe.html?id=history-window--long-paths&viewMode=story&globals=locale:en;theme:light")
    await expect(page.locator("html")).toHaveAttribute("data-story-finished", "history-window--long-paths", {
      timeout: 20_000
    })
    const outer = page.locator("[data-repository-split]")
    const panels = outer.locator(':scope > [data-slot="resizable-panel"]')
    const details = page.locator("[data-commit-details]")
    const innerPanels = details.locator(':scope > [data-slot="resizable-panel"]')
    const assertWidths = async () => {
      const total = (await outer.boundingBox())!.width
      expect((await panels.nth(0).boundingBox())!.width).toBeLessThanOrEqual(total * 0.45 + 1)
      expect((await panels.nth(1).boundingBox())!.width).toBeGreaterThanOrEqual(total * 0.55 - 1)
      const detailWidth = (await details.boundingBox())!.width
      expect((await innerPanels.nth(1).boundingBox())!.width).toBeGreaterThanOrEqual(detailWidth * 0.6 - 1)
    }
    await assertWidths()
    const separator = outer.locator(':scope > [data-slot="resizable-handle"]')
    const box = (await separator.boundingBox())!
    await page.mouse.move(box.x, box.y + 100)
    await page.mouse.down()
    await page.mouse.move(width - 10, box.y + 100, { steps: 8 })
    await page.mouse.up()
    await assertWidths()
    const rows = innerPanels.nth(0).locator('[data-slot="item"]')
    await expect(rows).toHaveCount(4)
    for (const row of await rows.all()) {
      const title = (await row.locator('[data-slot="item-title"]').boundingBox())!
      const status = (await row.locator('[data-slot="item-actions"]').boundingBox())!
      const bounds = (await row.boundingBox())!
      expect(title.x + title.width).toBeLessThanOrEqual(status.x)
      expect(status.x + status.width).toBeLessThanOrEqual(bounds.x + bounds.width)
    }
    const avatars = panels.nth(0).locator('[data-slot="avatar"]')
    expect(
      (await panels.nth(0).locator('[title="Update plugin content (#104)"]').boundingBox())!.width
    ).toBeGreaterThan(60)
    expect(await avatars.count()).toBeGreaterThan(0)
    await expect(
      avatars.first().locator(width === 800 ? '[data-slot="avatar-fallback"]' : '[data-slot="avatar-image"]')
    ).toBeVisible()
    const author = avatars.first().locator("..")
    expect((await author.boundingBox())!.height).toBeLessThan(25)
    await expect(page.getByRole("link", { name: "#104" })).toBeVisible()
    await expect(page.getByRole("button", { name: "#104" })).toHaveCount(0)
    await page.screenshot({ path: info.outputPath("history.png") })
  })
}
