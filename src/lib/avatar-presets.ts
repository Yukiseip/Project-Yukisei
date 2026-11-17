export interface AvatarPresetFraming {
  scale: number
  offsetX: number
  offsetY: number
}

export interface AvatarPreset {
  id: string
  name: string
  subtitle: string
  badge: string
  path: string
  description: string
  initialFraming?: AvatarPresetFraming
}

export const avatarPresets: AvatarPreset[] = [
  {
    id: 'default-hiyori',
    name: 'Hiyori Oficial',
    subtitle: 'Por defecto · Live2D Sample',
    badge: '✨ Oficial',
    path: '',
    description: 'Modelo oficial de Yukisei con expresiones completas, seguimiento de vista y gesticulaciones suaves.',
    initialFraming: { scale: 0.90, offsetX: 0, offsetY: -12 },
  },
  {
    id: 'hibiki',
    name: 'Hibiki',
    subtitle: 'Live2D Cubism Official',
    badge: '🎵 Oficial',
    path: './avatars/hibiki.zip',
    description: 'Modelo de Hibiki con animaciones de habla reactivas a la IA, respiración en espera y sincronización labial silenciosa.',
    initialFraming: { scale: 0.82, offsetX: 0, offsetY: -14 },
  },
  {
    id: 'haru',
    name: 'Haru',
    subtitle: 'Live2D Cubism Official',
    badge: '🌸 Oficial',
    path: './avatars/haru.zip',
    description: 'Modelo oficial de Live2D con expresiones dinámicas, gesticulación suave y standby silencioso.',
    initialFraming: { scale: 0.82, offsetX: 0, offsetY: -14 },
  },
  {
    id: 'epsilon',
    name: 'Epsilon',
    subtitle: 'Live2D Cubism Pro',
    badge: '⚡ Oficial',
    path: './avatars/epsilon.zip',
    description: 'Modelo oficial de Live2D Cubism Pro con estética estilizada, expresiones y física avanzada.',
    initialFraming: { scale: 0.80, offsetX: 0, offsetY: -14 },
  },
  {
    id: 'kaguya',
    name: 'Kaguya Hime',
    subtitle: '八千代辉夜姬 · 雪熊企划',
    badge: '🌙 Elegante',
    path: './avatars/kaguya.zip',
    description: 'Diseño tradicional estilizado con kimono detallado y accesorios decorativos.',
    initialFraming: { scale: 0.65, offsetX: 0, offsetY: -18 },
  },
  {
    id: 'jian',
    name: 'Jian (简)',
    subtitle: 'Avatar Anime 2D',
    badge: '🗡️ Minimalista',
    path: './avatars/jian.zip',
    description: 'Modelo liviano y optimizado con renderizado rápido.',
    initialFraming: { scale: 0.78, offsetX: 0, offsetY: -15 },
  },
]
