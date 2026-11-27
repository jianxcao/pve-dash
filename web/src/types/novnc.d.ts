declare module '@novnc/novnc' {
  export interface RFBOptions {
    shared?: boolean
    credentials?: {
      username?: string
      password?: string
      target?: string
    }
    repeaterID?: string
    wsProtocols?: string[]
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RFBOptions)
    viewOnly: boolean
    focusOnClick: boolean
    clipViewport: boolean
    dragViewport: boolean
    scaleViewport: boolean
    resizeSession: boolean
    showDotCursor: boolean
    background: string
    qualityLevel: number
    compressionLevel: number
    disconnect(): void
    focus(): void
    blur(): void
    sendCredentials(credentials: { username?: string; password?: string; target?: string }): void
    sendKey(keysym: number, code: string | null, down?: boolean): void
    sendCtrlAltDel(): void
    clipboardPasteFrom(text: string): void
    machineShutdown(): void
    machineReboot(): void
    machineReset(): void
  }
}
