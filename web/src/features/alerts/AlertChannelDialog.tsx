import { useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api/client'
import type { AlertChannel, AlertChannelType } from '@/lib/api/types'
import { Button } from '@/components/ui/button'
import { Input, NativeSelect } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CHANNEL_TYPE_META } from './alertCatalog'

interface AlertChannelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingChannel: AlertChannel | null
  onSaved: () => void
}

export function AlertChannelDialog({
  open,
  onOpenChange,
  editingChannel,
  onSaved,
}: AlertChannelDialogProps) {
  const [chName, setChName] = useState(() => editingChannel?.name || '')
  const [chType, setChType] = useState<AlertChannelType>(() => editingChannel?.type || 'feishu')
  const [chURL, setChURL] = useState('')
  const [chSecret, setChSecret] = useState('')
  const [clearSecret, setClearSecret] = useState(false)
  const [chBotToken, setChBotToken] = useState('')
  const [chChatID, setChChatID] = useState(() => editingChannel?.configPreview?.chatId || '')
  const [chThreadID, setChThreadID] = useState(() => editingChannel?.configPreview?.threadId || '')
  const [chDeviceKey, setChDeviceKey] = useState('')
  const [chAtAll, setChAtAll] = useState(() => Boolean(editingChannel?.configPreview?.atAll))
  const [chSaving, setChSaving] = useState(false)

  const currentChannelMeta = CHANNEL_TYPE_META[chType]
  const supportsSecret = chType === 'feishu' || chType === 'dingtalk' || chType === 'webhook'

  const handleSaveChannel = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!chName.trim()) return
    setChSaving(true)
    try {
      const baseCfg = {
        url: chURL.trim() || undefined,
        secret: supportsSecret && !clearSecret ? chSecret.trim() || undefined : undefined,
        botToken: chBotToken.trim() || undefined,
        chatId: chChatID.trim() || undefined,
        threadId: chType === 'telegram' ? chThreadID.trim() : undefined,
        deviceKey: chDeviceKey.trim() || undefined,
        atAll: chAtAll,
      }
      if (editingChannel) {
        const updateCfg = (
          supportsSecret && clearSecret ? { ...baseCfg, clearSecret: true } : baseCfg
        ) as Parameters<typeof api.updateAlertChannel>[1]['config']
        await api.updateAlertChannel(editingChannel.id, {
          name: chName.trim(),
          type: chType,
          config: updateCfg,
        })
        toast.success(`已更新通知通道「${chName.trim()}」`)
      } else {
        await api.createAlertChannel({
          name: chName.trim(),
          type: chType,
          enabled: true,
          config: baseCfg,
        })
        toast.success(`已添加通知通道「${chName.trim()}」`)
      }
      onOpenChange(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存通道失败')
    } finally {
      setChSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editingChannel ? '编辑通知通道' : '添加外部通知通道'}</DialogTitle>
          <DialogDescription>
            所有 Webhook Token / 签名密钥均经 AES-256-GCM 加密保存；编辑时留空密钥字段将保留原有配置。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSaveChannel} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-foreground">通道名称</label>
              <Input
                value={chName}
                onChange={(e) => setChName(e.target.value)}
                placeholder="例如：飞书运维告警群"
                required
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-foreground">平台类型</label>
              <NativeSelect
                className="w-full"
                value={chType}
                onChange={(e) => {
                  setChType(e.target.value as AlertChannelType)
                  setClearSecret(false)
                }}
              >
                {(Object.keys(CHANNEL_TYPE_META) as AlertChannelType[]).map((k) => (
                  <option key={k} value={k}>
                    {CHANNEL_TYPE_META[k].label}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">{currentChannelMeta.hint}</p>

          {chType === 'telegram' ? (
            <>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-foreground">
                  Bot Token{' '}
                  {editingChannel && chType === editingChannel.type ? '（留空保持不变）' : ''}
                </label>
                <Input
                  type="password"
                  value={chBotToken}
                  onChange={(e) => setChBotToken(e.target.value)}
                  placeholder={currentChannelMeta.placeholder}
                  required={!editingChannel || chType !== editingChannel.type}
                  className="font-mono-num"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">Chat ID</label>
                  <Input
                    value={chChatID}
                    onChange={(e) => setChChatID(e.target.value)}
                    placeholder="-1001234567890"
                    required={!editingChannel || chType !== editingChannel.type}
                    className="font-mono-num"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">
                    Topic Thread ID（可选）
                  </label>
                  <Input
                    value={chThreadID}
                    onChange={(e) => setChThreadID(e.target.value)}
                    placeholder="留空发至主会话"
                    className="font-mono-num"
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-foreground">
                  {chType === 'bark' ? 'Bark 服务器地址' : 'Webhook URL'}
                  {editingChannel && chType === editingChannel.type ? '（留空保持不变）' : ''}
                </label>
                <Input
                  value={chURL}
                  onChange={(e) => setChURL(e.target.value)}
                  placeholder={currentChannelMeta.placeholder}
                  required={(!editingChannel || chType !== editingChannel.type) && chType !== 'bark'}
                  className="font-mono-num"
                />
              </div>

              {chType === 'bark' && (
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">
                    Bark Device Key{' '}
                    {editingChannel && chType === editingChannel.type ? '（留空保持不变）' : ''}
                  </label>
                  <Input
                    value={chDeviceKey}
                    onChange={(e) => setChDeviceKey(e.target.value)}
                    placeholder="如已在 URL 末尾附带 Key，此处可留空"
                    className="font-mono-num"
                  />
                </div>
              )}

              {supportsSecret && (
                <div className="space-y-2">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-foreground">
                      签名密钥 / Secret（可选{editingChannel ? '，留空保持不变' : ''}）
                    </label>
                    <Input
                      type="password"
                      disabled={clearSecret}
                      value={chSecret}
                      onChange={(e) => {
                        setChSecret(e.target.value)
                        if (e.target.value) setClearSecret(false)
                      }}
                      placeholder={
                        clearSecret
                          ? '保存后将清空已有签名密钥'
                          : 'SEC... 或自定义 HMAC 密钥'
                      }
                      className="font-mono-num"
                    />
                  </div>
                  {editingChannel && chType === editingChannel.type && (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={clearSecret}
                        onChange={(e) => {
                          setClearSecret(e.target.checked)
                          if (e.target.checked) setChSecret('')
                        }}
                        className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                      />
                      <span>
                        清空已有签名密钥 (clearSecret)
                        {editingChannel.configPreview?.hasSecret ? ' · 当前已启用加签' : ''}
                      </span>
                    </label>
                  )}
                </div>
              )}

              {chType === 'dingtalk' && (
                <div className="flex items-center justify-between rounded-lg border border-border bg-background/60 px-3.5 py-2.5">
                  <span className="text-xs text-foreground">严重告警触发时自动 @所有人</span>
                  <Switch checked={chAtAll} onCheckedChange={setChAtAll} />
                </div>
              )}
            </>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={chSaving}>
              {chSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              {editingChannel ? '保存配置' : '添加通道'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
