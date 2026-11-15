import { type ComponentProps, lazy, Suspense } from "react"

import { Spinner } from "@/components/ui/spinner"

const Diff = lazy(() => import("./diff").then(module => ({ default: module.DiffView })))

export function DiffView(props: ComponentProps<typeof Diff>) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-0 flex-1 items-center justify-center" aria-busy="true">
          <Spinner />
        </div>
      }>
      <Diff {...props} />
    </Suspense>
  )
}
