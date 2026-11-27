export interface User {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'operator' | 'viewer' | string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface UserPreferences {
  userId: string
  theme: 'dark' | 'light' | 'system' | string
  density: 'compact' | 'comfortable' | string
  refreshSec: number
  locale: string
  sidebarMode: 'functional' | 'tree' | string
}

export interface TokenPair {
  accessToken: string
  expiresIn: number
  user: User
}

export interface FeatureFlags {
  resourceMappingPciUsb: boolean
  resourceMappingDir: boolean
  sdnCore: boolean
  sdnFabrics: boolean
  notificationsV2: boolean
  importEsxiOva: boolean
  haGroups: boolean
  haRules: boolean
  lxcOciImages: boolean
  aptDeb822: boolean
  aclStrictPve9: boolean
  qemuMonitorDeprecated: boolean
  remoteMigrate: boolean
}

export interface Capabilities {
  pveVersion: string
  release: string
  major: number
  minor: number
  patch: number
  isCluster: boolean
  features: FeatureFlags
}

export interface OverviewSummary {
  instancesTotal: number
  instancesOnline: number
  instancesOffline: number
  nodesTotal: number
  nodesOnline: number
  qemuRunning: number
  qemuStopped: number
  lxcRunning: number
  lxcStopped: number
  templates: number
  totalCpu: number
  usedCpu: number
  totalMem: number
  usedMem: number
  totalDisk: number
  usedDisk: number
  runningTasks: number
}

export interface UnifiedNode {
  urn: string
  instanceId: string
  instanceName: string
  instanceColor: string
  node: string
  status: string
  ip?: string
  cpu: number
  maxcpu: number
  mem: number
  maxmem: number
  disk: number
  maxdisk: number
  uptime: number
  cgroupMode?: number
}

export type GuestType = 'qemu' | 'lxc'

export interface UnifiedGuest {
  urn: string
  instanceId: string
  instanceName: string
  instanceColor: string
  node: string
  type: GuestType
  vmid: number
  name: string
  status: string
  template: boolean
  tags: string[]
  pool?: string
  cpu: number
  maxcpu: number
  mem: number
  maxmem: number
  disk: number
  maxdisk: number
  netin: number
  netout: number
  diskread: number
  diskwrite: number
  uptime: number
}

export interface UnifiedStorage {
  urn: string
  instanceId: string
  instanceName: string
  instanceColor: string
  node: string
  storage: string
  pluginType: string
  status: string
  shared: boolean
  content: string[]
  disk: number
  maxdisk: number
}

export interface UnifiedTask {
  instanceId: string
  instanceName: string
  instanceColor: string
  upid: string
  node: string
  type: string
  id: string
  user: string
  status: string
  running: boolean
  starttime: number
  endtime?: number
}

export interface InstanceSnapshot {
  id: string
  name: string
  groupName: string
  color: string
  enabled: boolean
  state: 'online' | 'offline' | 'disabled' | string
  pveVersion: string
  isCluster: boolean
  clusterName?: string
  quorate: boolean
  capabilities?: Capabilities
  error?: string
  latencyMs?: number
  nodes: UnifiedNode[]
  guestCount: number
  runningCount: number
}

export interface GlobalOverview {
  summary: OverviewSummary
  instances: InstanceSnapshot[]
  nodes: UnifiedNode[]
  guests: UnifiedGuest[]
  storages: UnifiedStorage[]
  tasks: UnifiedTask[]
  updatedAt: string
}

export interface SearchHit {
  kind: 'instance' | 'node' | 'qemu' | 'lxc' | 'storage' | string
  title: string
  subtitle: string
  urn: string
  instanceId: string
  instanceName: string
  node?: string
  guestType?: GuestType
  vmid?: number
  status?: string
  tags?: string[]
}

export interface PVEEndpoint {
  id: string
  instanceId?: string
  nodeName: string
  url: string
  priority: number
  certFingerprint: string
  isHealthy?: boolean
  lastError?: string
  lastCheckedAt?: string
}

export interface InstanceResponse {
  id: string
  name: string
  groupName: string
  color: string
  authMode: 'token' | 'ticket' | 'hybrid' | string
  tokenId: string
  ticketUsername: string
  tlsMode: 'strict' | 'tofu' | 'insecure' | string
  caCertPem?: string
  sshHost?: string
  enabled: boolean
  detectedVersion: string
  isCluster: boolean
  capabilitiesJson: string
  lastSeenAt: string
  createdAt: string
  updatedAt: string
  endpoints: PVEEndpoint[]
  hasTokenSecret: boolean
  hasTicketPassword: boolean
  capabilities?: Capabilities
}

export interface InstancePayload {
  name: string
  groupName: string
  color: string
  authMode: 'token' | 'ticket' | 'hybrid'
  tokenId: string
  tokenSecret: string
  ticketUsername: string
  ticketPassword: string
  tlsMode: 'strict' | 'tofu' | 'insecure'
  caCertPem: string
  sshHost?: string
  enabled: boolean
  endpoints: Array<{
    id?: string
    nodeName: string
    url: string
    priority: number
    certFingerprint: string
  }>
}

export interface CertMismatchInfo {
  endpoint: string
  expectedFingerprint: string
  observedFingerprint: string
}

export interface ProbeResult {
  ok: boolean
  version?: {
    version: string
    release: string
    repoid: string
  }
  capabilities?: Capabilities
  clusterName?: string
  nodes?: string[]
  fingerprints?: Record<string, string>
  certMismatch?: CertMismatchInfo
  error?: string
}

export interface NodeStatus {
  cpu: number
  wait: number
  uptime: number
  loadavg: string[]
  kversion: string
  pveversion: string
  cpuinfo: {
    cores: number
    cpus: number
    sockets: number
    model: string
    mhz: number
    vendor: string
  }
  memory: {
    total: number
    used: number
    free: number
    available: number
  }
  swap: {
    total: number
    used: number
    free: number
  }
  rootfs: {
    total: number
    used: number
    free: number
    avail: number
  }
  'current-kernel'?: {
    release: string
    machine: string
  }
  thermalstate?: string
  cpuFreq?: string
}

export interface SensorReading {
  label: string
  value: number
  unit: string
}

export interface NodeStatusResponse {
  status: NodeStatus
  sensors: SensorReading[]
}

export interface RRDPoint {
  time: number
  cpu?: number
  maxcpu?: number
  mem?: number
  memused?: number
  memtotal?: number
  maxmem?: number
  netin?: number
  netout?: number
  diskread?: number
  diskwrite?: number
  loadavg?: number
  iowait?: number
  rootused?: number
  roottotal?: number
}

export interface PendingItem {
  key: string
  value?: unknown
  pending?: unknown
  delete?: number
}

export interface SnapshotItem {
  name: string
  description?: string
  parent?: string
  snaptime?: number
  vmstate?: boolean
}

export interface GuestIPInfo {
  interface: string
  mac?: string
  ipv4?: string[]
  ipv6?: string[]
}

export interface GuestDetailResponse {
  instanceId: string
  node: string
  type: GuestType
  vmid: number
  current: Record<string, unknown>
  config: Record<string, unknown>
  pending: PendingItem[]
  snapshots: SnapshotItem[]
  ips: GuestIPInfo[]
}

export interface StorageContentItem {
  volid: string
  content: string
  format: string
  size: number
  used?: number
  vmid?: number
  ctime?: number
  notes?: string
  protected?: boolean
}

export interface NodeNetworkIface {
  iface: string
  type: string
  active: boolean
  autostart?: boolean
  exists?: boolean
  method?: string
  method6?: string
  address?: string
  netmask?: string
  cidr?: string
  gateway?: string
  cidr6?: string
  gateway6?: string
  comments?: string
  bridge_ports?: string
  bridge_vlan_aware?: boolean
  ovs_ports?: string
  ovs_bridge?: string
  ovs_bonds?: string
  ovs_tag?: number
  slaves?: string
  bond_mode?: string
  'vlan-raw-device'?: string
  'vlan-id'?: number
  mtu?: number
  pending?: string
}

export interface APLTemplate {
  template: string
  package: string
  version: string
  section: string
  os: string
  headline: string
  description: string
  architecture: string
  type: string
  source: string
  sha512sum?: string
}

export interface URLMetadata {
  filename: string
  mimetype: string
  size: number
}

export interface NodeServiceItem {
  service: string
  name: string
  desc: string
  state: string
  'active-state'?: string
  'unit-state'?: string
}

export interface SyslogLine {
  n: number
  t: string
}

export interface APTUpdatePkg {
  Package: string
  Title: string
  OldVersion: string
  Version: string
  Origin: string
  Priority: string
  Section: string
  Description: string
  NotifyStatus?: string
}

export interface APTRepoSummary {
  digest: string
  files: Array<{
    path: string
    'file-type'?: string
    repositories?: Array<{
      Types?: string[]
      URIs?: string[]
      Suites?: string[]
      Components?: string[]
      Enabled?: boolean
      Comment?: string
    }>
  }>
  errors?: Array<{ path?: string; error?: string }>
  infos?: Array<{ kind?: string; message?: string; path?: string }>
  'standard-repos'?: Array<{ handle: string; name: string; status?: boolean }>
}

export interface BackupJob {
  id: string
  schedule: string
  storage: string
  mode: string
  compress: string
  vmid?: string
  exclude?: string
  all?: boolean
  enabled: boolean
  node?: string
  'prune-backups'?: string
  'notes-template'?: string
  comment?: string
}

export interface NotBackedUpGuest {
  vmid: number
  name: string
  type: 'qemu' | 'lxc' | string
}

export interface TaskStatus {
  status: 'running' | 'stopped' | string
  exitstatus?: string
  upid: string
  node: string
  type: string
  id: string
  user: string
  starttime: number
  pid: number
}

export interface TaskLogLine {
  n: number
  t: string
}

export interface ConsoleSessionResponse {
  sessionId: string
  protocol: 'vnc' | 'xterm'
  wsPath: string
  vncPassword?: string
}

export interface AuditLog {
  id: string
  userId: string
  username: string
  clientIp: string
  instanceId: string
  resourceUrn: string
  action: string
  payloadSummary: string
  pveUpid: string
  status: 'success' | 'failed' | string
  errorMessage: string
  createdAt: string
}

export interface GuestBindingRef {
  vmid: number
  name: string
  type: 'qemu' | 'lxc' | string
  running: boolean
}

export interface GPUHardwareItem {
  id: string
  vendor: 'intel' | 'nvidia' | 'amd' | 'other' | string
  vendorName: string
  model: string
  class: string
  iommuGroup: number
  sriovCapable: boolean
  passthrough: boolean
  passthroughActive: boolean
  passthroughGuests: GuestBindingRef[]
  sharedLxcGuests: GuestBindingRef[]
  driver?: string
  telemetryAvailable: boolean
  telemetrySource?: string
  curFreqMhz?: number
  maxFreqMhz?: number
  renderBusyPct?: number
  videoBusyPct?: number
  blitterBusyPct?: number
  rc6Pct?: number
  powerW?: number
  tempC?: number
  vramUsedMb?: number
  vramTotalMb?: number
  fanPct?: number
  activeClients?: number
  missingPackage?: string
}

export interface DiskHardwareItem {
  devpath: string
  byIdLink?: string
  model: string
  serial: string
  type: 'nvme' | 'ssd' | 'hdd' | string
  size: number
  health: string
  used: string
  healthPct?: number
  healthGrade?: 'excellent' | 'good' | 'warning' | 'critical' | 'unknown' | string
  healthReasons?: string[]
  wearoutPct?: number
  usedLifePct?: number
  availableSparePct?: number
  availableSpareThresholdPct?: number
  criticalWarning?: number
  tempC?: number
  powerOnHours?: number
  powerCycles?: number
  unsafeShutdowns?: number
  dataRead?: string
  dataWritten?: string
  mediaErrors?: number
  reallocatedSectors?: number
  pendingSectors?: number
  rpm?: number
  passthrough: boolean
  passthroughActive: boolean
  passthroughType?: 'disk' | 'pci' | string
  passthroughGuests: GuestBindingRef[]
  smartText?: string
  telemetryStatus?: 'full' | 'partial' | 'missing_pkg' | string
  telemetryNote?: string
}

export interface CPUHardwareSummary {
  model: string
  vendor: string
  sockets: number
  cores: number
  threads: number
  usagePct: number
  iowaitPct: number
  curMhz: number
  maxMhz?: number
  governor?: string
  packageTempC?: number
  packagePowerW?: number
  loadavg: string[]
}

export interface MemoryHardwareSummary {
  used: number
  total: number
  available: number
  swapUsed: number
  swapTotal: number
}

export interface PackageDiagnostic {
  package: string
  command: string
  category: 'gpu' | 'disk' | 'sensor' | string
  status: 'installed' | 'missing' | 'unverified' | string
  reason: string
  installCmd: string
}

export interface NodeHardwareReport {
  instanceId: string
  node: string
  pveVersion: string
  kernelVersion: string
  uptime: number
  updatedAt: string
  sshTelemetryEnabled: boolean
  sshHost?: string
  sshError?: string
  cpu: CPUHardwareSummary
  memory: MemoryHardwareSummary
  gpus: GPUHardwareItem[]
  disks: DiskHardwareItem[]
  sensors: SensorReading[]
  packageChecks: PackageDiagnostic[]
  missingPackages: PackageDiagnostic[]
  installAllCmd?: string
}

// --- Phase 2D: Alerting & Multi-Channel Notifications ---

export type AlertSeverity = 'info' | 'warning' | 'critical'
export type AlertEventStatus = 'firing' | 'acknowledged' | 'resolved'
export type AlertChannelType = 'webhook' | 'feishu' | 'dingtalk' | 'wecom' | 'telegram' | 'bark'
export type AlertMetricKey =
  | 'instance_offline'
  | 'node_offline'
  | 'node_cpu'
  | 'node_mem'
  | 'storage_usage'
  | 'guest_cpu'
  | 'guest_mem'
  | 'disk_health'
  | 'disk_temp'
  | 'cpu_temp'
  | 'backup_uncovered'

export interface AlertSummary {
  activeCount: number
  firingCount: number
  ackedCount: number
  criticalCount: number
  warningCount: number
  infoCount: number
  rulesTotal: number
  rulesEnabled: number
  channelsTotal: number
  channelsEnabled: number
  lastEvaluatedAt: string
}

export interface AlertRule {
  id: string
  name: string
  enabled: boolean
  severity: AlertSeverity
  scopeInstanceId: string
  scopeNode: string
  metric: AlertMetricKey | string
  operator: 'gte' | 'lte' | 'eq'
  threshold: number
  durationSec: number
  cooldownMin: number
  channelIds: string[]
  silenceUntil: string
  createdAt: string
  updatedAt: string
}

export interface AlertChannel {
  id: string
  name: string
  type: AlertChannelType
  enabled: boolean
  configPreview: {
    urlPreview?: string
    botTokenPreview?: string
    chatId?: string
    threadId?: string
    deviceKeyPreview?: string
    hasSecret?: boolean
    atAll?: boolean
  }
  lastTestAt?: string
  lastTestStatus?: 'ok' | 'error' | ''
  lastTestError?: string
  createdAt: string
  updatedAt: string
}

export interface AlertEvent {
  id: string
  ruleId: string
  ruleName: string
  fingerprint: string
  severity: AlertSeverity
  status: AlertEventStatus
  instanceId: string
  instanceName: string
  resourceType: 'instance' | 'node' | 'storage' | 'guest' | 'disk' | 'backup' | string
  resourceId: string
  resourceName: string
  metric: string
  currentValue: number
  threshold: number
  unit: string
  message: string
  firedAt: string
  lastSeenAt: string
  resolvedAt?: string
  ackedBy?: string
  ackedAt?: string
  notifyCount: number
  lastNotifiedAt?: string
  lastNotifyError?: string
}

export interface AlertEvaluateResult {
  evaluatedRules: number
  activeAlerts: number
  newlyFired: number
  autoResolved: number
  evaluatedAt: string
}

// --- Phase 3: Network, Resource Pools, Batch Ops & 3-Tier Firewall ---

export interface NodeNetworkPayload {
  iface?: string
  type: string
  cidr?: string
  gateway?: string
  cidr6?: string
  gateway6?: string
  autostart?: boolean
  bridgePorts?: string
  bridgeVlanAware?: boolean
  ovsPorts?: string
  slaves?: string
  bondMode?: string
  vlanRawDevice?: string
  vlanId?: number
  mtu?: number
  comments?: string
  delete?: string[]
}

export interface PoolMember {
  id: string
  type: 'qemu' | 'lxc' | 'storage' | string
  node?: string
  vmid?: number
  name?: string
  storage?: string
  status?: string
  template?: boolean
}

export interface PoolSummary {
  poolid: string
  comment?: string
  members?: PoolMember[]
}

export interface BatchTagResponse {
  ok: boolean
  updated: number
  total: number
  results: Array<{
    instanceId: string
    node: string
    type: string
    vmid: number
    ok: boolean
    tags?: string
    error?: string
  }>
}

export type FirewallScope = 'cluster' | 'node' | 'guest'

export interface FirewallOptions {
  enable: boolean
  policy_in?: string
  policy_out?: string
  policy_forward?: string
  ebtables?: boolean
  dhcp?: boolean
  ndp?: boolean
  macfilter?: boolean
  ipfilter?: boolean
  log_level_in?: string
  log_level_out?: string
  digest?: string
}

export interface FirewallRule {
  pos: number
  type: 'in' | 'out' | 'forward' | 'group' | string
  action: string
  enable: boolean
  macro?: string
  proto?: string
  source?: string
  dest?: string
  sport?: string
  dport?: string
  iface?: string
  log?: string
  comment?: string
  digest?: string
}

export interface FirewallAlias {
  name: string
  cidr: string
  comment?: string
}

export interface FirewallIPSet {
  name: string
  comment?: string
}

export interface FirewallGroup {
  group: string
  comment?: string
}

export interface FirewallPayload {
  scope: FirewallScope
  options: FirewallOptions
  rules: FirewallRule[]
  aliases?: FirewallAlias[]
  ipsets?: FirewallIPSet[]
  groups?: FirewallGroup[]
  warnings?: Record<string, string>
}

export interface FirewallRulePayload {
  type?: string
  action?: string
  enable?: boolean
  macro?: string
  proto?: string
  source?: string
  dest?: string
  sport?: string
  dport?: string
  iface?: string
  log?: string
  comment?: string
  digest?: string
  delete?: string[]
}
