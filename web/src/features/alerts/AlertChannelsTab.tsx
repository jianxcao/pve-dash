import { useState } from 'react'
import { toast } from 'sonner'
import { BookOpen, Edit3, Loader2, Plus, Send, Trash2, Webhook } from 'lucide-react'
import { api } from '@/lib/api/client'
import type { AlertChannel } from '@/lib/api/types'
import { formatISOTime } from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { DangerConfirmDialog } from '@/components/shared/DangerConfirmDialog'
import { CHANNEL_TYPE_META } from './alertCatalog'
import { cn } from '@/lib/utils'

interface AlertChannelsTabProps {
  channels: AlertChannel[]
  isLoading: boolean
  error: unknown
  canManageChannels: boolean
  channelDisabledTip?: string
  onOpenCreate: () => void
  onOpenEdit: (ch: AlertChannel) => void
  onOpenPveGuide: () => void
  onRefreshChannels: () => void
  onMutated: () => void
}

export function AlertChannelsTab({
  channels,
  isLoading,
  error,
  canManageChannels,
  channelDisabledTip,
  onOpenCreate,
  onOpenEdit,
  onOpenPveGuide,
  onRefreshChannels,
  onMutated,
}: AlertChannelsTabProps) {
  const [testingChannelId, setTestingChannelId] = useState<string | null>(null)
  const [deletingChannel, setDeletingChannel] = useState<AlertChannel | null>(null)

  const handleToggleChannel = async (ch: AlertChannel, enabled: boolean) => {
    try {
      await api.updateAlertChannel(ch.id, { enabled })
      toast.success(enabled ? `已启用通道「${ch.name}」` : `已停用通道「${ch.name}」`)
      onMutated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新通道失败')
    }
  }

  const handleTestChannel = async (ch: AlertChannel) => {
    setTestingChannelId(ch.id)
    try {
      const res = await api.testAlertChannel(ch.id)
      if (res.ok) {
        toast.success(`通道「${ch.name}」测试消息发送成功！`)
      } else {
        toast.error(`通道「${ch.name}」发送失败：${res.error || '未知错误'}`)
      }
      onRefreshChannels()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '测试发送失败')
    } finally {
      setTestingChannelId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          支持 Notify 统一通知平台、飞书、钉钉、企业微信、Telegram Bot、Bark (iOS) 与通用 Webhook，配置密钥全部经 AES-256-GCM 加密落盘。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onOpenPveGuide}>
            <BookOpen className="h-4 w-4 text-accent" />
            PVE 原生通知接入指南
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canManageChannels}
            title={channelDisabledTip}
            onClick={onOpenCreate}
          >
            <Plus className="h-4 w-4" />
            添加通知通道
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/12 px-4 py-3 text-sm text-destructive">
          加载通知通道失败：{error instanceof Error ? error.message : '未知错误'}
        </div>
      ) : isLoading ? (
        <div className="p-10 text-center text-sm text-muted-foreground">正在加载通道列表...</div>
      ) : channels.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-14 text-center">
            <Webhook className="h-9 w-9 text-muted-foreground/70" />
            <div className="space-y-1">
              <div className="text-sm font-medium text-foreground">尚未配置外部通知通道</div>
              <p className="text-xs text-muted-foreground">
                未配置通道时告警仍会记录在本页「实时与历史告警」并在顶栏铃铛提示；添加 Notify 或机器人通道后可自动推送阈值告警与运维/安全事件。
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="outline" size="sm" onClick={onOpenPveGuide}>
                <BookOpen className="h-4 w-4 text-accent" />
                查看 PVE 原生 Webhook 指南
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!canManageChannels}
                title={channelDisabledTip}
                onClick={onOpenCreate}
              >
                <Plus className="h-4 w-4" />
                添加第一个通知通道
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {channels.map((ch) => {
            const meta = CHANNEL_TYPE_META[ch.type] || CHANNEL_TYPE_META.webhook
            const notifyExtras =
              ch.type === 'notify'
                ? [
                    ch.configPreview?.appId ? `app=${ch.configPreview.appId}` : '',
                    ch.configPreview?.targets ? `targets=${ch.configPreview.targets}` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : ''
            const preview =
              ch.type === 'telegram'
                ? `Chat ${ch.configPreview?.chatId || '—'} · Token ${ch.configPreview?.botTokenPreview || '••••'}`
                : [
                    ch.configPreview?.urlPreview ||
                      ch.configPreview?.deviceKeyPreview ||
                      '已加密存储',
                    notifyExtras,
                  ]
                    .filter(Boolean)
                    .join(' · ')
            return (
              <Card key={ch.id} className={cn(!ch.enabled && 'opacity-65')}>
                <CardHeader className="py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Switch
                        checked={ch.enabled}
                        disabled={!canManageChannels}
                        onCheckedChange={(v) => handleToggleChannel(ch, v)}
                        aria-label={`切换通道 ${ch.name}`}
                      />
                      <CardTitle className="truncate text-base">{ch.name}</CardTitle>
                      <Badge variant="accent">{meta.badge}</Badge>
                      {ch.configPreview?.hasSecret && (
                        <Badge variant="muted" className="text-[11px]">
                          {ch.type === 'notify' ? 'Bearer 鉴权' : '已设加签'}
                        </Badge>
                      )}
                    </div>
                    {ch.lastTestStatus === 'ok' && <Badge variant="success">测试通过</Badge>}
                    {ch.lastTestStatus === 'error' && (
                      <Badge variant="destructive">测试失败</Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  <div className="rounded-lg border border-border bg-background/60 px-3 py-2 font-mono-num text-xs text-muted-foreground truncate">
                    {preview}
                  </div>
                  {ch.lastTestError && (
                    <div className="rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-xs text-destructive break-all">
                      最近测试错误：{ch.lastTestError}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <span className="font-mono-num text-xs text-muted-foreground">
                      {ch.lastTestAt ? `上次测试 ${formatISOTime(ch.lastTestAt)}` : '尚未发送测试'}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={!canManageChannels || testingChannelId === ch.id}
                        title={channelDisabledTip}
                        onClick={() => handleTestChannel(ch)}
                      >
                        {testingChannelId === ch.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Send className="h-3.5 w-3.5 text-accent" />
                        )}
                        发送测试
                      </Button>
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={!canManageChannels}
                        title={channelDisabledTip}
                        onClick={() => onOpenEdit(ch)}
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!canManageChannels}
                        className="text-destructive hover:bg-destructive/15"
                        onClick={() => setDeletingChannel(ch)}
                        title={channelDisabledTip || '删除通道'}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <DangerConfirmDialog
        open={Boolean(deletingChannel)}
        onOpenChange={(v) => !v && setDeletingChannel(null)}
        title="删除通知通道"
        description={`确定移除通知通道「${deletingChannel?.name || ''}」？`}
        confirmTarget={deletingChannel?.name || ''}
        confirmLabel="确认删除"
        onConfirm={async () => {
          if (!deletingChannel) return
          await api.deleteAlertChannel(deletingChannel.id)
          toast.success(`已删除通道「${deletingChannel.name}」`)
          setDeletingChannel(null)
          onMutated()
        }}
      />
    </div>
  )
}
