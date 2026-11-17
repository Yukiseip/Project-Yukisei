/**
 * Centralized Electron preload bridge accessor.
 * Returns `window.yukisei` (with fallback to legacy `window.airiMini`) or `undefined` in browser mode.
 */
export function getDesktopApi(): YukiseiApi | undefined {
  if (typeof window === 'undefined')
    return undefined
  return window.yukisei || window.airiMini
}

