import { observeTrackpad } from "@nyssance/atlas/dom"
import { tauriTrackpad } from "@nyssance/atlas/tauri"
import { useEffect, useState } from "react"

export function useTrackpadAvailability() {
  const [available, setAvailable] = useState<boolean | null>(null)
  useEffect(
    () => observeTrackpad(tauriTrackpad(), setAvailable, error => console.error("Trackpad detection failed", error)),
    []
  )
  return available
}
