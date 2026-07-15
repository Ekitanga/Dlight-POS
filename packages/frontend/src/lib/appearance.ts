export type AppearanceMode = 'light' | 'dark' | 'system'

export interface AppearanceSettings {
  appearance_mode?: AppearanceMode
  primary_color?: string
  accent_color?: string
  sidebar_style?: 'dark' | 'light'
  interface_density?: 'comfortable' | 'compact'
}

function hexToHsl(hex: string) {
  const value = hex.replace('#', '')
  const red = parseInt(value.slice(0, 2), 16) / 255
  const green = parseInt(value.slice(2, 4), 16) / 255
  const blue = parseInt(value.slice(4, 6), 16) / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  let hue = 0
  let saturation = 0
  const lightness = (max + min) / 2

  if (max !== min) {
    const delta = max - min
    saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
    if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0)
    if (max === green) hue = (blue - red) / delta + 2
    if (max === blue) hue = (red - green) / delta + 4
    hue /= 6
  }

  return `${Math.round(hue * 360)} ${Math.round(saturation * 100)}% ${Math.round(lightness * 100)}%`
}

export function applyAppearance(settings: AppearanceSettings) {
  const root = document.documentElement
  const mode = settings.appearance_mode || 'light'
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  root.classList.toggle('dark', dark)
  root.classList.toggle('density-compact', settings.interface_density === 'compact')
  root.dataset.sidebar = settings.sidebar_style || 'dark'
  root.style.setProperty('--primary', hexToHsl(settings.primary_color || '#B08D57'))
  root.style.setProperty('--accent', hexToHsl(settings.accent_color || '#D4AF67'))
  root.style.setProperty('--ring', hexToHsl(settings.primary_color || '#B08D57'))
}

