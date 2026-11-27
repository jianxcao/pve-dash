import { useQuery } from '@tanstack/react-query'
import { Lock, RefreshCw, ScrollText } from 'lucide-react'
import { api } from '@/lib/api/client'
import { useAppStore } from '@/stores/appStore'
import { formatISOTime } from '@/lib/format'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { EmptyState } from '@/components/shared/EmptyState'
import { cn } from '@/lib/utils'

export function AuditPage() {
  const isAdmin = useAppStore((s) => s.currentUser?.role === 'admin')
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['audit-logs'],
    queryFn: () => api.getAuditLogs(),
    enabled: isAdmin,
  })

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-[1480px] px-5 py-6 sm:px-8 sm:py-7">
        <EmptyState
          icon={Lock}
          title="仅管理员可查阅平台操作审计日志"
          description="操作审计日志包含操作者 IP 与敏感变更记录，请联系管理员（admin）账号查看。"
        />
      </div>
    )
  }

  const items = data?.items ?? []

  return (
    <div className="mx-auto max-w-[1480px] px-5 py-6 sm:px-8 sm:py-7 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight">平台操作审计日志</h1>
          <p className="text-sm text-muted-foreground">
            全量记录通过 PVE Dash 发起的电源控制、快照、控制台与实例变更操作
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
          刷新
        </Button>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/12 px-5 py-4 text-sm text-destructive">
          加载审计日志失败：{error instanceof Error ? error.message : '未知错误'}
        </div>
      ) : isLoading ? (
        <div className="h-48 animate-pulse rounded-xl border border-border bg-card" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="暂无操作审计记录"
          description="当你执行实例接入、电源操作、快照或控制台连接后，审计记录会自动持久化展示在此处。"
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3.5 py-2.5 font-medium">时间</th>
                  <th className="px-2.5 py-2.5 font-medium">操作人 / IP</th>
                  <th className="px-2.5 py-2.5 font-medium">动作</th>
                  <th className="px-2.5 py-2.5 font-medium">资源 URN</th>
                  <th className="px-2.5 py-2.5 font-medium">摘要</th>
                  <th className="px-3.5 py-2.5 font-medium text-right">结果</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {items.map((log) => (
                  <tr key={log.id} className="hover:bg-muted/40">
                    <td className="px-3.5 py-2.5 font-mono-num text-xs text-muted-foreground whitespace-nowrap">
                      {formatISOTime(log.createdAt)}
                    </td>
                    <td className="px-2.5 py-2.5 whitespace-nowrap">
                      <span className="font-medium text-foreground">{log.username}</span>
                      <span className="ml-1.5 font-mono-num text-xs text-muted-foreground">
                        {log.clientIp}
                      </span>
                    </td>
                    <td className="px-2.5 py-2.5 font-mono-num text-info whitespace-nowrap">
                      {log.action}
                    </td>
                    <td className="px-2.5 py-2.5 font-mono-num text-muted-foreground max-w-[260px] truncate">
                      {log.resourceUrn || '—'}
                    </td>
                    <td className="px-2.5 py-2.5 text-muted-foreground max-w-[260px] truncate">
                      {log.errorMessage || log.payloadSummary || log.pveUpid || '—'}
                    </td>
                    <td className="px-3.5 py-2.5 text-right whitespace-nowrap">
                      <StatusBadge status={log.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
