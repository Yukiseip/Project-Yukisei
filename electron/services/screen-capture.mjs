import { desktopCapturer, screen } from 'electron'

/**
 * Captures a JPEG screenshot (base64, without data URL prefix) of the display
 * currently under the mouse cursor. Temporarily hides `ownerWindow` opacity
 * so Yukisei does not obstruct the screenshot.
 */
export async function captureActiveDisplay(ownerWindow) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const maxWidth = 1280
  const scale = Math.min(1, maxWidth / display.size.width)
  const thumbnailSize = {
    width: Math.round(display.size.width * scale),
    height: Math.round(display.size.height * scale),
  }

  ownerWindow?.setOpacity(0)
  try {
    await new Promise(resolve => setTimeout(resolve, 150))
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
    const source = sources.find(item => item.display_id === String(display.id)) ?? sources[0]
    if (!source || source.thumbnail.isEmpty())
      throw new Error('No pude capturar la pantalla.')
    return source.thumbnail.toJPEG(80).toString('base64')
  }
  finally {
    ownerWindow?.setOpacity(1)
  }
}

