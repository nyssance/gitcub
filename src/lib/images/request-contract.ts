/** Request-filter contracts: transport-independent subset of Desktop WebRequest. */
export interface OnBeforeRequestListenerDetails {
  id: number
  url: string
  method: string
  resourceType: string
  referrer: string
  timestamp: number
}
export interface OnBeforeSendHeadersListenerDetails extends OnBeforeRequestListenerDetails {
  requestHeaders: Record<string, string>
}
export interface OnHeadersReceivedListenerDetails extends OnBeforeRequestListenerDetails {
  responseHeaders: Record<string, string[]>
  statusLine: string
  statusCode: number
}
export type OnBeforeRedirectListenerDetails = OnHeadersReceivedListenerDetails & { redirectURL: string }
export type OnCompletedListenerDetails = OnHeadersReceivedListenerDetails
export type OnErrorOccurredListenerDetails = OnBeforeRequestListenerDetails & { error: string }
export type OnResponseStartedListenerDetails = OnHeadersReceivedListenerDetails
export type OnSendHeadersListenerDetails = OnBeforeSendHeadersListenerDetails
export interface CallbackResponse {
  cancel?: boolean
  redirectURL?: string
}
export interface BeforeSendResponse {
  cancel?: boolean
  requestHeaders?: Record<string, string | string[]>
}
export interface HeadersReceivedResponse {
  cancel?: boolean
  responseHeaders?: Record<string, string | string[]>
  statusLine?: string
}
type Subscribe<T> = (listener: ((details: T) => void) | null) => void
type SubscribeAsync<T, R> = (listener: ((details: T, callback: (response: R) => void) => void) | null) => void
export interface WebRequest {
  onBeforeRequest: SubscribeAsync<OnBeforeRequestListenerDetails, CallbackResponse>
  onBeforeSendHeaders: SubscribeAsync<OnBeforeSendHeadersListenerDetails, BeforeSendResponse>
  onHeadersReceived: SubscribeAsync<OnHeadersReceivedListenerDetails, HeadersReceivedResponse>
  onBeforeRedirect: Subscribe<OnBeforeRedirectListenerDetails>
  onCompleted: Subscribe<OnCompletedListenerDetails>
  onErrorOccurred: Subscribe<OnErrorOccurredListenerDetails>
  onResponseStarted: Subscribe<OnResponseStartedListenerDetails>
  onSendHeaders: Subscribe<OnSendHeadersListenerDetails>
}
