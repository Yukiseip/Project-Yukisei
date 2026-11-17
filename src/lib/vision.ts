import { getDesktopApi } from './desktop-bridge'

/** Default request when the user attaches a screenshot without text. */
export const defaultScreenPrompt = 'Mira mi pantalla y dime qué ves.'

/** Approximate token cost of one screenshot for the context budget. */
export const imageTokenCost = 300

const negativeGuard = /\b(?:no|nunca|jam[aá]s|tampoco|él|el|ella|ellos|ellas|alguien|nadie|quien|quién|persona)\s+(?:no\s+)?(?:mira|mire|mirá|ve|vea|observa|observe|revisa|revise|checa|chequea|analiza|analice|toma|tomar|captura|haz)\b/i
const falseCaptures = /\bcaptura\s+de\s+(?:audio|sonido|datos|red|tr[aá]fico|paquetes|pok[eé]mon|video)\b/i

const commandPatterns = [
  /\b(?:mira|mire|mirá|ve|vea|observa|observe|revisa|revise|checa|chequea|analiza|analice|f[ií]jate\s+en)\s+(?:(?:[ae]|en)\s+)?(?:(?:mi|la|el|este|esta)\s+)?(?:pantalla|monitor|escritorio)\b/i,
  /\b(?:toma|tomar|haz|hazme|sacar?)\s+(?:una\s+)?captura(?:\s+de\s+(?:pantalla|lo\s+que\s+veo|mi\s+pantalla|mi\s+monitor))?\b/i,
  /\bcaptura\s+(?:(?:mi|la)\s+)?(?:pantalla|lo\s+que\s+(?:estoy\s+viendo|veo))\b/i,
  /\b(?:mira|mire|ve|vea|observa)\s+lo\s+que\s+(?:estoy\s+viendo|veo|tengo\s+en\s+(?:(?:mi|la)\s+)?pantalla)\b/i,
  /\bqu[eé]\s+(?:ves|hay|tengo|aparece)\s+en\s+(?:(?:mi|la)\s+)?(?:pantalla|monitor)\b/i,
]

export interface ScreenCommandResult {
  matches: boolean
  isCommandOnly: boolean
  remainingPrompt: string
}

/**
 * Parses user speech or text looking for explicit screen capture commands.
 * Distinguishes standalone commands ("toma captura", "analiza mi pantalla")
 * from combined requests ("mira mi pantalla y dime qué error tiene").
 * Rejects third-person or negated phrases like "es que ella no analiza".
 */
export function parseScreenCommand(input: string): ScreenCommandResult {
  const trimmed = input.trim()
  if (!trimmed || negativeGuard.test(trimmed) || falseCaptures.test(trimmed)) {
    return { matches: false, isCommandOnly: false, remainingPrompt: trimmed }
  }

  const cleaned = trimmed
    .replace(/^(?:oye|hola)\b\s*/i, '')
    .replace(/^(?:yukisei|airi)\b\s*,?\s*/i, '')
    .replace(/^por\s+favor\b\s*,?\s*/i, '')
    .trim()

  let matchIndex = -1
  let matchLength = 0

  for (const pattern of commandPatterns) {
    const match = cleaned.match(pattern)
    if (match && match.index !== undefined) {
      matchIndex = match.index
      matchLength = match[0].length
      break
    }
  }

  if (matchIndex === -1) {
    return { matches: false, isCommandOnly: false, remainingPrompt: trimmed }
  }

  const before = cleaned.slice(0, matchIndex).trim()
  const after = cleaned.slice(matchIndex + matchLength).trim()
  let remaining = [before, after].filter(Boolean).join(' ').trim()

  if (!/[a-z0-9áéíóúüñ]/i.test(remaining)) {
    return { matches: true, isCommandOnly: true, remainingPrompt: '' }
  }

  remaining = remaining
    .replace(/^[\s,;:\-–—]+/, '')
    .replace(/^(?:[yeo]|para)\s+/i, '')
    .replace(/^[\s,;:\-–—]+/, '')
    .trim()

  return {
    matches: true,
    isCommandOnly: remaining.length === 0,
    remainingPrompt: remaining,
  }
}

/** Tells if the app can take screenshots. Only the desktop app can. */
export function canCaptureScreen(): boolean {
  return typeof getDesktopApi()?.captureScreen === 'function'
}

/** Takes one screenshot through the desktop bridge. */
export async function captureScreen(): Promise<string> {
  const api = getDesktopApi()
  if (!api?.captureScreen)
    throw new Error('La captura de pantalla solo funciona en la app de escritorio.')
  return await api.captureScreen()
}
