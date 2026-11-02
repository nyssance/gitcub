// Desktop bebc062: same failed/all choice and keyboard behavior, using Base UI.
import { APICheckConclusion } from "../../lib/api"
import type { IRefCheck } from "../../lib/ci-checks/ci-checks"
import i18n from "../../lib/i18n"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Octicon, syncClockwise } from "../octicons"
import * as octicons from "../octicons/octicons.generated"

export function CICheckReRunButton(props: {
  disabled: boolean
  checkRuns: ReadonlyArray<IRefCheck>
  canReRunFailed: boolean
  onRerunChecks: (failedOnly: boolean) => void
}) {
  const failed = props.canReRunFailed && props.checkRuns.some(check => check.conclusion === APICheckConclusion.Failure)
  if (!failed)
    return (
      <Button variant="outline" disabled={props.disabled} onClick={() => props.onRerunChecks(false)}>
        <Octicon symbol={syncClockwise} />
        {i18n.t("ci.rerunChecks")}
      </Button>
    )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" disabled={props.disabled} />}>
        <Octicon symbol={syncClockwise} />
        {i18n.t("ci.rerun")} <Octicon symbol={octicons.triangleDown} />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => props.onRerunChecks(true)}>{i18n.t("ci.rerunFailed")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => props.onRerunChecks(false)}>{i18n.t("ci.rerunAll")}</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
