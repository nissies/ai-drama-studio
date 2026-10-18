import type { DesktopBridge } from './desktop/types'

export {}

declare global {
  interface Window {
    aiDramaDesktop?: DesktopBridge
  }
}
