// Desktop MIT; OS environment and resolver are explicit platform dependencies.
export async function envForProxy(
  remoteUrl: string,
  env: Readonly<Record<string, string | undefined>>,
  resolve: (url: string) => Promise<string | undefined>
): Promise<Record<string, string | undefined> | undefined> {
  const protocolMatch = /^(https?):\/\//i.exec(remoteUrl)

  // We can only resolve and use a proxy for the protocols where cURL
  // would be involved (i.e http and https). git:// relies on ssh.
  if (protocolMatch === null) {
    return
  }

  // Note that HTTPS here doesn't mean that the proxy is HTTPS, only
  // that all requests to HTTPS protocols should be proxied. The
  // proxy protocol is defined by the url returned by `this.resolve()`
  const proto = protocolMatch[1].toLowerCase() // http or https

  // We'll play it safe and say that if the user has configured
  // the ALL_PROXY environment variable they probably know what
  // they're doing and wouldn't want us to override it with a
  // protocol-specific proxy. cURL supports both lower and upper
  // case, see:
  // https://github.com/curl/curl/blob/14916a82e/lib/url.c#L2180-L2185
  if ("ALL_PROXY" in env || "all_proxy" in env) {
    log.info(`proxy url not resolved, ALL_PROXY already set`)
    return
  }

  // Lower case environment variables due to
  // https://ec.haxx.se/usingcurl/usingcurl-proxies#http_proxy-in-lower-case-only
  const envKey = `${proto}_proxy` // http_proxy or https_proxy

  // If the user has already configured a proxy in the environment
  // for the protocol we're not gonna override it.
  if (envKey in env || (proto === "https" && "HTTPS_PROXY" in env)) {
    log.info(`proxy url not resolved, ${envKey} already set`)
    return
  }

  const proxyUrl = await resolve(remoteUrl).catch(err => {
    log.error("Failed resolving Git proxy", err)
    return undefined
  })

  return proxyUrl === undefined ? undefined : { [envKey]: proxyUrl }
}
