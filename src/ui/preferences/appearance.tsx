/* eslint-disable react/no-did-update-set-state -- Original state reset on account/theme/status prop changes. */
// Desktop MIT port; platform imports adapted to Tauri.

import { platform } from "@tauri-apps/plugin-os"
import * as React from "react"

import { tabSizeDefault } from "../../lib/desktop-defaults"
import { enableFormattingPreferences } from "../../lib/desktop-features"
import { formatNumber } from "../../lib/format-number"
import { ApplicationTheme, getCurrentlyAppliedTheme, supportsSystemThemeChanges } from "../../lib/ui/application-theme"
import {
  type DateFormat,
  dateFormats,
  type INumberFormat,
  numberFormats,
  numberFormatToKey,
  type TimeFormat,
  timeFormats
} from "../../models/formatting-preferences"
import { Checkbox, CheckboxValue } from "../desktop/checkbox"
import { DialogContent } from "../desktop/dialog"
import { RadioGroup } from "../desktop/radio-group"
import { Row } from "../desktop/row"
import { Select } from "../desktop/select"

interface IAppearanceProps {
  readonly selectedTheme: ApplicationTheme
  readonly onSelectedThemeChanged: (theme: ApplicationTheme) => void
  readonly selectedTabSize: number
  readonly onSelectedTabSizeChanged: (tabSize: number) => void
  readonly alwaysShowWorktreeList: boolean
  readonly onAlwaysShowWorktreeListChanged: (value: boolean) => void
  readonly selectedDateFormat: DateFormat
  readonly onSelectedDateFormatChanged: (format: DateFormat) => void
  readonly selectedTimeFormat: TimeFormat
  readonly onSelectedTimeFormatChanged: (format: TimeFormat) => void
  readonly selectedNumberFormat: INumberFormat
  readonly onSelectedNumberFormatChanged: (format: INumberFormat) => void
  readonly preferAbsoluteDates: boolean
  readonly onPreferAbsoluteDatesChanged: (value: boolean) => void
}

interface IAppearanceState {
  readonly selectedTheme: ApplicationTheme | null
  readonly selectedTabSize: number
}

export class Appearance extends React.Component<IAppearanceProps, IAppearanceState> {
  public constructor(props: IAppearanceProps) {
    super(props)

    const usePropTheme = props.selectedTheme !== ApplicationTheme.System || supportsSystemThemeChanges()

    this.state = {
      selectedTheme: usePropTheme ? props.selectedTheme : null,
      selectedTabSize: props.selectedTabSize
    }

    if (!usePropTheme) {
      this.initializeSelectedTheme()
    }
  }

  public async componentDidUpdate(prevProps: IAppearanceProps) {
    if (prevProps === this.props) {
      return
    }

    const usePropTheme = this.props.selectedTheme !== ApplicationTheme.System || supportsSystemThemeChanges()

    const selectedTheme = usePropTheme ? this.props.selectedTheme : await getCurrentlyAppliedTheme()

    const selectedTabSize = this.props.selectedTabSize

    this.setState({ selectedTheme, selectedTabSize })
  }

  private initializeSelectedTheme = async () => {
    const selectedTheme = await getCurrentlyAppliedTheme()
    const selectedTabSize = this.props.selectedTabSize

    this.setState({ selectedTheme, selectedTabSize })
  }

  private onSelectedThemeChanged = (theme: ApplicationTheme) => {
    this.props.onSelectedThemeChanged(theme)
  }

  private onSelectedTabSizeChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    this.props.onSelectedTabSizeChanged(Number.parseInt(event.currentTarget.value))
  }

  private onDateFormatChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    const value = event.currentTarget.value
    const match = dateFormats.find(f => f.pattern === value)
    if (match !== undefined) {
      this.props.onSelectedDateFormatChanged(match.pattern)
    }
  }

  private onTimeFormatChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    const value = event.currentTarget.value
    const match = timeFormats.find(f => f.pattern === value)
    if (match !== undefined) {
      this.props.onSelectedTimeFormatChanged(match.pattern)
    }
  }

  private onNumberFormatChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    const match = numberFormats.find(n => numberFormatToKey(n) === event.currentTarget.value)
    if (match) {
      this.props.onSelectedNumberFormatChanged(match)
    }
  }

  private onPreferAbsoluteDatesChanged = (checked: boolean) => {
    this.props.onPreferAbsoluteDatesChanged(checked)
  }

  private onAlwaysShowWorktreeListChanged = (checked: boolean) => {
    this.props.onAlwaysShowWorktreeListChanged(checked)
  }

  public renderThemeSwatch = (theme: ApplicationTheme) => {
    const darkThemeImage = "/static/ghd_dark.svg"
    const lightThemeImage = "/static/ghd_light.svg"

    switch (theme) {
      case ApplicationTheme.Light:
        return (
          <span>
            <img src={lightThemeImage} alt="" />
            <span className="theme-value-label">Light</span>
          </span>
        )
      case ApplicationTheme.Dark:
        return (
          <span>
            <img src={darkThemeImage} alt="" />
            <span className="theme-value-label">Dark</span>
          </span>
        )
      case ApplicationTheme.System:
        /** Why three images? The system theme swatch uses the first image
         * positioned relatively to get the label container size and uses the
         * second and third positioned absolutely over first and third one
         * clipped in half to render a split dark and light theme swatch. */
        return (
          <span>
            <span className="system-theme-swatch">
              <img src={lightThemeImage} alt="" />
              <img src={lightThemeImage} alt="" />
              <img src={darkThemeImage} alt="" />
            </span>
            <span className="theme-value-label">System</span>
          </span>
        )
    }
  }

  private renderSelectedTheme() {
    const selectedTheme = this.state.selectedTheme

    if (selectedTheme == null) {
      return <Row>Loading system theme</Row>
    }

    const themes = [
      ApplicationTheme.Light,
      ApplicationTheme.Dark,
      ...(supportsSystemThemeChanges() ? [ApplicationTheme.System] : [])
    ]

    return (
      <div className="appearance-section">
        <h2 id="theme-heading">Theme</h2>

        <RadioGroup<ApplicationTheme>
          ariaLabelledBy="theme-heading"
          className="theme-selector"
          selectedKey={selectedTheme}
          radioButtonKeys={themes}
          onSelectionChanged={this.onSelectedThemeChanged}
          renderRadioButtonLabelContents={this.renderThemeSwatch}
        />
      </div>
    )
  }

  private renderFormatting() {
    if (!enableFormattingPreferences()) {
      return null
    }

    return (
      <div className="appearance-section formatting-section">
        <h2 id="formatting-heading">Formatting</h2>

        <Row>
          <Select
            label={platform() === "macos" ? "Date Format" : "Date format"}
            value={this.props.selectedDateFormat}
            onChange={this.onDateFormatChanged}>
            {dateFormats.map(({ pattern, example }) => (
              <option key={pattern} value={pattern}>
                {example} ({pattern})
              </option>
            ))}
          </Select>

          <Select
            label={platform() === "macos" ? "Time Format" : "Time format"}
            value={this.props.selectedTimeFormat}
            onChange={this.onTimeFormatChanged}>
            {timeFormats.map(({ pattern, example }) => (
              <option key={pattern} value={pattern}>
                {example} ({pattern})
              </option>
            ))}
          </Select>
        </Row>

        <Select
          label={platform() === "macos" ? "Number Format" : "Number format"}
          value={numberFormatToKey(this.props.selectedNumberFormat)}
          onChange={this.onNumberFormatChanged}>
          {numberFormats.map(format => (
            <option key={numberFormatToKey(format)} value={numberFormatToKey(format)}>
              {formatNumber(1234567.89, format)}
            </option>
          ))}
        </Select>

        <Checkbox
          className="prefer-absolute-dates"
          label="Prefer absolute dates over relative"
          value={this.props.preferAbsoluteDates ? CheckboxValue.On : CheckboxValue.Off}
          onChange={this.onPreferAbsoluteDatesChanged}
        />
      </div>
    )
  }

  private renderMiscellaneous() {
    const availableTabSizes: number[] = [1, 2, 3, 4, 5, 6, 8, 10, 12]

    return (
      <div className="appearance-section">
        <h2 id="miscellaneous-heading">Miscellaneous</h2>

        <Select
          value={this.state.selectedTabSize.toString()}
          label={platform() === "macos" ? "Diff Tab Size" : "Diff tab size"}
          onChange={this.onSelectedTabSizeChanged}>
          {availableTabSizes.map(n => (
            <option key={n} value={n}>
              {n === tabSizeDefault ? `${n} (default)` : n}
            </option>
          ))}
        </Select>

        <Checkbox
          className="always-show-worktree-list"
          label="Always show worktree list"
          value={this.props.alwaysShowWorktreeList ? CheckboxValue.On : CheckboxValue.Off}
          onChange={this.onAlwaysShowWorktreeListChanged}
        />
      </div>
    )
  }

  public render() {
    return (
      <DialogContent>
        {this.renderSelectedTheme()}
        {this.renderFormatting()}
        {this.renderMiscellaneous()}
      </DialogContent>
    )
  }
}
