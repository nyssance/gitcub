import "../../src/lib/browser-runtime"
import { createRoot } from "react-dom/client"

import { FloatingWorkspace } from "../../src/ui/layout/floating-workspace"
import "../../src/styles/globals.css"
import "../../src/lib/i18n"

createRoot(document.getElementById("root")!).render(
  <FloatingWorkspace page={1} onPageChange={() => {}} navigation={<div>Repositories</div>}>
    <div>Workspace</div>
  </FloatingWorkspace>
)
