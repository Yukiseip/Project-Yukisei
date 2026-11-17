export interface ToolCallItem {
  id: string
  name: string
  args: Record<string, unknown>
  isSensitive: boolean
  status: 'pending' | 'executing' | 'completed' | 'rejected' | 'error'
  result?: unknown
  error?: string
}

export interface SystemStats {
  cpu: { name?: string, cores?: number, loadPercent: number, tempC?: number | null }
  ram: { totalGb: number, usedGb: number, freeGb: number, percentUsed: number }
  gpu: { name: string, totalMb: number, freeMb: number, tempC: number }
  disks: Array<{ name: string, totalGb: number, freeGb: number }>
}

/** Tells if a tool requires explicit user permission via an interactive chat card */
export function isToolSensitive(name: string): boolean {
  return ['create_folder', 'create_file', 'move_path', 'trash_path'].includes(name)
}

/** Tells if a tool returns factual data that the LLM needs to read in a ReAct follow-up turn */
export function isQueryTool(name: string): boolean {
  return ['get_system_stats', 'clipboard_read', 'list_directory', 'web_search'].includes(name)
}

/** Human-readable title and icon for tools */
export function getToolDisplayInfo(name: string, args: Record<string, unknown>): { title: string, icon: string, description: string } {
  switch (name) {
    case 'media_volume': {
      const act = String(args.action || 'set')
      if (act === 'mute')
        return { title: 'Silenciar volumen', icon: 'i-carbon-volume-mute', description: 'Silenciar el audio de Windows' }
      if (act === 'unmute')
        return { title: 'Activar volumen', icon: 'i-carbon-volume-up', description: 'Reactivar el audio de Windows' }
      if (act === 'get')
        return { title: 'Consultar volumen', icon: 'i-carbon-volume-down', description: 'Consultar nivel de audio' }
      return { title: `Volumen al ${Number(args.level ?? 50)}%`, icon: 'i-carbon-volume-up', description: `Ajustar volumen a ${Number(args.level ?? 50)}%` }
    }
    case 'media_playback': {
      const act = String(args.action || 'playpause')
      if (act === 'next')
        return { title: 'Siguiente canción', icon: 'i-carbon-next-filled', description: 'Pasar a la siguiente pista' }
      if (act === 'prev')
        return { title: 'Canción anterior', icon: 'i-carbon-previous-filled', description: 'Volver a la pista anterior' }
      return { title: 'Pausar / Reproducir', icon: 'i-carbon-play-pause', description: 'Alternar reproducción de medios' }
    }
    case 'open_app':
      return { title: `Abrir: ${String(args.target || 'aplicación')}`, icon: 'i-carbon-launch', description: `Abrir ${String(args.target || '')}` }
    case 'window_minimize_all':
      return { title: 'Mostrar escritorio', icon: 'i-carbon-minimize', description: 'Minimizar todas las ventanas' }
    case 'get_system_stats':
      return { title: 'Estado del sistema', icon: 'i-carbon-meter', description: 'Consultando CPU, RAM, GPU y discos' }
    case 'clipboard_read':
      return { title: 'Leer portapapeles', icon: 'i-carbon-copy', description: 'Consultar texto copiado en Windows' }
    case 'clipboard_write':
      return { title: 'Copiar al portapapeles', icon: 'i-carbon-paste', description: `Copiar texto: "${String(args.text || '').slice(0, 30)}..."` }
    case 'list_directory':
      return { title: `Explorar carpeta: ${String(args.path || 'escritorio')}`, icon: 'i-carbon-folder', description: `Listar contenido de ${String(args.path || 'escritorio')}` }
    case 'web_search':
      return { title: `Buscar en web: ${String(args.query || '')}`, icon: 'i-carbon-earth-filled', description: `Consultando internet sobre "${String(args.query || '')}"` }
    case 'create_folder':
      return { title: 'Crear carpeta', icon: 'i-carbon-folder-add', description: `Ruta: ${String(args.path || '')}` }
    case 'create_file':
      return { title: 'Crear archivo', icon: 'i-carbon-document-add', description: `Archivo: ${String(args.path || '')}` }
    case 'move_path':
      return { title: 'Mover / Renombrar', icon: 'i-carbon-move', description: `De: ${String(args.source || '')} ➔ A: ${String(args.destination || '')}` }
    case 'trash_path':
      return { title: 'Enviar a Papelera de reciclaje', icon: 'i-carbon-trash-can', description: `Objetivo: ${String(args.path || '')}` }
    default:
      return { title: name, icon: 'i-carbon-tools', description: JSON.stringify(args) }
  }
}

/**
 * Strips completed AND in-progress `<tool_call>`, `<|ACT ...|>`, and `<|MEMORY ...|>` tags
 * so raw protocol JSON never flashes inside the user's chat bubble while streaming.
 */
export function sanitizeDisplayContent(text: string): string {
  if (!text)
    return ''
  return text
    // Completed protocol blocks
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<\|ACT\s*\{[\s\S]*?\}\s*\|>/gi, '')
    .replace(/<\|MEMORY\s*\{[\s\S]*?\}\s*\|>/gi, '')
    // In-progress trailing protocol blocks during live token streaming
    .replace(/<tool_call>[\s\S]*$/i, '')
    .replace(/<\|ACT[\s\S]*$/i, '')
    .replace(/<\|MEMORY[\s\S]*$/i, '')
    .replace(/<\|[A-Z_]*$/i, '')
    .replace(/<tool_[a-z_]*$/i, '')
    .trim()
}

/** Parses <tool_call>...</tool_call> tags from assistant stream or text */
export function parseToolCalls(text: string): { cleanText: string, toolCalls: ToolCallItem[] } {
  const toolCalls: ToolCallItem[] = []
  if (!text)
    return { cleanText: '', toolCalls }

  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi
  let match: RegExpExecArray | null
  const matches: Array<{ full: string, inner: string }> = []

  while (true) {
    match = toolCallRegex.exec(text)
    if (!match)
      break
    matches.push({ full: match[0], inner: match[1] })
  }

  for (const m of matches) {
    try {
      const parsed = JSON.parse(m.inner.trim())
      const name = parsed.name || parsed.tool
      const args = parsed.args || parsed.arguments || {}
      if (name && typeof name === 'string') {
        toolCalls.push({
          id: Math.random().toString(36).slice(2, 9),
          name,
          args,
          isSensitive: isToolSensitive(name),
          status: isToolSensitive(name) ? 'pending' : 'executing',
        })
      }
    }
    catch (e) {
      console.warn('[desktop-tools] Could not parse tool_call JSON:', m.inner, e)
    }
  }

  const cleanText = sanitizeDisplayContent(text)
  return { cleanText, toolCalls }
}

/** Tells if the user's message is asking about PC performance or system health */
export function shouldFetchSystemStats(text: string): boolean {
  if (!text)
    return false
  const lower = text.toLowerCase()
  const patterns = [
    /temperatura.*(?:gpu|grafica|tarjeta|pc|cpu|procesador)/,
    /(?:uso|consumo|estado).*(?:gpu|vram|ram|cpu|memoria|disco|procesador|pc|computadora|grafica)/,
    /(?:cuanta|cuanto).*(?:ram|vram|memoria|espacio|disco).*queda/,
    /(?:como va|que tal va|revisa).*(?:mi pc|mi compu|el equipo|el rendimiento)/,
    /por que va lenta.*pc/,
    /rendimiento.*(?:pc|computadora|equipo)/,
  ]
  return patterns.some(pattern => pattern.test(lower))
}

/** Tells if the user is asking to read or inspect Windows clipboard */
export function shouldFetchClipboard(text: string): boolean {
  if (!text)
    return false
  const lower = text.toLowerCase()
  const patterns = [
    /(?:que|qué).*(?:tengo|hay).*(?:copiado|portapapeles|clipboard)/,
    /(?:lee|leer|muestra|revisa|dime|ver).*(?:portapapeles|clipboard|lo que copie|lo que copié)/,
    /pega.*(?:portapapeles|clipboard)/,
  ]
  return patterns.some(pattern => pattern.test(lower))
}

/** Formats clipboard text into background factual context */
export function formatClipboardContext(clipboardText: string): string {
  return `<contexto_portapapeles>
[Texto copiado en el portapapeles de Windows de tu usuario]:
"${clipboardText || '(El portapapeles está actualmente vacío)'}"
Instrucción: Utiliza este texto para responder al usuario qué tiene copiado en su portapapeles.
</contexto_portapapeles>`
}

/** Formats system stats into factual background prompt context */
export function formatSystemStatsContext(stats: SystemStats): string {
  const diskSummary = stats.disks
    .map(d => `${d.name} (${d.freeGb} GB libres de ${d.totalGb} GB)`)
    .join(', ')

  return `<contexto_sistema_pc>
[Datos fácticos en tiempo real de la PC de tu usuario]
- CPU: ${stats.cpu.name || 'Procesador'} (${stats.cpu.cores || 8} núcleos) | Carga actual en tiempo real: ${stats.cpu.loadPercent}%
- GPU: ${stats.gpu.name} | Temperatura: ${stats.gpu.tempC}°C (sensor oficial NVIDIA) | VRAM Libre: ${(stats.gpu.freeMb / 1024).toFixed(1)} GB de ${(stats.gpu.totalMb / 1024).toFixed(1)} GB
- Memoria RAM: ${stats.ram.usedGb.toFixed(1)} GB usados de ${stats.ram.totalGb.toFixed(1)} GB (${stats.ram.percentUsed}% en uso, ${stats.ram.freeGb.toFixed(1)} GB libres)
- Discos de almacenamiento: ${diskSummary}
[Nota técnica de temperatura]:
Windows no expone directamente la temperatura de los núcleos de la CPU a programas de usuario sin drivers de nivel kernel (como HWMonitor), por lo que la temperatura medida con certeza es la de la tarjeta gráfica (GPU). Si el usuario pregunta por la temperatura de la CPU, indícale la temperatura de su GPU y aclárale que la CPU se mide con su porcentaje de carga real.
</contexto_sistema_pc>`
}

export interface UserPathsInfo {
  desktop?: string
  documents?: string
  downloads?: string
  home?: string
  username?: string
  drives?: string[]
}

/** Builds instructions injected into persona when desktop tools are enabled */
export function buildDesktopToolsPrompt(userPaths?: UserPathsInfo): string {
  const pathsSection = userPaths?.desktop
    ? `
RUTAS REALES DEL SISTEMA DE TU USUARIO (Windows):
- Usuario: ${userPaths.username || 'usuario'}
- Escritorio: ${userPaths.desktop}
- Descargas: ${userPaths.downloads || 'Descargas'}
- Documentos: ${userPaths.documents || 'Documentos'}
- Discos disponibles: ${(userPaths.drives || ['C:\\']).join(', ')}

REGLAS PARA RUTAS:
Cuando el usuario te pida crear, consultar o borrar cosas en su escritorio, descargas o documentos, puedes usar rutas relativas como 'escritorio/nombre' o simplemente el nombre (ejemplo: 'prueba' o 'ideas.txt'), o la ruta real exacta de arriba. NO inventes nombres de usuarios falsos.`
    : ''

  return `
[HERRAMIENTAS DE ESCRITORIO DE WINDOWS (Desktop Tools)]
Tienes acceso a herramientas de escritorio en Windows para ayudar a tu usuario.
Cuando el usuario te pida realizar una acción, consultar su computadora o explorar archivos, emite un bloque con este formato exacto:
<tool_call>
{"name": "nombre_herramienta", "args": { ... }}
</tool_call>
${pathsSection}
Herramientas disponibles:
- media_volume(action: "get" | "set" | "mute" | "unmute", level?: number): Ajusta (0 a 100) o consulta el volumen de Windows.
- media_playback(action: "playpause" | "next" | "prev" | "stop"): Controla la música o videos (Spotify, YouTube, etc.).
- open_app(target: string): Abre carpetas ('escritorio', 'descargas', 'documentos', 'imagenes'), aplicaciones ('notepad', 'calc', 'vscode', 'steam', 'spotify') o sitios web ('youtube', 'facebook', 'google', 'reddit', 'twitch', 'x', o cualquier URL).
- window_minimize_all(): Minimiza las ventanas para mostrar el escritorio (Win+D).
- get_system_stats(): Consulta en vivo uso de CPU, RAM, temperatura y VRAM de GPU, y espacio en discos.
- clipboard_read(): Lee el texto actualmente copiado en el portapapeles de Windows.
- clipboard_write(text: string): Copia un texto al portapapeles.
- list_directory(path: string): Lista las carpetas y archivos dentro de una ruta (ejemplo: "escritorio", "descargas", "documentos").
- web_search(query: string): Busca información actualizada en internet sobre un tema específico.
- create_folder(path: string): Crea una carpeta (requiere permiso interactivo del usuario).
- create_file(path: string, content: string): Crea un archivo (requiere permiso interactivo del usuario).
- move_path(source: string, destination: string): Mueve o renombra un archivo o carpeta (requiere permiso interactivo del usuario).
- trash_path(path: string): Envía un archivo o carpeta a la Papelera de reciclaje de Windows (requiere permiso interactivo del usuario).

REGLAS DE SEGURIDAD ESTRICTAS:
1. Jamás intentes tocar archivos de C:\\Windows, System32 o Archivos de Programa. El sistema las bloqueará de inmediato.
2. Para crear, mover o enviar a la papelera, explica brevemente qué harás. La aplicación mostrará una tarjeta para que el usuario confirme antes de que se ejecute.
3. Si usas una herramienta de consulta (get_system_stats, clipboard_read, list_directory, web_search), el sistema ejecutará la herramienta y te entregará los datos reales para que respondas con exactitud.`
}
