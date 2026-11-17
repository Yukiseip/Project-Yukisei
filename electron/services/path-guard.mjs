import process from 'node:process'

import { join, resolve } from 'node:path'

import { getUserSystemPaths } from './system-monitor.mjs'

/**
 * Strict Windows Path Safety Validator & Smart Alias Resolver.
 * Resolves Desktop, Downloads, Documents, Pictures, Music, Videos, and home shortcuts
 * to actual OS paths for the current user.
 * Forbids modification, deletion, or folder creation in Windows system directories,
 * Program Files, root drives, or critical OS files.
 */
export function validatePathSafety(rawPath, options = { allowDirectoryRoot: false }) {
  if (!rawPath || typeof rawPath !== 'string') {
    return { safe: false, error: 'Ruta no válida.', resolved: '' }
  }

  let target = rawPath.trim()
  const userPaths = getUserSystemPaths()
  const lowerRaw = target.toLowerCase().replace(/\\/g, '/')

  if (lowerRaw === 'escritorio' || lowerRaw === 'desktop') {
    target = userPaths.desktop
  }
  else if (lowerRaw.startsWith('escritorio/') || lowerRaw.startsWith('desktop/')) {
    target = join(userPaths.desktop, target.slice(target.indexOf('/') + 1))
  }
  else if (lowerRaw === 'descargas' || lowerRaw === 'downloads') {
    target = userPaths.downloads
  }
  else if (lowerRaw.startsWith('descargas/') || lowerRaw.startsWith('downloads/')) {
    target = join(userPaths.downloads, target.slice(target.indexOf('/') + 1))
  }
  else if (lowerRaw === 'documentos' || lowerRaw === 'documents') {
    target = userPaths.documents
  }
  else if (lowerRaw.startsWith('documentos/') || lowerRaw.startsWith('documents/')) {
    target = join(userPaths.documents, target.slice(target.indexOf('/') + 1))
  }
  else if (lowerRaw === 'imagenes' || lowerRaw === 'imágenes' || lowerRaw === 'pictures' || lowerRaw === 'fotos') {
    target = userPaths.pictures
  }
  else if (lowerRaw.startsWith('imagenes/') || lowerRaw.startsWith('imágenes/') || lowerRaw.startsWith('pictures/')) {
    target = join(userPaths.pictures, target.slice(target.indexOf('/') + 1))
  }
  else if (lowerRaw === 'musica' || lowerRaw === 'música' || lowerRaw === 'music') {
    target = userPaths.music
  }
  else if (lowerRaw === 'videos' || lowerRaw === 'vídeos') {
    target = userPaths.videos
  }
  else if (lowerRaw.startsWith('~/') || lowerRaw.startsWith('%userprofile%/')) {
    target = join(userPaths.home, target.slice(target.indexOf('/') + 1))
  }
  else if (/^[a-z]:\/users\/[^/]+\/desktop(?:\/(.*))?$/i.test(lowerRaw)) {
    const match = lowerRaw.match(/^[a-z]:\/users\/[^/]+\/desktop(?:\/(.*))?$/i)
    target = match?.[1] ? join(userPaths.desktop, match[1]) : userPaths.desktop
  }
  else if (/^[a-z]:\/users\/[^/]+\/downloads(?:\/(.*))?$/i.test(lowerRaw)) {
    const match = lowerRaw.match(/^[a-z]:\/users\/[^/]+\/downloads(?:\/(.*))?$/i)
    target = match?.[1] ? join(userPaths.downloads, match[1]) : userPaths.downloads
  }
  else if (/^[a-z]:\/users\/[^/]+\/documents(?:\/(.*))?$/i.test(lowerRaw)) {
    const match = lowerRaw.match(/^[a-z]:\/users\/[^/]+\/documents(?:\/(.*))?$/i)
    target = match?.[1] ? join(userPaths.documents, match[1]) : userPaths.documents
  }
  else if (/^[^/\\:*?"<>|]+$/.test(target)) {
    target = join(userPaths.desktop, target)
  }

  const resolved = resolve(target)
  const lower = resolved.toLowerCase().replace(/\\/g, '/')

  const winDir = (process.env.WINDIR || 'C:\\Windows').toLowerCase().replace(/\\/g, '/')
  const progFiles = (process.env.ProgramFiles || 'C:\\Program Files').toLowerCase().replace(/\\/g, '/')
  const progFilesX86 = (process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').toLowerCase().replace(/\\/g, '/')

  if (!options.allowDirectoryRoot && /^[a-z]:\/?$/i.test(lower)) {
    return {
      safe: false,
      error: `Acción bloqueada por seguridad: No se permite operar directamente sobre la raíz de la unidad (${resolved}).`,
      resolved,
    }
  }

  if (lower.startsWith(winDir) || lower.includes('/windows/') || lower.includes('/system32') || lower.includes('/syswow64')) {
    return {
      safe: false,
      error: `Acción bloqueada por seguridad: La ruta '${resolved}' es parte de Windows y está estrictamente protegida contra modificaciones.`,
      resolved,
    }
  }

  if (lower.startsWith(progFiles) || lower.startsWith(progFilesX86)) {
    return {
      safe: false,
      error: `Acción bloqueada por seguridad: '${resolved}' se encuentra en Archivos de Programa.`,
      resolved,
    }
  }

  const forbiddenSubstrings = [
    '/boot',
    '/recovery',
    '/system volume information',
    'pagefile.sys',
    'swapfile.sys',
    'hiberfil.sys',
    'ntuser.dat',
    '/appdata/local/microsoft',
  ]
  for (const forbidden of forbiddenSubstrings) {
    if (lower.includes(forbidden)) {
      return {
        safe: false,
        error: `Acción bloqueada por seguridad: '${resolved}' contiene archivos o carpetas vitales del sistema operativo.`,
        resolved,
      }
    }
  }

  return { safe: true, resolved }
}
