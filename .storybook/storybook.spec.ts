import { readFileSync } from "node:fs"

import { expect, test } from "@playwright/test"

// Generated index keeps this acceptance suite in sync with every custom story.
const index: { entries: Record<string, { id: string; type: string; tags?: string[] }> } = JSON.parse(
  readFileSync(new URL("../storybook-static/index.json", import.meta.url), "utf8")
)
const tauriConfig: { app: { windows: { minWidth: number }[] } } = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")
)
const stories = Object.values(index.entries).filter(entry => entry.type === "story")
if (stories.length === 0) throw new Error("No custom stories found")

for (const theme of ["light", "dark"]) {
  for (const locale of ["en", "zh-CN"]) {
    for (const viewport of ["compact", "wide"]) {
      for (const story of stories) {
        test(`${story.id} / ${theme} / ${locale} / ${viewport}`, async ({ page }, testInfo) => {
          const errors: string[] = []
          page.on("pageerror", error => errors.push(error.message))
          page.on("console", message => {
            if (message.type() === "error") errors.push(message.text())
          })
          const narrowWidth = story.tags?.includes("desktop-window") ? tauriConfig.app.windows[0].minWidth : 360
          await page.setViewportSize({ width: viewport === "compact" ? narrowWidth : 1000, height: 720 })
          await page.goto(`/iframe.html?id=${story.id}&viewMode=story&globals=theme:${theme};locale:${locale}`)
          await expect(page.locator("html")).toHaveAttribute("data-story-finished", story.id, { timeout: 20_000 })
          const reports = await page.locator("html").getAttribute("data-story-reports")
          expect(await page.locator("html").getAttribute("data-story-status"), reports ?? "Storybook result").toBe(
            "success"
          )
          await expect(page.locator(`[data-gitcub-story="${story.id}"]`)).toBeAttached()
          await expect(page.locator("html")).toHaveAttribute("lang", locale)
          if (story.id.startsWith("changes-inline-error--")) {
            const trigger = page.locator("[data-slot=tooltip-trigger]")
            const tooltip = page.locator("[data-slot=tooltip-content]")
            await trigger.hover()
            await expect(tooltip).toBeVisible()
            await expect(tooltip).toContainText(
              story.id.endsWith("rate-limited") ? "API rate limit exceeded" : "a-long-path/"
            )
            await page.keyboard.press("Escape")
            await page.getByRole("textbox", { name: "Commit summary" }).click()
            await page.keyboard.press("Shift+Tab")
            await expect(trigger).toBeFocused()
            await expect(tooltip).toBeVisible()
            await page.keyboard.press("Escape")
            await expect(tooltip).toBeHidden()
          }
          expect(errors).toEqual([])
          if (
            [
              "discovery-window--overview",
              "discovery-trending--history-navigation",
              "ci-job-steps--failure",
              "changes-file-path--renamed",
              "settings-navigation--accounts",
              "onboarding-welcome--start",
              "onboarding-desktopimport--detected",
              "collaboration-pr-and-mr-list--confirm-retry-failed-ci",
              "diff-split-text--read-only",
              "diff-unified-text--selected",
              "changes-file-list--keyboard-navigation",
              "history-sidebar--compare-and-merge",
              "history-tags--search-and-push",
              "history-tags--no-tags"
            ].includes(story.id)
          ) {
            await page.screenshot({ path: testInfo.outputPath("preview.png") })
          }
        })
      }
    }
  }
}
