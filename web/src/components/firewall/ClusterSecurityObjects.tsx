import { Globe, Layers, Tag } from 'lucide-react'
import type { FirewallAlias, FirewallGroup, FirewallIPSet } from '@/lib/api/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface ClusterSecurityObjectsProps {
  aliases: FirewallAlias[]
  ipsets: FirewallIPSet[]
  groups: FirewallGroup[]
}

export function ClusterSecurityObjects({
  aliases,
  ipsets,
  groups,
}: ClusterSecurityObjectsProps) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card>
        <CardHeader className="py-3 border-b border-border/70">
          <CardTitle className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              <Tag className="h-3.5 w-3.5 text-accent" />
              IP 别名 (Aliases)
            </span>
            <Badge variant="muted" className="font-mono-num">
              {aliases.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3.5">
          {aliases.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">暂无集群 IP 别名定义</p>
          ) : (
            <div className="space-y-2">
              {aliases.map((a) => (
                <div
                  key={a.name}
                  className="rounded-lg border border-border/80 bg-background/50 px-3 py-2 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono-num font-semibold text-foreground">{a.name}</span>
                    <span className="font-mono-num text-accent">{a.cidr}</span>
                  </div>
                  {a.comment && (
                    <p className="mt-1 text-[11px] text-muted-foreground">{a.comment}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3 border-b border-border/70">
          <CardTitle className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5 text-info" />
              IP 集合 (IPSets)
            </span>
            <Badge variant="muted" className="font-mono-num">
              {ipsets.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3.5">
          {ipsets.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">暂无集群 IP 集合定义</p>
          ) : (
            <div className="space-y-2">
              {ipsets.map((s) => (
                <div
                  key={s.name}
                  className="rounded-lg border border-border/80 bg-background/50 px-3 py-2 text-xs"
                >
                  <div className="font-mono-num font-semibold text-foreground">+{s.name}</div>
                  {s.comment && (
                    <p className="mt-1 text-[11px] text-muted-foreground">{s.comment}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3 border-b border-border/70">
          <CardTitle className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5 text-warning" />
              安全组 (Security Groups)
            </span>
            <Badge variant="muted" className="font-mono-num">
              {groups.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3.5">
          {groups.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">暂无集群安全组定义</p>
          ) : (
            <div className="space-y-2">
              {groups.map((g) => (
                <div
                  key={g.group}
                  className="rounded-lg border border-border/80 bg-background/50 px-3 py-2 text-xs"
                >
                  <div className="font-mono-num font-semibold text-foreground">{g.group}</div>
                  {g.comment && (
                    <p className="mt-1 text-[11px] text-muted-foreground">{g.comment}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
