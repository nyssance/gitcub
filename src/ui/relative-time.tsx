// Desktop MIT port; platform imports adapted to Tauri.
import * as React from "react"

import { formatDate } from "../lib/format-date"
import i18n from "../lib/i18n"
import { TooltippedContent } from "./desktop/tooltipped-content"

interface IRelativeTimeProps {
  /**
   * The date instance that will be used for calculating
   * the relative time elapsed
   */
  readonly date: Date

  /**
   * By default the RelativeTime component will start displaying a compact
   * absolute date if the date is more than one week ago. Setting `onlyRelative`
   * to true overrides this behavior and forces relative times for all dates.
   */
  readonly onlyRelative?: boolean

  readonly className?: string

  /** Whether to show a tooltip with the absolute date on hover - Default = true */
  readonly tooltip?: boolean
}

interface IRelativeTimeState {
  readonly absoluteText: string
  readonly relativeText: string
}

const SECOND = 1000
const MINUTE = SECOND * 60
const HOUR = MINUTE * 60
const DAY = HOUR * 24

// The maximum value that can be used in setInterval or
// setTimeout without it overflowing (2 ^ 31 - 1). See
/** 原版 format-relative.ts 的阈值，但按界面语言格式化（原版写死 en-US，中文界面里会出现「22 hours ago」）。 */
function formatRelative(ms: number) {
  const formatter = new Intl.RelativeTimeFormat(i18n.language || "en-US", { numeric: "auto" })
  const sign = ms < 0 ? -1 : 1
  const sec = Math.round(Math.abs(ms) / 1000)
  const min = Math.round(sec / 60)
  const hr = Math.round(min / 60)
  const day = Math.round(hr / 24)
  const month = Math.round(day / 30)
  const year = Math.round(month / 12)
  if (sec < 45) return formatter.format(sec * sign, "second")
  if (min < 45) return formatter.format(min * sign, "minute")
  if (hr < 24) return formatter.format(hr * sign, "hour")
  if (day < 30) return formatter.format(day * sign, "day")
  if (month < 18) return formatter.format(month * sign, "month")
  return formatter.format(year * sign, "year")
}

//  http://stackoverflow.com/a/16314807
const MAX_INTERVAL = 2147483647

type RelativeTimeInfo = {
  absoluteText: string
  relativeText: string
  duration?: number
}

export function getRelativeTimeInfoFromDate(then: Date, onlyRelative: boolean = true): RelativeTimeInfo {
  const diff = then.getTime() - Date.now()
  const duration = Math.abs(diff)

  const absoluteText = formatDate(then, {
    dateStyle: "full",
    timeStyle: "short"
  })

  const relativeText = formatRelative(diff)

  // Future date, let's just show as absolute and reschedule. If it's less
  // than a minute into the future we'll treat it as 'just now'.
  if (diff > 0 && duration > MINUTE) {
    return {
      absoluteText,
      relativeText: formatDate(then, {
        dateStyle: "medium",
        timeStyle: "short"
      }),
      duration
    }
  } else if (duration < MINUTE) {
    return {
      absoluteText,
      relativeText: i18n.language.startsWith("en")
        ? "just now"
        : new Intl.RelativeTimeFormat(i18n.language).format(0, "second"),
      duration: MINUTE - duration
    }
  } else if (duration < HOUR) {
    return { absoluteText, relativeText, duration: MINUTE }
  } else if (duration < DAY) {
    return { absoluteText, relativeText, duration: HOUR }
  } else if (duration < 7 * DAY) {
    return { absoluteText, relativeText, duration: 6 * HOUR }
  } else {
    if (onlyRelative) {
      return { absoluteText, relativeText, duration: 6 * HOUR }
    } else {
      // More than a week ago, just the date will suffice
      return {
        absoluteText,
        relativeText: formatDate(then, { time: false, dateStyle: "medium" })
      }
    }
  }
}

/**
 * An auto-updating component rendering a relative time in human readable form.
 *
 * Example: 'just now', '4 minutes ago', '3 days ago'.
 * or if abbreviated: 'just now', '4m', '3d'.
 *
 * For timestamps that are more than 7 days in the past the absolute
 * date is rendered instead.
 *
 * This component will automatically re-render when the relative time
 * changes by scheduling state changes at reasonable intervals.
 */
export class RelativeTime extends React.Component<IRelativeTimeProps, IRelativeTimeState> {
  private timer: number | null = null

  public constructor(props: IRelativeTimeProps) {
    super(props)
    this.state = { absoluteText: "", relativeText: "" }
  }

  private clearTimer() {
    if (this.timer) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
  }

  private updateAndSchedule(absoluteText: string, relativeText: string, timeout: number) {
    this.clearTimer()
    this.timer = window.setTimeout(this.updateFromScheduler, Math.min(timeout, MAX_INTERVAL))
    this.setState({ absoluteText, relativeText })
  }

  private updateWithDate(then: Date) {
    const { onlyRelative } = this.props

    const { absoluteText, relativeText, duration } = getRelativeTimeInfoFromDate(then, onlyRelative)

    if (duration !== undefined) {
      this.updateAndSchedule(absoluteText, relativeText, duration)
    } else {
      this.setState({ absoluteText, relativeText })
    }
  }

  private readonly updateFromScheduler = () => {
    this.updateWithDate(this.props.date)
  }

  public componentWillReceiveProps(nextProps: IRelativeTimeProps) {
    if (this.props.date !== nextProps.date) {
      this.updateWithDate(nextProps.date)
    }
  }

  public componentWillMount() {
    this.updateWithDate(this.props.date)
  }

  public componentWillUnmount() {
    this.clearTimer()
  }

  public shouldComponentUpdate(nextProps: IRelativeTimeProps, nextState: IRelativeTimeState) {
    return (
      nextProps.date !== this.props.date ||
      nextState.absoluteText !== this.state.absoluteText ||
      nextState.relativeText !== this.state.relativeText
    )
  }

  public render() {
    if (this.props.tooltip === false) {
      return <span className={this.props.className}>{this.state.relativeText}</span>
    }

    return (
      <TooltippedContent className={this.props.className} tooltip={this.state.absoluteText}>
        {this.state.relativeText}
      </TooltippedContent>
    )
  }
}
