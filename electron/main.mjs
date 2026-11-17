import process from 'node:process'

import { join } from 'node:path'

import { app, BrowserWindow, Menu, nativeImage, session, Tray } from 'electron'

import { registerIpcHandlers } from './ipc/handlers.mjs'
import { startTtsWorker, startWhisperWorker, stopAllWorkers } from './services/workers.mjs'

const devUrl = process.env.YUKISEI_DEV_URL || process.env.AIRI_MINI_DEV_URL
const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write'])

let mainWindow = null
let tray = null

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}
else {
  app.on('second-instance', () => {
    if (!mainWindow)
      return
    if (mainWindow.isMinimized())
      mainWindow.restore()
    if (!mainWindow.isVisible())
      mainWindow.show()
    mainWindow.focus()
  })
}

function setupTray(win) {
  const iconPath = join(import.meta.dirname, 'tray-icon.png')
  let icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    icon = nativeImage.createEmpty()
  }
  icon = icon.resize({ width: 18, height: 18 })
  tray = new Tray(icon)
  tray.setToolTip('Yukisei')

  const updateMenu = () => {
    const isVisible = win.isVisible()
    const contextMenu = Menu.buildFromTemplate([
      {
        label: isVisible ? 'Ocultar a Yukisei' : 'Mostrar a Yukisei',
        click: () => {
          if (win.isVisible()) {
            win.hide()
          }
          else {
            win.show()
            win.focus()
          }
        },
      },
      {
        label: 'Nueva conversación',
        click: () => {
          if (!win.isVisible())
            win.show()
          win.webContents.send('app:action', 'clear-chat')
        },
      },
      {
        label: 'Ajustes de Yukisei',
        click: () => {
          if (!win.isVisible())
            win.show()
          win.webContents.send('app:action', 'open-settings')
        },
      },
      {
        label: 'Silenciar / Activar voz',
        click: () => {
          win.webContents.send('app:action', 'toggle-sound')
        },
      },
      { type: 'separator' },
      {
        label: 'Cerrar Yukisei',
        click: () => {
          app.quit()
        },
      },
    ])
    tray.setContextMenu(contextMenu)
  }

  updateMenu()
  win.on('show', updateMenu)
  win.on('hide', updateMenu)

  tray.on('click', () => {
    if (win.isVisible()) {
      win.hide()
    }
    else {
      win.show()
      win.focus()
    }
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'Yukisei',
    width: 520,
    height: 820,
    minWidth: 340,
    minHeight: 480,
    x: 100,
    y: 100,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  setupTray(mainWindow)

  if (devUrl)
    mainWindow.loadURL(devUrl)
  else
    mainWindow.loadFile(join(import.meta.dirname, '..', 'dist', 'index.html'))

  return mainWindow
}

if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission))
    })
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
      return ALLOWED_PERMISSIONS.has(permission)
    })

    registerIpcHandlers(() => mainWindow)
    startWhisperWorker()
    startTtsWorker()
    createWindow()
  })

  app.on('before-quit', () => {
    stopAllWorkers()
  })

  app.on('window-all-closed', () => {
    stopAllWorkers()
    app.quit()
  })
}
