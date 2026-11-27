export function formatBytes(bytes: number | undefined | null, decimals = 1): string {
  if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return '0 B'
  const k = 1024
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1)
  const val = bytes / Math.pow(k, i)
  return `${val.toFixed(i === 0 ? 0 : decimals)} ${units[i]}`
}

export function formatBytesRate(bytesPerSec: number | undefined | null): string {
  if (!bytesPerSec || bytesPerSec <= 0 || !Number.isFinite(bytesPerSec)) return '0 B/s'
  return `${formatBytes(bytesPerSec, 1)}/s`
}

export function formatPercent(ratio: number | undefined | null, decimals = 1): string {
  if (ratio === undefined || ratio === null || !Number.isFinite(ratio)) return '0.0%'
  return `${(ratio * 100).toFixed(decimals)}%`
}

export function formatUptime(seconds: number | undefined | null): string {
  if (!seconds || seconds <= 0) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${Math.floor(seconds % 60)}s`
  return `${Math.floor(seconds)}s`
}

export function formatTimestamp(unixSec: number | undefined | null): string {
  if (!unixSec) return '—'
  const d = new Date(unixSec * 1000)
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

export function formatDateTime(unixSec: number | undefined | null): string {
  if (!unixSec) return '—'
  const d = new Date(unixSec * 1000)
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function formatISOTime(iso: string | undefined | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

export function formatClockTime(iso: string | undefined | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

const TASK_TYPE_LABELS: Record<string, string> = {
  qmstart: '启动 VM',
  qmstop: '强制停止 VM',
  qmshutdown: '关闭 VM',
  qmreboot: '重启 VM',
  qmreset: '复位 VM',
  qmsuspend: '暂停 VM',
  qmresume: '恢复 VM',
  qmcreate: '创建 VM',
  qmdestroy: '销毁 VM',
  qmclone: '克隆 VM',
  qmmigrate: '迁移 VM',
  qmsnapshot: '创建 VM 快照',
  qmrollback: '回滚 VM 快照',
  qmdelsnapshot: '删除 VM 快照',
  vzstart: '启动容器',
  vzstop: '强制停止容器',
  vzshutdown: '关闭容器',
  vzreboot: '重启容器',
  vzsuspend: '暂停容器',
  vzresume: '恢复容器',
  vzcreate: '创建容器',
  vzdestroy: '销毁容器',
  vzclone: '克隆容器',
  vzmigrate: '迁移容器',
  vzsnapshot: '创建容器快照',
  vzrollback: '回滚容器快照',
  vzdelsnapshot: '删除容器快照',
  vzdump: '备份任务',
  vncproxy: 'VNC 控制台',
  vncshell: '节点 VNC',
  termproxy: '终端会话',
  aptupdate: '刷新 APT 源',
  download: '镜像下载',
  imgcopy: '磁盘复制',
  srvreload: '重载服务',
  acmenewcert: '申请 ACME 证书',
  acmerenew: '续签 ACME 证书',
}

export function formatTaskType(type: string): string {
  return TASK_TYPE_LABELS[type] || type
}

export function downloadSpiceVV(data: Record<string, unknown>, filename: string): void {
  const lines = ['[virt-viewer]']
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined && v !== null && v !== '') {
      lines.push(`${k}=${String(v)}`)
    }
  }
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'application/x-virt-viewer' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.vv') ? filename : `${filename}.vv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const el = document.createElement('textarea')
    el.value = text
    el.style.position = 'fixed'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    el.remove()
    return ok
  }
}
