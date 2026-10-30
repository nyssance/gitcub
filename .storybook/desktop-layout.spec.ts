import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { basename } from "node:path"

import { expect, test } from "@playwright/test"

// Compare the production DOM with the actual upstream stylesheet, not a second
// hand-written set of expected widths. This checks CSS parity, not DOM parity.
const upstream = new URL("../tests/conformance/fixtures/desktop-ui-styles/", import.meta.url)
const read = (path: string) => readFileSync(new URL(path, upstream), "utf8")
const stylesheet = read("_side-by-side-diff.scss").replaceAll(/\/\/[^\n]*/g, "")
const variables = read("_variables.scss")
const spacing = variables.match(/--spacing:\s*([^;]+);/)![1]
const radius = variables.match(/--border-radius:\s*([^;]+);/)![1]
const emojiFonts = variables.match(/\$emoji_fallback_fonts:\s*([^;]+);/)![1]
const monoFont = variables
  .match(/--font-family-monospace:\s*([^;]+);/)![1]
  .replace("#{$emoji_fallback_fonts}", emojiFonts)
const srOnly = read("_app.scss").match(/\.sr-only\s*\{[^}]+\}/)![0]
const themes: Record<string, string> = JSON.parse(read("compiled-themes.json"))
const wordHighlights = read("_diff.scss")
  .match(/\.cm-diff-(?:delete|add)-inner\s*\{[^}]+\}/g)!
  .slice(0, 2)
  .join("\n")
const referenceCss = `
  html { box-sizing: border-box; }
  *, *::before, *::after { box-sizing: inherit; }
  body { margin: 0; }
  :root {
    --spacing: ${spacing}; --spacing-half: calc(var(--spacing) / 2);
    --border-radius: ${radius}; --font-size-sm: 11px;
    --font-family-monospace: ${monoFont};
    --diff-border-color: black;
  }
  ${srOnly}
  ${read("_octicons.scss")}
  ${stylesheet}
  ${wordHighlights}
`

test("Desktop stylesheet snapshots retain upstream hashes", () => {
  const source: { files: Record<string, string> } = JSON.parse(read("source.json"))
  for (const [path, hash] of Object.entries(source.files)) {
    expect(
      createHash("sha256")
        .update(read(basename(path)))
        .digest("hex"),
      path
    ).toBe(hash)
  }
})

for (const theme of ["light", "dark"]) {
  for (const story of [
    "diff-unified-text--selected",
    "diff-unified-text--unselected",
    "diff-unified-text--read-only",
    "diff-split-text--selectable",
    "diff-split-text--read-only"
  ]) {
    test(`Desktop stylesheet geometry / ${theme} / ${story}`, async ({ page, context }, testInfo) => {
      await page.goto(`/iframe.html?id=${story}&viewMode=story&globals=theme:${theme}`)
      await expect(page.locator("html")).toHaveAttribute("data-story-finished", story)
      const root = page.locator(".side-by-side-diff-container")
      const size = await root.boundingBox()
      expect(size).not.toBeNull()
      const reference = await context.newPage()
      await reference.setContent(
        `<style>${referenceCss}\n:root { ${themes[":root"]} ${theme === "dark" ? themes["body.theme-dark"] : ""} }</style><main style="display:flex;flex-direction:column;width:${size!.width}px;height:${size!.height}px">${await root.evaluate(e => e.outerHTML)}</main>`
      )
      const focusedId = await page.evaluate(() => document.activeElement?.id)
      if (focusedId) await reference.evaluate(id => document.getElementById(id)?.focus(), focusedId)
      const selector =
        ".line-number, .line-number > label, .line-number > label > span, .line-number-check, .hunk-handle, .focus-handle, .hunk-expansion-handle, .octicon, .cm-diff-add-inner, .cm-diff-delete-inner"
      const measure = (elements: Element[]) =>
        elements.map(element => {
          const style = getComputedStyle(element)
          return {
            className: element.className,
            width: element.getBoundingClientRect().width,
            height: element.getBoundingClientRect().height,
            boxSizing: style.boxSizing,
            display: style.display,
            flexShrink: style.flexShrink,
            padding: style.padding,
            borderRadius: style.borderRadius,
            borderWidth: style.borderWidth,
            borderColor: style.borderColor,
            backgroundColor: style.backgroundColor,
            color: style.color,
            fontSize: style.fontSize,
            fontFamily: style.fontFamily
          }
        })
      const measureExpected = async () => {
        const expected = await reference.locator(".side-by-side-diff-container").locator(selector).evaluateAll(measure)
        // Documented GitCub accessibility difference: white text reaches 4.5:1
        // on Desktop's original green word highlight. Keep every other value exact.
        for (const element of expected) {
          if (theme === "dark" && element.className === "cm-diff-add-inner") {
            expect(element.backgroundColor).toBe("rgb(34, 134, 58)")
            expect(element.color).toBe("rgb(246, 248, 250)")
            element.color = "rgb(255, 255, 255)"
            element.borderColor = "rgb(255, 255, 255)"
          }
        }
        return expected
      }
      expect(await root.locator(selector).evaluateAll(measure)).toEqual(await measureExpected())
      if (story.endsWith("--selected")) {
        await root.screenshot({ path: testInfo.outputPath("gitcub.png") })
        await reference
          .locator(".side-by-side-diff-container")
          .screenshot({ path: testInfo.outputPath("desktop-reference.png") })
      }
      const selectable = root.locator(".line-number.selectable").first()
      if (await selectable.count()) {
        await selectable.hover()
        await reference.locator(".line-number.selectable").first().hover()
        expect(await root.locator(selector).evaluateAll(measure)).toEqual(await measureExpected())
      }
      await reference.close()
    })
  }
}
