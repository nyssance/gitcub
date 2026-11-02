import type { Parser } from "@lezer/common"
import { parser as cssParser } from "@lezer/css"
import { configureNesting, parser as htmlParser } from "@lezer/html"
import { parser as javascriptParser } from "@lezer/javascript"
import { parser as jsonParser } from "@lezer/json"
import { parseCode, parser as markdownParser } from "@lezer/markdown"
import { parser as pythonParser } from "@lezer/python"
import { parser as rustParser } from "@lezer/rust"
import { parser as yamlParser } from "@lezer/yaml"

/** 按扩展名选语法高亮。按需引入，用多少装多少——
 *  这正是相对 Monaco 的取舍：不开箱几十种，但也不背几 MB 的包。
 *
 *  这里直接用 @lezer 解析器，不经过 @codemirror/lang-*：那些包是给编辑器用的，
 *  会把 @codemirror/view 和 autocomplete 整个拖进 worker，而 worker 只需要语法树。
 *  各解析器的 dialect 与混合嵌套照抄对应 @codemirror/lang-* 的配置；
 *  缩进、折叠、补全那些 props 只影响编辑器，不影响高亮，故不复制。 */

// @codemirror/lang-javascript：javascriptLanguage 及其三个 dialect 变体
const typescript = javascriptParser.configure({ dialect: "ts" })
const jsx = javascriptParser.configure({ dialect: "jsx" })
const tsx = javascriptParser.configure({ dialect: "jsx ts" })

// @codemirror/lang-html：defaultNesting / defaultAttrs / eventAttributes
const eventAttributes = (
  "beforeunload copy cut dragstart dragover dragleave dragenter dragend " +
  "drag paste focus blur change click load mousedown mouseenter mouseleave " +
  "mouseup keydown keyup resize scroll unload"
)
  .split(" ")
  .map(n => `on${n}`)
const nesting = configureNesting(
  [
    { tag: "script", attrs: attrs => attrs.type == "text/typescript" || attrs.lang == "ts", parser: typescript },
    { tag: "script", attrs: attrs => attrs.type == "text/babel" || attrs.type == "text/jsx", parser: jsx },
    { tag: "script", attrs: attrs => attrs.type == "text/typescript-jsx", parser: tsx },
    {
      tag: "script",
      attrs: attrs => /^(importmap|speculationrules|application\/(.+\+)?json)$/i.test(attrs.type),
      parser: javascriptParser.configure({ top: "SingleExpression" })
    },
    {
      tag: "script",
      attrs: attrs => !attrs.type || /^(?:text|application)\/(?:x-)?(?:java|ecma)script$|^module$|^$/i.test(attrs.type),
      parser: javascriptParser
    },
    {
      tag: "style",
      attrs: attrs =>
        (!attrs.lang || attrs.lang == "css") && (!attrs.type || /^(text\/)?(x-)?(stylesheet|css)$/i.test(attrs.type)),
      parser: cssParser
    }
  ],
  [
    { name: "style", parser: cssParser.configure({ top: "Styles" }) },
    ...eventAttributes.map(name => ({ name, parser: javascriptParser }))
  ]
)
const html = htmlParser.configure({ wrap: nesting })

// @codemirror/lang-markdown：markdown() 默认以 commonmark 为底，
// 不开 GFM，围栏代码块不嵌套语言，内联 HTML 用 noMatch 方言的 html 解析器
const markdown = markdownParser.configure(
  parseCode({ htmlParser: htmlParser.configure({ wrap: nesting, dialect: "noMatch" }) })
)

export function languageOf(path: string): Parser | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return typescript
    case "tsx":
      return tsx
    case "js":
    case "mjs":
    case "cjs":
      return javascriptParser
    case "jsx":
      return jsx
    case "rs":
      return rustParser
    case "py":
      return pythonParser
    case "json":
    case "jsonc":
      return jsonParser
    case "css":
    case "scss":
    case "less":
      return cssParser
    case "html":
    case "htm":
      return html
    case "md":
    case "mdx":
      return markdown
    case "yaml":
    case "yml":
      return yamlParser
    default:
      return null
  }
}
