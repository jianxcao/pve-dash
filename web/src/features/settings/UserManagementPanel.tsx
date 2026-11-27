import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Edit3,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  UserCheck,
  Users,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { UserWithSessions } from '@/lib/api/types'
import { useAppStore } from '@/stores/appStore'
import { formatISOTime } from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input, NativeSelect } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { DangerConfirmDialog } from '@/components/shared/DangerConfirmDialog'
import { cn } from '@/lib/utils'

const ROLE_META: Record<
  string,
  { label: string; desc: string; variant: 'accent' | 'success' | 'warning' | 'muted' }
> = {
  admin: {
    label: '管理员 (Admin)',
    desc: '全量权限：用户管理、实例接入、告警通道、配置备份、审计日志与 API 逃生舱',
    variant: 'accent',
  },
  operator: {
    label: '运维员 (Operator)',
    desc: '日常运维权限：VM/LXC 控制、快照、备份、存储、网络、防火墙与终端操作',
    variant: 'success',
  },
  viewer: {
    label: '只读观众 (Viewer)',
    desc: '只读监控权限：查看全局大盘、硬件体检与日志，全局禁止所有写入与终端操作',
    variant: 'warning',
  },
}

export function UserManagementPanel() {
  const queryClient = useQueryClient()
  const currentUser = useAppStore((s) => s.currentUser)
  const setCurrentUser = useAppStore((s) => s.setCurrentUser)
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['users'],
    queryFn: api.listUsers,
  })

  const users = useMemo(() => data?.items ?? [], [data?.items])

  const counts = useMemo(() => {
    let admins = 0
    let operators = 0
    let viewers = 0
    let sessions = 0
    for (const u of users) {
      if (u.role === 'admin') admins++
      else if (u.role === 'operator') operators++
      else viewers++
      sessions += u.activeSessions || 0
    }
    return { total: users.length, admins, operators, viewers, sessions }
  }, [users])

  // Create / Edit dialog
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<UserWithSessions | null>(null)
  const [fUsername, setFUsername] = useState('')
  const [fDisplayName, setFDisplayName] = useState('')
  const [fRole, setFRole] = useState<'admin' | 'operator' | 'viewer'>('operator')
  const [fActive, setFActive] = useState(true)
  const [fPassword, setFPassword] = useState('')
  const [saving, setSaving] = useState(false)

  // Revoke / Delete targets
  const [revokeTarget, setRevokeTarget] = useState<UserWithSessions | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<UserWithSessions | null>(null)

  const openCreate = () => {
    setEditing(null)
    setFUsername('')
    setFDisplayName('')
    setFRole('operator')
    setFActive(true)
    setFPassword('')
    setModalOpen(true)
  }

  const openEdit = (u: UserWithSessions) => {
    setEditing(u)
    setFUsername(u.username)
    setFDisplayName(u.displayName || u.username)
    setFRole(u.role === 'admin' || u.role === 'operator' || u.role === 'viewer' ? u.role : 'viewer')
    setFActive(u.isActive)
    setFPassword('')
    setModalOpen(true)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (readOnly) return
    if (!editing) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/.test(fUsername.trim())) {
        toast.error('用户名须为 2–32 位字母/数字/点/下划线/连字符，且以字母或数字开头')
        return
      }
      if (fPassword.length < 8) {
        toast.error('初始密码至少需要 8 个字符')
        return
      }
    } else if (fPassword && fPassword.length < 8) {
      toast.error('重置密码至少需要 8 个字符')
      return
    }
    setSaving(true)
    try {
      if (editing) {
        const isSelfEdit = Boolean(currentUser && editing.id === currentUser.id)
        const updated = await api.updateUser(editing.id, {
          displayName: fDisplayName.trim(),
          role: isSelfEdit ? undefined : fRole,
          isActive: isSelfEdit ? undefined : fActive,
          password: isSelfEdit ? undefined : fPassword || undefined,
        })
        if (isSelfEdit) {
          setCurrentUser(updated)
        }
        toast.success(`用户 "${editing.username}" 已更新${!isSelfEdit && fPassword ? '（旧会话已吊销）' : ''}`)
      } else {
        await api.createUser({
          username: fUsername.trim(),
          displayName: fDisplayName.trim() || fUsername.trim(),
          password: fPassword,
          role: fRole,
          isActive: fActive,
        })
        toast.success(`已创建用户 "${fUsername.trim()}"`)
      }
      setModalOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['users'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存用户失败')
    } finally {
      setSaving(false)
    }
  }

  const handleConfirmRevoke = async () => {
    if (!revokeTarget || readOnly) return
    const res = await api.revokeUserSessions(revokeTarget.id)
    toast.success(
      `已吊销 ${revokeTarget.username} 的全部访问令牌（清理 ${res.revokedSessions} 个活跃刷新会话）`,
    )
    void queryClient.invalidateQueries({ queryKey: ['users'] })
  }

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/12 px-5 py-4 text-sm text-destructive">
        加载用户列表失败：{error instanceof Error ? error.message : '未知错误'}
      </div>
    )
  }

  const isEditingSelf = Boolean(editing && currentUser && editing.id === currentUser.id)

  return (
    <div className="space-y-5">
      {/* RBAC Role Explanation Cards */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {(['admin', 'operator', 'viewer'] as const).map((r) => {
          const meta = ROLE_META[r]
          const count = r === 'admin' ? counts.admins : r === 'operator' ? counts.operators : counts.viewers
          return (
            <Card key={r}>
              <CardContent className="p-4 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Badge variant={meta.variant}>{meta.label}</Badge>
                  <span className="font-mono-num text-sm font-semibold text-foreground">{count} 人</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{meta.desc}</p>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Users Table */}
      <Card className="overflow-hidden">
        <CardHeader className="py-3.5 border-b border-border/70 flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Users className="h-4 w-4 text-accent" />
            <span>平台账号与活跃会话 ({counts.total})</span>
            <Badge variant="muted" className="font-mono-num">
              活跃会话 {counts.sessions}
            </Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={readOnly}
              title={readOnly ? '写保护已开启' : '创建新登录账号'}
              onClick={openCreate}
            >
              <Plus className="h-4 w-4" />
              新建用户
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => refetch()}
              disabled={isFetching}
              aria-label="刷新用户列表"
            >
              <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
            </Button>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {isLoading && users.length === 0 ? (
            <div className="h-40 animate-pulse bg-card" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">用户名 / 显示名</th>
                    <th className="px-4 py-2.5 font-medium">RBAC 角色</th>
                    <th className="px-4 py-2.5 font-medium">状态</th>
                    <th className="px-4 py-2.5 font-medium">活跃会话</th>
                    <th className="px-4 py-2.5 font-medium">创建时间</th>
                    <th className="px-4 py-2.5 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {users.map((u) => {
                    const meta = ROLE_META[u.role] || {
                      label: u.role,
                      variant: 'muted' as const,
                    }
                    const isSelf = currentUser?.id === u.id
                    return (
                      <tr key={u.id} className="hover:bg-muted/35">
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <span className="font-mono-num font-semibold text-foreground">
                              {u.username}
                            </span>
                            {isSelf && <Badge variant="info">当前登录</Badge>}
                          </div>
                          {u.displayName && u.displayName !== u.username && (
                            <div className="text-xs text-muted-foreground">{u.displayName}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <Badge variant={meta.variant}>{meta.label}</Badge>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <Badge variant={u.isActive ? 'success' : 'destructive'}>
                            {u.isActive ? '正常启用' : '已停用'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 font-mono-num text-xs text-muted-foreground whitespace-nowrap">
                          {u.activeSessions} 个会话
                        </td>
                        <td className="px-4 py-3 font-mono-num text-xs text-muted-foreground whitespace-nowrap">
                          {formatISOTime(u.createdAt)}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={readOnly}
                              title={readOnly ? '写保护已开启' : `编辑 ${u.username}`}
                              onClick={() => openEdit(u)}
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={readOnly || isSelf}
                              title={
                                isSelf
                                  ? '不能强制踢下线当前会话，请使用修改密码或退出登录'
                                  : readOnly
                                    ? '写保护已开启'
                                    : `立即吊销 ${u.username} 的全部登录会话`
                              }
                              onClick={() => setRevokeTarget(u)}
                            >
                              <LogOut className="h-3.5 w-3.5 text-warning" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={readOnly || isSelf}
                              title={
                                isSelf
                                  ? '不能删除当前正在登录的账号'
                                  : readOnly
                                    ? '写保护已开启'
                                    : `删除 ${u.username}`
                              }
                              onClick={() => setDeleteTarget(u)}
                            >
                              <Trash2 className="h-3.5 w-3.5 text-destructive" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create / Edit User Dialog */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-4.5 w-4.5 text-accent" />
              {editing ? `编辑用户 · ${editing.username}` : '新建平台用户'}
            </DialogTitle>
            <DialogDescription>
              角色权限变更实时生效，无需等待旧 JWT 过期；重置密码或停用账号会立即吊销全部历史会话。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSave} className="space-y-3.5">
            {!editing && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">登录用户名</label>
                <Input
                  value={fUsername}
                  onChange={(e) => setFUsername(e.target.value)}
                  placeholder="如 ops-alice"
                  className="font-mono-num"
                  required
                />
              </div>
            )}

            <div className="space-y-1.5">
              <label className="block text-xs font-medium">显示名称</label>
              <Input
                value={fDisplayName}
                onChange={(e) => setFDisplayName(e.target.value)}
                placeholder="如 运维工程师 Alice"
                required={Boolean(editing)}
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium">RBAC 权限角色</label>
              <NativeSelect
                value={fRole}
                onChange={(e) => setFRole(e.target.value as 'admin' | 'operator' | 'viewer')}
                disabled={isEditingSelf}
                className="w-full"
              >
                <option value="admin">admin — 超级管理员（全部权限）</option>
                <option value="operator">operator — 运维员（日常读写与控制台）</option>
                <option value="viewer">viewer — 只读观众（仅监控只读）</option>
              </NativeSelect>
              {isEditingSelf && (
                <p className="text-[11px] text-muted-foreground">
                  当前登录的管理员不可自我降级或停用。
                </p>
              )}
            </div>

            {!isEditingSelf ? (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">
                  {editing ? '重置登录密码（留空则保持不变）' : '初始登录密码（至少 8 位）'}
                </label>
                <Input
                  type="password"
                  value={fPassword}
                  onChange={(e) => setFPassword(e.target.value)}
                  placeholder={editing ? '留空不修改' : '至少 8 个字符'}
                  minLength={editing ? undefined : 8}
                  required={!editing}
                />
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
                如需修改当前管理员本人密码，请前往「外观偏好与密码」标签页验证原密码后修改。
              </div>
            )}

            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={fActive}
                disabled={isEditingSelf}
                onChange={(e) => setFActive(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              <UserCheck className="h-3.5 w-3.5 text-success" />
              <span>账号处于启用状态（取消勾选将立即阻断登录并踢下线）</span>
            </label>

            <DialogFooter>
              <Button variant="outline" onClick={() => setModalOpen(false)} disabled={saving}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={saving || readOnly}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editing ? '保存变更' : '创建账号'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Revoke Sessions Dialog */}
      <ConfirmDialog
        open={Boolean(revokeTarget)}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null)
        }}
        title={`强制吊销会话 · ${revokeTarget?.username ?? ''}`}
        description="将立即递增该账号的令牌版本号并清空所有刷新会话，该用户当前在所有浏览器/设备上已登录的页面将立刻失效并需重新输入密码。"
        confirmLabel="立即踢下线"
        variant="destructive"
        onConfirm={handleConfirmRevoke}
      />

      {/* Delete User Confirm */}
      <DangerConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={`删除用户账号 · ${deleteTarget?.username ?? ''}`}
        description="确认永久删除该用户账号及其个人偏好与登录会话？（不会删除该账号产生的历史审计日志）"
        confirmTarget={deleteTarget?.username ?? ''}
        confirmLabel="确认删除用户"
        onConfirm={async () => {
          if (!deleteTarget) return
          await api.deleteUser(deleteTarget.id, deleteTarget.username)
          toast.success(`用户 "${deleteTarget.username}" 已删除`)
          void queryClient.invalidateQueries({ queryKey: ['users'] })
        }}
      />
    </div>
  )
}
