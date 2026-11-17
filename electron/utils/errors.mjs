/**
 * Safely extracts a human-readable message from any thrown error value.
 */
export function errorMessageFrom(err) {
  if (!err)
    return ''
  if (typeof err === 'string')
    return err
  if (err instanceof Error)
    return err.message
  return String(err)
}

/**
 * Normalizes a local HTTP service URL (protocol, trailing slashes, localhost -> 127.0.0.1).
 */
export function normalizeServiceUrl(rawUrl, defaultUrl = 'http://127.0.0.1:11434', stripApiSuffix = false) {
  let url = (rawUrl || defaultUrl).trim()
  if (!/^https?:\/\//i.test(url))
    url = `http://${url}`
  url = url.replace(/\/+$/, '')
  if (stripApiSuffix) {
    url = url.replace(/\/v1\/?$/, '').replace(/\/api\/?$/, '').replace(/\/+$/, '')
  }
  return url.replace('localhost', '127.0.0.1')
}

