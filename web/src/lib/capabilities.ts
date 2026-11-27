import type { Capabilities, FeatureFlags } from '@/lib/api/types'

export interface CapabilityBadgeItem {
  key: keyof FeatureFlags
  label: string
  minVersion: string
}

export const CAPABILITY_ITEMS: CapabilityBadgeItem[] = [
  { key: 'lxcOciImages', label: 'OCI 容器镜像', minVersion: '9.1+' },
  { key: 'haRules', label: 'HA Rules', minVersion: '9.0+' },
  { key: 'sdnFabrics', label: 'SDN Fabrics', minVersion: '9.0+' },
  { key: 'aptDeb822', label: 'APT deb822', minVersion: '9.0+' },
  { key: 'importEsxiOva', label: 'ESXi / OVA 导入', minVersion: '8.2+' },
  { key: 'resourceMappingDir', label: 'Virtiofs 目录映射', minVersion: '8.2+' },
  { key: 'sdnCore', label: 'SDN 核心', minVersion: '8.1+' },
  { key: 'notificationsV2', label: '通知路由 V2', minVersion: '8.1+' },
  { key: 'resourceMappingPciUsb', label: 'PCI / USB 映射', minVersion: '8.0+' },
  { key: 'remoteMigrate', label: '跨集群远程迁移', minVersion: '8.0+' },
]

export function hasFeature(
  caps: Capabilities | undefined | null,
  key: keyof FeatureFlags,
): boolean {
  return Boolean(caps?.features?.[key])
}
