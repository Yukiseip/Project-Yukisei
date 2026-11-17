import { errorMessageFrom } from '../utils/errors.mjs'

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&#x27;/g, '\'')
    .replace(/&nbsp;/g, ' ')
}

function stripHtml(html) {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

/** Basic SSRF Protection: prevents searching or resolving local or private network ranges. */
export function isSafePublicUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      return false
    const host = parsed.hostname.toLowerCase()
    if (
      host === 'localhost'
      || host.endsWith('.local')
      || host.endsWith('.internal')
      || host === '127.0.0.1'
      || host === '0.0.0.0'
      || host.startsWith('10.')
      || host.startsWith('192.168.')
      || host.startsWith('169.254.')
      || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
      || host === '::1'
    ) {
      return false
    }
    return true
  }
  catch {
    return false
  }
}

export async function searchWebDuckDuckGo(rawQuery, maxResults = 4) {
  const query = (rawQuery || '').trim().slice(0, 150)
  if (!query)
    return []

  try {
    const endpoint = 'https://html.duckduckgo.com/html/'
    const body = new URLSearchParams({ q: query, kl: 'es-es' })
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(7000),
    })

    if (!res.ok)
      throw new Error(`DuckDuckGo returned ${res.status}`)

    const html = await res.text()
    const results = []
    const resultBlocks = html.split(/class=["']result results_links/i).slice(1)

    for (const block of resultBlocks) {
      if (results.length >= maxResults)
        break

      const titleMatch = block.match(/<a[^>]+class=["']result__a["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
      if (!titleMatch)
        continue

      let rawUrl = titleMatch[1]
      if (rawUrl.includes('uddg=')) {
        try {
          rawUrl = decodeURIComponent(rawUrl.split('uddg=')[1].split('&')[0])
        }
        catch {}
      }

      if (!isSafePublicUrl(rawUrl))
        continue

      const title = stripHtml(titleMatch[2])
      if (!title)
        continue

      const snippetMatch = block.match(/<a[^>]+class=["']result__snippet["'][^>]*>([\s\S]*?)<\/a>/i)
        || block.match(/<td[^>]+class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/i)
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : ''

      results.push({
        title,
        snippet: snippet.slice(0, 300),
        url: rawUrl,
      })
    }

    if (results.length > 0)
      return results
  }
  catch (err) {
    console.warn('[web:search] DuckDuckGo failed, trying fallback:', errorMessageFrom(err))
  }

  try {
    const wikiUrl = `https://es.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1&srlimit=${maxResults}`
    const res = await fetch(wikiUrl, {
      headers: { 'User-Agent': 'ProyectoYukisei/1.0 (Desktop companion assistant)' },
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const data = await res.json()
      const searchItems = data?.query?.search || []
      return searchItems.map(item => ({
        title: stripHtml(item.title || ''),
        snippet: stripHtml(item.snippet || '').slice(0, 300),
        url: `https://es.wikipedia.org/wiki/${encodeURIComponent(item.title || '').replace(/%20/g, '_')}`,
      }))
    }
  }
  catch (err) {
    console.warn('[web:search] Fallback failed:', errorMessageFrom(err))
  }

  return []
}
