import { toast } from 'sonner'
import { BookOpen, Copy, Webhook } from 'lucide-react'
import { copyToClipboard } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface PveNativeNotifyGuideDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const NOTIFY_PVE_TEMPLATE_JSON = JSON.stringify(
  {
    version: '1.0',
    exportTime: '2025-08-05T03:15:19.578Z',
    exportType: 'single',
    templates: [
      {
        id: 'pve',
        name: 'pve',
        title: '{{.title}}',
        content:
          '{{- if .fields.hostname }}🖥️ 主机: {{.fields.hostname}}{{end}}\n{{- if eq .severity "info"}}\n🔵 {{.severity}} (信息)\n{{- else if eq .severity "notice" -}}\n🟡 {{.severity}} (通知)\n{{- else if eq .severity "warning" -}}\n🟠 {{.severity}} (警告)\n{{- else if eq .severity "error" -}}\n🔴 {{.severity}} (错误)\n{{- else if eq .severity "unknown" -}}\n⚪ {{.severity}} (未知)\n{{- else if .severity -}}\n⚫ {{.severity}} (其他)\n{{- end}}\n{{- if .fields.type }}\n{{- if eq .fields.type "vzdump"}}\n✅ 备份成功\n{{- else if eq .fields.type "vzdump-fail" -}}\n❌ 备份失败\n{{- else if eq .fields.type "system-mail" -}}\n✉️ 系统邮件\n{{- else if eq .fields.type "package-updates" -}}\n📦 可以更新软件包\n{{- else if eq .fields.type "fencing" -}}\n🛡️ 生成失败\n{{- else if eq .fields.type "replication" -}}\n🔁 复制失败\n{{- else -}}\n{{- end -}}\n{{- else }}\n{{.content}}\n{{- end -}}',
        image: '{{.image}}',
        url: '{{.url}}',
        targets: '{{.targets}}',
      },
    ],
  },
  null,
  2,
)

const PVE_WEBHOOK_EXAMPLE_URL = 'https://notify.example.com:2053/api/v1/notify/pve'

const PVE_WEBHOOK_BODY = `{
  "title": "{{title}}",
  "content": "{{ escape message }}",
  "severity": "{{ severity }}",
  "fields": {{json fields}},
  "timestamp": "{{timestamp}}"
}`

export function PveNativeNotifyGuideDialog({
  open,
  onOpenChange,
}: PveNativeNotifyGuideDialogProps) {
  const copyText = async (text: string, label: string) => {
    await copyToClipboard(text)
    toast.success(`已复制 ${label}`)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(96vw,760px)] max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-accent" />
            <span>Notify 统一通知平台 & PVE 8.1+ 原生 Webhook 配置指南</span>
          </DialogTitle>
          <DialogDescription>
            一套 <code className="font-mono-num">pve</code> 模板同时兼容 PVE Dash（阈值巡检 + 运维/安全事件）与 Proxmox VE 宿主机原生通知系统（定时备份、HA Fencing、ZFS 复制与软件包更新）。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {/* Step 1 */}
          <div className="rounded-xl border border-border bg-muted/25 p-4 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold text-sm text-foreground">
                <Badge variant="accent" className="font-mono-num">
                  步骤 1
                </Badge>
                <span>在 Notify 平台导入 PVE 专用消息模板并创建应用</span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => void copyText(NOTIFY_PVE_TEMPLATE_JSON, 'Notify PVE 模板 JSON')}
              >
                <Copy className="h-3.5 w-3.5" />
                复制模板 JSON
              </Button>
            </div>
            <p className="text-muted-foreground leading-relaxed">
              打开 <code className="font-mono-num">jianxcao/notify</code> 管理后台 →「模板管理」→「导入模板」，粘贴下方 JSON 导入{' '}
              <code className="font-mono-num">pve</code> 模板；随后在「通知应用」中新建应用（如{' '}
              <code className="font-mono-num">pve</code>）并绑定该模板与下游推送渠道。
            </p>
            <pre className="max-h-44 overflow-auto rounded-lg border border-border bg-console-bg p-3 font-mono-num text-xs text-slate-200 leading-relaxed">
              {NOTIFY_PVE_TEMPLATE_JSON}
            </pre>
          </div>

          {/* Step 2 */}
          <div className="rounded-xl border border-border bg-muted/25 p-4 space-y-3">
            <div className="flex items-center gap-2 font-semibold text-sm text-foreground">
              <Badge variant="accent" className="font-mono-num">
                步骤 2
              </Badge>
              <span>（可选）配置 Proxmox VE 8.1+ 原生 Datacenter Webhook</span>
            </div>
            <p className="text-muted-foreground leading-relaxed">
              在 PVE 官方 Web 控制台进入{' '}
              <strong className="text-foreground">数据中心 (Datacenter) → 通知 (Notifications) → 通知目标 → 添加 → Webhook</strong>
              ，按下方 3 项填入即可接收宿主机底层定时备份 (<code className="font-mono-num">vzdump</code>)、HA 隔离与复制结果：
            </p>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/70 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground">
                    1. Endpoint URL（POST · 替换为你的 Notify 地址与应用 ID）
                  </div>
                  <div className="font-mono-num text-foreground truncate">
                    {PVE_WEBHOOK_EXAMPLE_URL}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => void copyText(PVE_WEBHOOK_EXAMPLE_URL, '示例接口地址')}
                >
                  <Copy className="h-3.5 w-3.5" />
                  复制
                </Button>
              </div>

              <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/70 px-3 py-2">
                <div>
                  <div className="text-xs text-muted-foreground">
                    2. Header 请求头（如应用开启了 Token 鉴权，再额外添加 Authorization: Bearer &lt;Token&gt;）
                  </div>
                  <div className="font-mono-num text-foreground">
                    Header Name: <span className="text-accent">Content-Type</span> · Value:{' '}
                    <span className="text-accent">application/json</span>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => void copyText('application/json', 'Content-Type 值')}
                >
                  <Copy className="h-3.5 w-3.5" />
                  复制
                </Button>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    3. Body 正文模板（PVE Handlebars 语法，直接完整粘贴）
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => void copyText(PVE_WEBHOOK_BODY, 'PVE Webhook Body 模板')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    复制 Body 正文
                  </Button>
                </div>
                <pre className="overflow-auto rounded-lg border border-border bg-console-bg p-3 font-mono-num text-xs text-slate-200 leading-relaxed">
                  {PVE_WEBHOOK_BODY}
                </pre>
              </div>
            </div>
          </div>

          {/* Step 3 */}
          <div className="rounded-xl border border-accent/30 bg-accent/[0.06] px-4 py-3 text-muted-foreground leading-relaxed flex items-start gap-2.5">
            <Webhook className="h-4 w-4 text-accent shrink-0 mt-0.5" />
            <div>
              <strong className="text-foreground">双端联动提示：</strong>在 PVE Dash「通知通道」中添加类型为{' '}
              <strong className="text-foreground">Notify 统一通知平台</strong> 的通道并指向同一接口地址后，PVE Dash 的{' '}
              <strong className="text-foreground">CPU/内存/存储/SMART 硬件阈值告警（含自动恢复）</strong> 与{' '}
              <strong className="text-foreground">8 类运维/2FA 安全审计事件</strong> 将自动通过同一套模板汇总推送。
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="primary" onClick={() => onOpenChange(false)}>
            完成阅读
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
