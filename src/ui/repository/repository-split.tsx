import type { ReactNode, Ref } from "react"
import type { PanelImperativeHandle } from "react-resizable-panels"

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"

export function RepositorySplit({
  sidebar,
  children,
  initialWidth = 250,
  panelRef,
  onResize
}: {
  sidebar: ReactNode
  children: ReactNode
  initialWidth?: number
  panelRef?: Ref<PanelImperativeHandle | null>
  onResize?: (width: number) => void
}) {
  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" data-repository-split>
      <ResizablePanel
        panelRef={panelRef}
        defaultSize={initialWidth}
        minSize={220}
        maxSize="45%"
        onResize={size => onResize?.(Math.round(size.inPixels))}>
        {sidebar}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel minSize="55%">{children}</ResizablePanel>
    </ResizablePanelGroup>
  )
}
