// Preserve original positional keys for immutable token segments.
// Desktop MIT port; platform imports adapted to Tauri.

import memoizeOne from "memoize-one"
import * as React from "react"

import { linkifyTokens } from "../../lib/autolink-rules"
import type { RefSet } from "../../lib/autolinks"
import { Tokenizer, type TokenResult, TokenType } from "../../lib/text-token-parser"
import { createObservableRef } from "../../lib/ui/observable-ref"
import type { Repository } from "../../models/repository"
import type { Emoji } from "../../upstream/lib/emoji"
import { assertNever } from "../../upstream/lib/fatal-error"
import { LinkButton } from "./link-button"
import { Tooltip } from "./tooltip"

interface IRichTextProps {
  readonly className?: string

  /** A lookup of emoji characters to map to image resources */
  readonly emoji: Map<string, Emoji>

  /**
   * The raw text to inspect for things to highlight or an array
   * of tokens already compiled by the `Tokenizer` class in
   * `text-token-parser.ts`. If a string is provided the component
   * will call upon the Tokenizer to product a list of tokens.
   */
  readonly text: string | ReadonlyArray<TokenResult>

  /** Should URLs be rendered as clickable links. Default true. */
  readonly renderUrlsAsLinks?: boolean

  /**
   * The repository to use as the source for URLs for the rich text.
   *
   * If not specified, or the repository is a non-GitHub repository,
   * no link highlighting is performed.
   */
  readonly repository?: Repository

  /**
   * GitLens autolink reference sets (user rules plus GitLab built-ins) applied to the
   * plain-text tokens after the Desktop tokenizer; Desktop's own tokens are left as they are.
   */
  readonly autolinks?: ReadonlyArray<RefSet>
}

function getElements(
  emoji: Map<string, Emoji>,
  repository: Repository | undefined,
  renderUrlsAsLinks: boolean | undefined,
  text: string | ReadonlyArray<TokenResult>,
  autolinks: ReadonlyArray<RefSet> | undefined
) {
  const tokenizer = new Tokenizer(emoji, repository)
  const tokens = linkifyTokens(typeof text === "string" ? tokenizer.tokenize(text) : text, autolinks ?? [])

  return tokens.map((token, index) => {
    switch (token.kind) {
      case TokenType.Emoji:
        if (token.emoji) {
          return <span key={index}>{token.emoji}</span>
        } else {
          return <img key={index} alt={token.description ?? token.text} className="emoji" src={token.path} />
        }
      case TokenType.Link:
        if (renderUrlsAsLinks !== false) {
          const title = token.text !== token.url ? token.url : undefined
          return (
            <LinkButton key={index} uri={token.url} title={title}>
              {token.text}
            </LinkButton>
          )
        } else {
          return <span key={index}>{token.text}</span>
        }
      case TokenType.Text:
        return <span key={index}>{token.text}</span>
      case "autolink":
        if (renderUrlsAsLinks !== false) {
          return (
            <LinkButton key={index} uri={token.url} title={token.title ?? token.url}>
              {token.text}
            </LinkButton>
          )
        } else {
          return <span key={index}>{token.text}</span>
        }
      default:
        return assertNever(token, `Unknown token type: ${token}`)
    }
  })
}

interface IRichTextState {
  readonly overflowed: boolean
}

/**
 * A component which replaces any emoji shortcuts (e.g., :+1:) in its child text
 * with the appropriate image tag, and also highlights username and issue mentions
 * with hyperlink tags if it has a repository to read.
 */
export class RichText extends React.Component<IRichTextProps, IRichTextState> {
  private getElements = memoizeOne(getElements)
  private getTitle = memoizeOne((text: string | ReadonlyArray<TokenResult>) =>
    typeof text === "string" ? text : text.map(x => x.text).join("")
  )
  private containerRef = createObservableRef<HTMLDivElement>()
  private readonly resizeObserver: ResizeObserver
  private resizeDebounceId: number | null = null
  private lastKnownWidth: number | null = null

  public constructor(props: IRichTextProps) {
    super(props)
    this.state = { overflowed: false }
    this.containerRef.subscribe(this.onContainerRef)
    this.resizeObserver = new ResizeObserver(entries => {
      const newWidth = entries[0].contentRect.width

      if (this.lastKnownWidth !== newWidth) {
        this.lastKnownWidth = newWidth

        if (this.resizeDebounceId !== null) {
          cancelAnimationFrame(this.resizeDebounceId)
          this.resizeDebounceId = null
        }
        this.resizeDebounceId = requestAnimationFrame(() => this.onResized())
      }
    })
  }

  private onContainerRef = (elem: HTMLDivElement | null) => {
    if (elem === null) {
      this.resizeObserver.disconnect()
      return
    }

    this.resizeObserver.observe(elem)
    this.onResized(elem)
  }

  private onResized = (elem?: HTMLDivElement) => {
    elem ??= this.containerRef.current ?? undefined
    if (elem && elem.scrollWidth > elem.clientWidth) {
      this.setState({ overflowed: true })
    } else {
      this.setState({ overflowed: false })
    }
  }

  public render() {
    const { emoji, repository, renderUrlsAsLinks, text, autolinks } = this.props

    // If we've been given an empty string then return null so that we don't end
    // up introducing an extra empty <span>.
    if (text.length === 0) {
      return null
    }

    return (
      <div ref={this.containerRef} className={this.props.className}>
        {this.state.overflowed && <Tooltip target={this.containerRef}>{this.getTitle(text)}</Tooltip>}
        {this.getElements(emoji, repository, renderUrlsAsLinks, text, autolinks)}
      </div>
    )
  }
}
