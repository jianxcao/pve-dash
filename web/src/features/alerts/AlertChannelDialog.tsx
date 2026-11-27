import { useState } from 'react'
import { toast } from 'sonner'
import { BookOpen, Loader2 } from 'lucide-react'
import { api } from '@/lib/api/client'
import type { AlertChannel, AlertChannelType, ChannelConfigPayload } from '@/lib/api/types'
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
  onOpenPveGuide?: () => void
}

export function AlertChannelDialog({
  open,
  onOpenChange,
  editingChannel,
  onSaved,
  onOpenPveGuide,
}: AlertChannelDialogProps) {
  const [chName, setChName] = useState(() => editingChannel?.name || '')
  const [chType, setChType] = useState<AlertChannelType>(() => editingChannel?.type || 'notify')
  const [chURL, setChURL] = useState('')
  const [chSecret, setChSecret] = useState('')
  const [clearSecret, setClearSecret] = useState(false)
  const [chBotToken, setChBotToken] = useState('')
  const [chChatID, setChChatID] = useState(() => editingChannel?.configPreview?.chatId || '')
  const [chThreadID, setChThreadID] = useState(() => editingChannel?.configPreview?.threadId || '')
  const [chDeviceKey, setChDeviceKey] = useState('')
  const [clearDeviceKey, setClearDeviceKey] = useState(false)
  const [chAtAll, setChAtAll] = useState(() => Boolean(editingChannel?.configPreview?.atAll))
  const [chAppId, setChAppId] = useState(() => editingChannel?.configPreview?.appId || '')
  const [chTargets, setChTargets] = useState(() => editingChannel?.configPreview?.targets || '')
  const [chPanelUrl, setChPanelUrl] = useState(() => editingChannel?.configPreview?.panelUrl || '')
  const [chSaving, setChSaving] = useState(false)

  const currentChannelMeta = CHANNEL_TYPE_META[chType] || CHANNEL_TYPE_META.webhook
  const supportsSecret =
    chType === 'notify' || chType === 'feishu' || chType === 'dingtalk' || chType === 'webhook'
  const isEditingSameType = Boolean(editingChannel && chType === editingChannel.type)

  const savedUrlPreview = isEditingSameType ? editingChannel?.configPreview?.urlPreview : undefined
  const savedBotTokenPreview = isEditingSameType
    ? editingChannel?.configPreview?.botTokenPreview
    : undefined
  const savedDeviceKeyPreview = isEditingSameType
    ? editingChannel?.configPreview?.deviceKeyPreview
    : undefined

  const handleSaveChannel = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!chName.trim()) return
    setChSaving(true)
    try {
      const baseCfg: ChannelConfigPayload = {
        url: chURL.trim() || undefined,
        secret: supportsSecret && !clearSecret ? chSecret.trim() || undefined : undefined,
        botToken: chType === 'telegram' ? chBotToken.trim() || undefined : undefined,
        chatId: chType === 'telegram' ? chChatID.trim() || undefined : undefined,
        threadId: chType === 'telegram' ? chThreadID.trim() : undefined,
        deviceKey:
          chType === 'bark' && !clearDeviceKey ? chDeviceKey.trim() || undefined : undefined,
        atAll: chType === 'dingtalk' ? chAtAll : undefined,
        appId: chType === 'notify' ? chAppId.trim() : undefined,
        targets: chType === 'notify' ? chTargets.trim() : undefined,
        panelUrl: chType === 'notify' ? chPanelUrl.trim() : undefined,
      }
      if (editingChannel) {
        const shouldSendClearSecret =
          (supportsSecret && clearSecret) || (chType === 'bark' && clearDeviceKey)
        const updateCfg: ChannelConfigPayload = shouldSendClearSecret
          ? { ...baseCfg, clearSecret: true }
          : baseCfg
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
            所有 Webhook URL / Token / 鉴权密钥均经 AES-256-GCM 加密保存；编辑时留空敏感字段将保留原有已保存配置。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSaveChannel} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-foreground">通道名称</label>
              <Input
                value={chName}
                onChange={(e) => setChName(e.target.value)}
                placeholder={chType === 'notify' ? '例如：Notify 统一告警中心' : '例如：飞书运维告警群'}
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
                  setClearDeviceKey(false)
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

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/80 bg-muted/35 px-3 py-2">
            <p className="text-xs text-muted-foreground flex-1">{currentChannelMeta.hint}</p>
            {chType === 'notify' && onOpenPveGuide && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={onOpenPveGuide}
                className="shrink-0"
              >
                <BookOpen className="h-3.5 w-3.5 text-accent" />
                查看 Notify 模板指南
              </Button>
            )}
          </div>

          {chType === 'telegram' ? (
            <>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-foreground">
                  Bot Token {isEditingSameType ? '（留空保持不变）' : ''}
                </label>
                <Input
                  type="password"
                  value={chBotToken}
                  onChange={(e) => setChBotToken(e.target.value)}
                  placeholder={
                    savedBotTokenPreview
                      ? `当前已保存: ${savedBotTokenPreview}（留空保持不变）`
                      : currentChannelMeta.placeholder
                  }
                  required={!isEditingSameType}
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
                    required={!isEditingSameType}
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
                  {chType === 'bark'
                    ? 'Bark 服务器地址'
                    : chType === 'notify'
                      ? 'Notify 接口地址 (URL)'
                      : 'Webhook URL'}
                  {isEditingSameType ? '（留空保持不变）' : ''}
                </label>
                <Input
                  value={chURL}
                  onChange={(e) => setChURL(e.target.value)}
                  placeholder={
                    savedUrlPreview
                      ? `当前已保存: ${savedUrlPreview}（留空保持不变）`
                      : currentChannelMeta.placeholder
                  }
                  required={!isEditingSameType && chType !== 'bark'}
                  className="font-mono-num"
                />
              </div>

              {chType === 'notify' && (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-foreground">
                        应用标识 App ID（可选）
                      </label>
                      <Input
                        value={chAppId}
                        onChange={(e) => setChAppId(e.target.value)}
                        placeholder="如 pve（URL 未含路径时自动拼接）"
                        className="font-mono-num"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-foreground">
                        指定转发目标 Targets（可选）
                      </label>
                      <Input
                        value={chTargets}
                        onChange={(e) => setChTargets(e.target.value)}
                        placeholder="留空使用 Notify 应用默认渠道"
                        className="font-mono-num"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-foreground">
                      面板外部访问地址 Panel URL（可选）
                    </label>
                    <Input
                      value={chPanelUrl}
                      onChange={(e) => setChPanelUrl(e.target.value)}
                      placeholder="https://pve-dash.example.com（用于生成通知卡片详情跳转链接）"
                      className="font-mono-num"
                    />
                  </div>
                </>
              )}

              {chType === 'bark' && (
                <div className="space-y-2">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-foreground">
                      Bark Device Key {isEditingSameType ? '（留空保持不变）' : ''}
                    </label>
                    <Input
                      disabled={clearDeviceKey}
                      value={chDeviceKey}
                      onChange={(e) => {
                        setChDeviceKey(e.target.value)
                        if (e.target.value) setClearDeviceKey(false)
                      }}
                      placeholder={
                        clearDeviceKey
                          ? '保存后将清空独立 Device Key'
                          : savedDeviceKeyPreview
                            ? `当前已保存: ${savedDeviceKeyPreview}（留空保持不变）`
                            : '如已在 URL 末尾附带 Key，此处可留空'
                      }
                      className="font-mono-num"
                    />
                  </div>
                  {isEditingSameType && Boolean(savedDeviceKeyPreview) && (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={clearDeviceKey}
                        onChange={(e) => {
                          setClearDeviceKey(e.target.checked)
                          if (e.target.checked) setChDeviceKey('')
                        }}
                        className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                      />
                      <span>清空已有独立 Device Key（改用 URL 内置 Key 路径）</span>
                    </label>
                  )}
                </div>
              )}

              {supportsSecret && (
                <div className="space-y-2">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-foreground">
                      {chType === 'notify'
                        ? `接口鉴权 Bearer Token（可选${editingChannel ? '，留空保持不变' : ''}）`
                        : `签名密钥 / Secret（可选${editingChannel ? '，留空保持不变' : ''}）`}
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
                          ? '保存后将清空已有密钥'
                          : chType === 'notify'
                            ? 'Notify 应用鉴权 Token（自动附加 Authorization: Bearer ...）'
                            : 'SEC... 或自定义 HMAC 密钥'
                      }
                      className="font-mono-num"
                    />
                  </div>
                  {isEditingSameType && (
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
                        清空已有{chType === 'notify' ? '鉴权 Token' : '签名密钥'} (clearSecret)
                        {editingChannel?.configPreview?.hasSecret ? ' · 当前已配置密钥' : ''}
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
