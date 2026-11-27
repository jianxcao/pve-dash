export interface ParsedDisk {
  key: string
  raw: string
  volume: string
  size?: string
  isCdrom: boolean
  isCloudInit: boolean
  isPassthrough: boolean
  isSystem: boolean
  mountPoint?: string
  extras: string[]
}

export interface ParsedNic {
  key: string
  raw: string
  modelOrName: string
  mac?: string
  bridge?: string
  tag?: string
  firewall?: boolean
  ip?: string
  rate?: string
}

export interface ParsedPassthrough {
  key: string
  kind: 'pci' | 'usb' | 'lxc-dev'
  raw: string
}

export interface CloudInitValues {
  ciuser: string
  hasPassword: boolean
  sshkeys: string
  ipconfig0: string
  nameserver: string
  searchdomain: string
}

export function strVal(v: unknown): string {
  if (v === undefined || v === null) return ''
  return String(v)
}

export function parseKVList(raw: string): { first: string; kv: Record<string, string> } {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const kv: Record<string, string> = {}
  let first = ''
  parts.forEach((p, idx) => {
    const eq = p.indexOf('=')
    if (eq === -1) {
      if (idx === 0) first = p
    } else {
      const k = p.slice(0, eq).trim()
      const val = p.slice(eq + 1).trim()
      if (idx === 0 && (k === 'file' || k === 'volume')) {
        first = val
      }
      kv[k] = val
    }
  })
  return { first, kv }
}

function isIndexedKeyInRange(kl: string, prefix: string, maxIdx: number): boolean {
  if (!kl.startsWith(prefix)) return false
  const suffix = kl.slice(prefix.length)
  if (!/^\d+$/.test(suffix)) return false
  const n = Number(suffix)
  return Number.isInteger(n) && n >= 0 && n <= maxIdx
}

function isHostBindMountValue(raw: string): boolean {
  const trimmed = raw.trim()
  if (trimmed.startsWith('/')) return true
  for (const seg of trimmed.split(',')) {
    const part = seg.trim()
    if (part.toLowerCase().startsWith('volume=')) {
      const vol = part.slice('volume='.length).trim()
      if (vol.startsWith('/')) return true
    }
  }
  return false
}

/**
 * Checks whether a guest raw config key (or value) is a host-privileged parameter
 * restricted to `admin` (`args`, `hookscript`, `hostpci*`, `usb*`, `lxc.*`, `unused*`, `virtiofs*`, `dev0..dev255`, `/dev/*`, or LXC `/` host bind mounts).
 */
export function isPrivilegedGuestConfigKey(key: string, value?: unknown): boolean {
  const k = key.trim().toLowerCase()
  if (
    k === 'args' ||
    k === 'hookscript' ||
    k === 'lxc' ||
    k.startsWith('lxc.') ||
    k.startsWith('hostpci') ||
    k.startsWith('usb') ||
    k.startsWith('unused') ||
    k.startsWith('virtiofs') ||
    isIndexedKeyInRange(k, 'dev', 255)
  ) {
    return true
  }
  if (value !== undefined && value !== null) {
    const raw = String(value).trim()
    if (raw.includes('/dev/')) return true
    if ((k === 'rootfs' || isIndexedKeyInRange(k, 'mp', 255)) && isHostBindMountValue(raw)) {
      return true
    }
  }
  return false
}

export function parseGuestConfig(config: Record<string, unknown>) {
  const disks: ParsedDisk[] = []
  const nics: ParsedNic[] = []
  const passthroughs: ParsedPassthrough[] = []
  let hasCloudInitDrive = false

  const configEntries = Object.entries(config)
    .filter(([k]) => k !== 'digest')
    .sort(([a], [b]) => a.localeCompare(b))

  for (const [key, val] of configEntries) {
    if (key === 'lxc' && Array.isArray(val)) {
      for (const pair of val) {
        const line = Array.isArray(pair) ? pair.join(' = ') : strVal(pair)
        if (line.includes('/dev/')) {
          passthroughs.push({ key: 'lxc.entry', kind: 'lxc-dev', raw: line })
        }
      }
      continue
    }

    const raw = strVal(val)
    if (
      /^(scsi|virtio|sata|ide)\d+$/.test(key) ||
      key === 'rootfs' ||
      /^mp\d+$/.test(key) ||
      /^(efidisk|tpmstate)\d+$/.test(key) ||
      /^unused\d+$/.test(key)
    ) {
      const { first, kv } = parseKVList(raw)
      const volume = first || kv.volume || kv.file || raw
      const isCdrom = kv.media === 'cdrom' || raw.includes('media=cdrom')
      const isCloudInit = raw.includes('cloudinit')
      if (isCloudInit) hasCloudInitDrive = true
      const isPassthrough = volume.startsWith('/dev/')
      const isSystem =
        key.startsWith('efidisk') || key.startsWith('tpmstate') || key.startsWith('unused')
      const extras: string[] = []
      if (kv.ssd === '1') extras.push('SSD')
      if (kv.discard === 'on') extras.push('Discard')
      if (kv.iothread === '1') extras.push('IOThread')
      if (kv.backup === '0') extras.push('不备份')
      if (kv.cache) extras.push(`cache=${kv.cache}`)

      disks.push({
        key,
        raw,
        volume,
        size: kv.size,
        isCdrom,
        isCloudInit,
        isPassthrough,
        isSystem,
        mountPoint: kv.mp,
        extras,
      })
    } else if (/^net\d+$/.test(key)) {
      const { kv } = parseKVList(raw)
      let modelOrName = kv.name || ''
      let mac = kv.hwaddr || ''
      for (const m of ['virtio', 'e1000', 'vmxnet3', 'rtl8139', 'e1000e']) {
        if (kv[m]) {
          modelOrName = m.toUpperCase()
          mac = kv[m]
          break
        }
      }
      nics.push({
        key,
        raw,
        modelOrName: modelOrName || 'NIC',
        mac,
        bridge: kv.bridge,
        tag: kv.tag,
        firewall: kv.firewall === '1',
        ip: kv.ip,
        rate: kv.rate,
      })
    } else if (/^hostpci\d+$/.test(key)) {
      passthroughs.push({ key, kind: 'pci', raw })
    } else if (/^usb\d+$/.test(key)) {
      passthroughs.push({ key, kind: 'usb', raw })
    } else if (/^dev\d+$/.test(key)) {
      passthroughs.push({ key, kind: 'lxc-dev', raw })
    }
  }

  const cloudInitValues: CloudInitValues = {
    ciuser: strVal(config.ciuser),
    hasPassword: Boolean(config.cipassword),
    sshkeys: strVal(config.sshkeys),
    ipconfig0: strVal(config.ipconfig0),
    nameserver: strVal(config.nameserver),
    searchdomain: strVal(config.searchdomain),
  }

  return {
    disks,
    nics,
    passthroughs,
    hasCloudInitDrive,
    cloudInitValues,
    configEntries,
  }
}
