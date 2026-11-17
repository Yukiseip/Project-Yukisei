import { sanitizeDisplayContent } from './desktop-tools'

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const MAX_MARKDOWN_CACHE = 120
const markdownCache = new Map<string, string>()

/**
 * Lightweight, XSS-safe Markdown renderer for chat bubbles.
 * Strips `<tool_call>`, `<|ACT|>`, and `<|MEMORY|>` tags in real time, escapes HTML,
 * and formats fenced code blocks, inline code, bold, italic, lists, and clickable URLs.
 */
export function renderMarkdown(rawText: string): string {
  if (!rawText)
    return ''
  const cached = markdownCache.get(rawText)
  if (cached !== undefined)
    return cached

  const cleaned = sanitizeDisplayContent(rawText)
  if (!cleaned)
    return ''

  const codeBlocks: string[] = []
  let text = cleaned.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_, lang: string, code: string) => {
    const idx = codeBlocks.length
    const safeLang = escapeHtml((lang || 'code').trim())
    const safeCode = escapeHtml(code.replace(/\n$/, ''))
    codeBlocks.push(
      `<div class="md-code-block"><div class="md-code-header"><span>${safeLang}</span></div><pre><code>${safeCode}</code></pre></div>`,
    )
    return `\u0000CODEBLOCK_${idx}\u0000`
  })

  text = escapeHtml(text)

  // Inline code
  text = text.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>')

  // Bold & Italic
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?:;)]|$)/g, '$1<em>$2</em>')

  // Markdown links [title](https://...)
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi,
    '<a href="$2" class="md-link" data-external-url="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  )

  // Process lines for headings & bullet lists
  const lines = text.split('\n')
  const out: string[] = []
  let inList = false

  for (const line of lines) {
    const trimmed = line.trim()
    const bulletMatch = trimmed.match(/^(?:[-•]|\d+\.)\s+(.*)$/)
    if (bulletMatch) {
      if (!inList) {
        out.push('<ul class="md-list">')
        inList = true
      }
      out.push(`<li>${bulletMatch[1]}</li>`)
      continue
    }

    if (inList) {
      out.push('</ul>')
      inList = false
    }

    if (trimmed.startsWith('### ')) {
      out.push(`<div class="md-h3">${trimmed.slice(4)}</div>`)
    }
    else if (trimmed.startsWith('## ')) {
      out.push(`<div class="md-h2">${trimmed.slice(3)}</div>`)
    }
    else if (trimmed === '') {
      out.push('<div class="md-spacer"></div>')
    }
    else {
      out.push(`<p class="md-p">${line}</p>`)
    }
  }

  if (inList) {
    out.push('</ul>')
  }

  let html = out.join('')
  html = html.replace(/\0CODEBLOCK_(\d+)\0/g, (_, idxStr: string) => {
    return codeBlocks[Number(idxStr)] || ''
  })

  if (markdownCache.size >= MAX_MARKDOWN_CACHE) {
    const oldestKey = markdownCache.keys().next().value
    if (oldestKey !== undefined)
      markdownCache.delete(oldestKey)
  }
  markdownCache.set(rawText, html)

  return html
}
