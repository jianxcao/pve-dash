import { createElement } from 'react'
import { AlertOctagon, AlertTriangle, Info } from 'lucide-react'
import type { AlertChannelType, AlertMetricKey, AlertSeverity } from '@/lib/api/types'
import { Badge } from '@/components/ui/badge'

export interface MetricMeta {
  key: AlertMetricKey
  label: string
  category: string
  defaultOp: 'gte' | 'lte'
  defaultThreshold: number
  defaultSeverity: AlertSeverity
  unit: string
  hint: string
}

export const METRIC_CATALOG: MetricMeta[] = [
  {
    key: 'node_offline',
    label: 'PVE 节点离线',
    category: '可用性',
    defaultOp: 'gte',
    defaultThreshold: 1,
    defaultSeverity: 'critical',
    unit: '',
    hint: '宿主机节点失联或状态非 online 时立即触发',
  },
  {
    key: 'instance_offline',
    label: 'PVE 实例 API 不可达',
    category: '可用性',
    defaultOp: 'gte',
    defaultThreshold: 1,
    defaultSeverity: 'critical',
    unit: '',
    hint: '整个 PVE 集群 / 实例连接失败或超时',
  },
  {
    key: 'node_cpu',
    label: '宿主机 CPU 使用率',
    category: '节点资源',
    defaultOp: 'gte',
    defaultThreshold: 90,
    defaultSeverity: 'warning',
    unit: '%',
    hint: '宿主机 CPU 负载持续超过阈值百分比',
  },
  {
    key: 'node_mem',
    label: '宿主机内存使用率',
    category: '节点资源',
    defaultOp: 'gte',
    defaultThreshold: 90,
    defaultSeverity: 'warning',
    unit: '%',
    hint: '宿主机物理内存占用率达到警戒线',
  },
  {
    key: 'storage_usage',
    label: '存储池容量占用率',
    category: '存储与磁盘',
    defaultOp: 'gte',
    defaultThreshold: 85,
    defaultSeverity: 'critical',
    unit: '%',
    hint: 'local / LVM / ZFS / NFS 存储池空间不足',
  },
  {
    key: 'disk_health',
    label: '物理硬盘 SMART 健康度',
    category: '存储与磁盘',
    defaultOp: 'lte',
    defaultThreshold: 80,
    defaultSeverity: 'warning',
    unit: '%',
    hint: '硬盘综合健康度（含 NVMe 损耗与 SATA 重映射扇区）低于阈值',
  },
  {
    key: 'disk_temp',
    label: '物理硬盘温度',
    category: '存储与磁盘',
    defaultOp: 'gte',
    defaultThreshold: 55,
    defaultSeverity: 'warning',
    unit: '°C',
    hint: '物理磁盘 SMART 温度超过安全上限',
  },
  {
    key: 'cpu_temp',
    label: '宿主机 CPU 封装温度',
    category: '节点资源',
    defaultOp: 'gte',
    defaultThreshold: 85,
    defaultSeverity: 'warning',
    unit: '°C',
    hint: '依赖宿主机 lm-sensors 采集的 CPU 封装温度',
  },
  {
    key: 'guest_cpu',
    label: 'VM / LXC 单实例 CPU',
    category: '计算实例',
    defaultOp: 'gte',
    defaultThreshold: 95,
    defaultSeverity: 'warning',
    unit: '%',
    hint: '单个运行中虚拟机或容器 CPU 持续打满',
  },
  {
    key: 'guest_mem',
    label: 'VM / LXC 单实例内存',
    category: '计算实例',
    defaultOp: 'gte',
    defaultThreshold: 92,
    defaultSeverity: 'warning',
    unit: '%',
    hint: '单个运行中虚拟机或容器内存接近 OOM',
  },
  {
    key: 'backup_uncovered',
    label: '未纳入定时备份实例数',
    category: '容灾备份',
    defaultOp: 'gte',
    defaultThreshold: 1,
    defaultSeverity: 'info',
    unit: '台',
    hint: '巡检集群中未被任何定时备份计划覆盖的 VM/LXC',
  },
]

export const METRIC_MAP = Object.fromEntries(METRIC_CATALOG.map((m) => [m.key, m])) as Record<
  string,
  MetricMeta | undefined
>

export const CHANNEL_TYPE_META: Record<
  AlertChannelType,
  { label: string; badge: string; placeholder: string; hint: string }
> = {
  feishu: {
    label: '飞书自定义机器人',
    badge: '飞书',
    placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx',
    hint: '发送彩色交互卡片（红/橙/绿自动区分严重度与恢复状态），支持可选签名校验密钥。',
  },
  dingtalk: {
    label: '钉钉自定义机器人',
    badge: '钉钉',
    placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxx',
    hint: '发送 Markdown 告警卡片，支持加签 Secret 与严重告警自动 @所有人。',
  },
  wecom: {
    label: '企业微信群机器人',
    badge: '企微',
    placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx',
    hint: '发送彩色 Markdown 告警消息到企业微信群。',
  },
  telegram: {
    label: 'Telegram Bot',
    badge: 'Telegram',
    placeholder: '123456789:AAHxxxxxxxxxxxxxxxx',
    hint: '填写 @BotFather 颁发的 Bot Token 与目标群组/个人 Chat ID（可选 Topic Thread ID）。',
  },
  bark: {
    label: 'Bark (iOS 实时推送)',
    badge: 'Bark',
    placeholder: 'https://api.day.app',
    hint: '严重告警自动使用 timeSensitive 时效性通知，支持自建 Bark 服务器。',
  },
  webhook: {
    label: '通用 JSON Webhook',
    badge: 'Webhook',
    placeholder: 'https://your-service.example.com/hooks/pve-dash',
    hint: 'POST 标准 JSON 告警负载；填写密钥时自动附加 X-PVEDash-Signature (HMAC-SHA256)。',
  },
}

export function renderSeverityBadge(sev: AlertSeverity | string) {
  if (sev === 'critical') {
    return createElement(
      Badge,
      { variant: 'destructive', className: 'gap-1' },
      createElement(AlertOctagon, { className: 'h-3 w-3' }),
      '严重',
    )
  }
  if (sev === 'warning') {
    return createElement(
      Badge,
      { variant: 'warning', className: 'gap-1' },
      createElement(AlertTriangle, { className: 'h-3 w-3' }),
      '警告',
    )
  }
  return createElement(
    Badge,
    { variant: 'info', className: 'gap-1' },
    createElement(Info, { className: 'h-3 w-3' }),
    '提示',
  )
}

export function renderAlertStatusBadge(st: string) {
  if (st === 'firing') return createElement(Badge, { variant: 'destructive' }, '触发中')
  if (st === 'acknowledged') return createElement(Badge, { variant: 'warning' }, '已确认')
  return createElement(Badge, { variant: 'success' }, '已恢复')
}
