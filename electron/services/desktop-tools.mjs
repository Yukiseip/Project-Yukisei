import fs from 'node:fs'

import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { app, clipboard, shell } from 'electron'

import { validatePathSafety } from './path-guard.mjs'
import { getFullSystemStats } from './system-monitor.mjs'
import { searchWebDuckDuckGo } from './web-search.mjs'

const run = promisify(execFile)

export async function handleOpenApp(rawTarget) {
  const target = (rawTarget || '').trim()
  if (!target)
    throw new Error('Debes indicar qué aplicación o carpeta abrir.')

  const lower = target.toLowerCase()
  if (lower === 'descargas' || lower === 'downloads') {
    await shell.openPath(app.getPath('downloads'))
    return { success: true, message: 'Carpeta Descargas abierta' }
  }
  if (lower === 'documentos' || lower === 'documents') {
    await shell.openPath(app.getPath('documents'))
    return { success: true, message: 'Carpeta Documentos abierta' }
  }
  if (lower === 'escritorio' || lower === 'desktop') {
    await shell.openPath(app.getPath('desktop'))
    return { success: true, message: 'Escritorio abierto' }
  }
  if (lower === 'imagenes' || lower === 'imágenes' || lower === 'fotos' || lower === 'pictures') {
    await shell.openPath(app.getPath('pictures'))
    return { success: true, message: 'Carpeta Imágenes abierta' }
  }
  if (lower === 'musica' || lower === 'música' || lower === 'music') {
    await shell.openPath(app.getPath('music'))
    return { success: true, message: 'Carpeta Música abierta' }
  }
  if (lower === 'videos' || lower === 'vídeos') {
    await shell.openPath(app.getPath('videos'))
    return { success: true, message: 'Carpeta Vídeos abierta' }
  }

  if (lower.includes('notepad') || lower.includes('bloc de notas')) {
    spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref()
    return { success: true, message: 'Bloc de notas abierto' }
  }
  if (lower.includes('calc') || lower.includes('calculadora')) {
    spawn('calc.exe', [], { detached: true, stdio: 'ignore' }).unref()
    return { success: true, message: 'Calculadora abierta' }
  }
  if (lower.includes('vscode') || lower === 'code') {
    spawn('cmd.exe', ['/c', 'code'], { detached: true, stdio: 'ignore' }).unref()
    return { success: true, message: 'Visual Studio Code abierto' }
  }
  if (lower.includes('spotify')) {
    await shell.openExternal('spotify:')
    return { success: true, message: 'Spotify abierto' }
  }
  if (lower.includes('steam')) {
    await shell.openExternal('steam://open/main')
    return { success: true, message: 'Steam abierto' }
  }

  const webShortcuts = {
    youtube: { url: 'https://www.youtube.com', name: 'YouTube' },
    facebook: { url: 'https://www.facebook.com', name: 'Facebook' },
    twitter: { url: 'https://x.com', name: 'X / Twitter' },
    x: { url: 'https://x.com', name: 'X (Twitter)' },
    google: { url: 'https://www.google.com', name: 'Google' },
    reddit: { url: 'https://www.reddit.com', name: 'Reddit' },
    twitch: { url: 'https://www.twitch.tv', name: 'Twitch' },
    chatgpt: { url: 'https://chatgpt.com', name: 'ChatGPT' },
    github: { url: 'https://github.com', name: 'GitHub' },
    instagram: { url: 'https://www.instagram.com', name: 'Instagram' },
    tiktok: { url: 'https://www.tiktok.com', name: 'TikTok' },
    whatsapp: { url: 'https://web.whatsapp.com', name: 'WhatsApp Web' },
    netflix: { url: 'https://www.netflix.com', name: 'Netflix' },
    gmail: { url: 'https://mail.google.com', name: 'Gmail' },
  }
  for (const [key, info] of Object.entries(webShortcuts)) {
    if (lower === key || lower.startsWith(`${key}.`) || lower.includes(`${key}.com`)) {
      await shell.openExternal(info.url)
      return { success: true, message: `${info.name} abierto en navegador` }
    }
  }

  if (lower.includes('chrome')) {
    spawn('cmd.exe', ['/c', 'start', 'chrome'], { detached: true, stdio: 'ignore' }).unref()
    return { success: true, message: 'Google Chrome abierto' }
  }
  if (lower.includes('edge')) {
    spawn('cmd.exe', ['/c', 'start', 'msedge'], { detached: true, stdio: 'ignore' }).unref()
    return { success: true, message: 'Microsoft Edge abierto' }
  }
  if (lower.includes('firefox')) {
    spawn('cmd.exe', ['/c', 'start', 'firefox'], { detached: true, stdio: 'ignore' }).unref()
    return { success: true, message: 'Firefox abierto' }
  }
  if (lower.includes('brave')) {
    spawn('cmd.exe', ['/c', 'start', 'brave'], { detached: true, stdio: 'ignore' }).unref()
    return { success: true, message: 'Brave abierto' }
  }

  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    await shell.openExternal(target)
    return { success: true, message: `Enlace ${target} abierto en navegador` }
  }
  if (lower.startsWith('www.') || /\.(?:com|net|org|es|io|tv|ai|app|dev|me)(?:\/|$)/i.test(lower)) {
    const fullUrl = `https://${target.replace(/^https?:\/\//i, '')}`
    await shell.openExternal(fullUrl)
    return { success: true, message: `Sitio web ${fullUrl} abierto en navegador` }
  }

  const safety = validatePathSafety(target, { allowDirectoryRoot: true })
  if (safety.safe && fs.existsSync(safety.resolved)) {
    await shell.openPath(safety.resolved)
    return { success: true, message: `Ruta ${safety.resolved} abierta` }
  }

  throw new Error(`No reconozco la aplicación o ruta: ${target}`)
}

export async function handleListDirectory(rawPath) {
  const target = (rawPath || 'escritorio').trim()
  const safety = validatePathSafety(target, { allowDirectoryRoot: true })
  if (!safety.safe) {
    throw new Error(safety.error)
  }
  if (!fs.existsSync(safety.resolved)) {
    throw new Error(`La carpeta no existe: ${safety.resolved}`)
  }

  const stat = await fs.promises.stat(safety.resolved)
  if (!stat.isDirectory()) {
    throw new Error(`La ruta no es una carpeta: ${safety.resolved}`)
  }

  const entries = await fs.promises.readdir(safety.resolved, { withFileTypes: true })
  const items = []
  for (const entry of entries.slice(0, 40)) {
    if (entry.name.startsWith('.') || entry.name.toLowerCase() === 'desktop.ini')
      continue
    let sizeKb = 0
    if (entry.isFile()) {
      try {
        const s = await fs.promises.stat(join(safety.resolved, entry.name))
        sizeKb = Math.round(s.size / 1024)
      }
      catch {}
    }
    items.push({
      name: entry.name,
      type: entry.isDirectory() ? 'folder' : 'file',
      sizeKb,
    })
  }

  const folderCount = items.filter(i => i.type === 'folder').length
  const fileCount = items.filter(i => i.type === 'file').length
  return {
    success: true,
    message: `${safety.resolved}: ${folderCount} carpetas, ${fileCount} archivos`,
    data: {
      path: safety.resolved,
      items,
    },
  }
}

export async function executeSafeTool(toolName, rawArgs) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
  const audioScript = join(import.meta.dirname, '..', '..', 'scripts', 'windows-audio.ps1')

  switch (toolName) {
    case 'media_volume': {
      const action = String(args?.action || 'set').toLowerCase()
      const level = Number(args?.level ?? 50)
      if (action === 'get') {
        const { stdout } = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', audioScript, '-Action', 'get'], { windowsHide: true })
        return { success: true, message: `Volumen actual: ${stdout.trim()}%`, data: { level: Number(stdout.trim()) } }
      }
      if (action === 'mute') {
        await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', audioScript, '-Action', 'mute'], { windowsHide: true })
        return { success: true, message: 'Audio silenciado' }
      }
      if (action === 'unmute') {
        await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', audioScript, '-Action', 'unmute'], { windowsHide: true })
        return { success: true, message: 'Audio reactivado' }
      }
      const { stdout } = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', audioScript, '-Action', 'set', '-Value', String(level)], { windowsHide: true })
      return { success: true, message: `Volumen ajustado al ${stdout.trim()}%`, data: { level: Number(stdout.trim()) } }
    }
    case 'media_playback': {
      const action = String(args?.action || 'playpause').toLowerCase()
      await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', audioScript, '-Action', action], { windowsHide: true })
      return { success: true, message: `Control de reproducción ejecutado: ${action}` }
    }
    case 'open_app': {
      return await handleOpenApp(args?.target)
    }
    case 'window_minimize_all': {
      await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', audioScript, '-Action', 'minimize_all'], { windowsHide: true })
      return { success: true, message: 'Mostrando escritorio (ventanas minimizadas)' }
    }
    case 'get_system_stats': {
      const stats = await getFullSystemStats()
      return {
        success: true,
        message: `CPU ${stats.cpu.loadPercent}% | RAM ${stats.ram.usedGb}/${stats.ram.totalGb} GB | GPU ${stats.gpu.tempC}°C`,
        data: stats,
      }
    }
    case 'clipboard_read': {
      const text = clipboard.readText()
      return {
        success: true,
        message: text ? `Texto en portapapeles (${text.length} caracteres)` : 'El portapapeles está vacío',
        data: { text: text || '(Portapapeles vacío)' },
      }
    }
    case 'clipboard_write': {
      const text = String(args?.text || '')
      clipboard.writeText(text)
      return { success: true, message: 'Texto copiado al portapapeles' }
    }
    case 'list_directory': {
      return await handleListDirectory(args?.path)
    }
    case 'web_search': {
      const query = String(args?.query || '').trim()
      const results = await searchWebDuckDuckGo(query, 4)
      return {
        success: true,
        message: results.length > 0 ? `Búsqueda completada (${results.length} fuentes)` : `Sin resultados para "${query}"`,
        data: { query, results },
      }
    }
    default:
      throw new Error(`Herramienta segura no reconocida: ${toolName}`)
  }
}

export async function executeSensitiveTool(toolName, rawArgs) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
  switch (toolName) {
    case 'create_folder': {
      const safety = validatePathSafety(args?.path)
      if (!safety.safe)
        throw new Error(safety.error)
      await fs.promises.mkdir(safety.resolved, { recursive: true })
      return { success: true, message: `Carpeta creada: ${safety.resolved}` }
    }
    case 'create_file': {
      const safety = validatePathSafety(args?.path)
      if (!safety.safe)
        throw new Error(safety.error)
      const content = typeof args?.content === 'string' ? args.content : ''
      await fs.promises.writeFile(safety.resolved, content, 'utf8')
      return { success: true, message: `Archivo creado: ${safety.resolved}` }
    }
    case 'move_path': {
      const srcSafety = validatePathSafety(args?.source)
      if (!srcSafety.safe)
        throw new Error(srcSafety.error)
      const dstSafety = validatePathSafety(args?.destination)
      if (!dstSafety.safe)
        throw new Error(dstSafety.error)
      if (!fs.existsSync(srcSafety.resolved))
        throw new Error(`El archivo de origen no existe: ${srcSafety.resolved}`)
      await fs.promises.rename(srcSafety.resolved, dstSafety.resolved)
      return { success: true, message: `Elemento movido a: ${dstSafety.resolved}` }
    }
    case 'trash_path': {
      const safety = validatePathSafety(args?.path)
      if (!safety.safe)
        throw new Error(safety.error)
      if (!fs.existsSync(safety.resolved))
        throw new Error(`El archivo o carpeta no existe: ${safety.resolved}`)
      await shell.trashItem(safety.resolved)
      return { success: true, message: `Elemento enviado a la Papelera de reciclaje: ${safety.resolved}` }
    }
    default:
      throw new Error(`Herramienta sensible no reconocida: ${toolName}`)
  }
}
