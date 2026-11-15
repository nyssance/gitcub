// Desktop MIT port; platform imports adapted to Tauri.
import { getBoolean, setBoolean } from "../../upstream/lib/local-storage"

export const useExternalCredentialHelperDefault = false
export const useExternalCredentialHelperKey: string = "useExternalCredentialHelper"

export const useExternalCredentialHelper = () =>
  getBoolean(useExternalCredentialHelperKey, useExternalCredentialHelperDefault)

export const setUseExternalCredentialHelper = (value: boolean) => setBoolean(useExternalCredentialHelperKey, value)
