import process from 'node:process'

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { createServer } from 'vite'

const root = join(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

const server = await createServer({ root })
await server.listen()

const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5180/'
const electronPath = require('electron')

// NOTICE:
// Some shells set ELECTRON_RUN_AS_NODE, which makes Electron run as plain Node.
// Root cause: the Electron binary reads this variable at start.
// Source: Electron docs, environment variables.
// Removal condition: delete if no shell sets the variable.
const env = { ...process.env, YUKISEI_DEV_URL: url, AIRI_MINI_DEV_URL: url }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electronPath, [root], { env, stdio: 'inherit' })

child.on('exit', async () => {
  await server.close()
  process.exit(0)
})
