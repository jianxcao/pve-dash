import {
  ApiError,
  notifyAuthExpired,
  onAuthExpired,
  request,
  tryRefreshSession,
  tryRefreshSessionStatus,
  uploadStorageMultipart,
  type RequestOptions,
  type SessionRefreshStatus,
} from './http'
import type {
  WebAuthnAssertionCredentialJSON,
  WebAuthnRegistrationCredentialJSON,
} from '@/lib/webauthn'
import type {
  AlertChannel,
  AlertChannelType,
  AlertEvaluateResult,
  AlertEvent,
  AlertRule,
  AlertSeverity,
  AlertSummary,
  APLTemplate,
  APTRepoSummary,
  APTUpdatePkg,
  AuditLog,
  AuthLoginResponse,
  AuthSecurityStatus,
  BackupJob,
  BatchTagResponse,
  Capabilities,
  CephOverview,
  ChannelConfigPayload,
  ConfigExportResponse,
  ConfigImportPreview,
  ConsoleSessionResponse,
  EncryptedBackupBundle,
  EventSubscriptionItem,
  FirewallPayload,
  FirewallRulePayload,
  FirewallScope,
  GlobalOverview,
  GuestDetailResponse,
  GuestType,
  HAOverviewResponse,
  InstancePayload,
  InstanceResponse,
  ManagedUser,
  NodeCertificatesResponse,
  NodeDisksOverview,
  NodeHardwareReport,
  NodeNetworkIface,
  NodeNetworkPayload,
  NodeServiceItem,
  NodeStatusResponse,
  NotBackedUpGuest,
  PasskeyRegisterBeginResponse,
  PasskeyRegisterFinishResponse,
  PoolSummary,
  ProbeResult,
  RecoveryCodesResponse,
  ResourceMappingKind,
  ResourceMappingsResponse,
  RRDPoint,
  SearchHit,
  StorageConfigCreatePayload,
  StorageConfigItem,
  StorageConfigUpdatePayload,
  StorageContentItem,
  SyslogLine,
  SystemInfoResponse,
  TaskLogLine,
  TaskStatus,
  TokenPair,
  TotpEnableResponse,
  TotpSetupResponse,
  UnifiedGuest,
  UnifiedTask,
  URLMetadata,
  User,
  UserPreferences,
  UserWithSessions,
  WebAuthnLoginBeginResponse,
} from './types'

export {
  ApiError,
  notifyAuthExpired,
  onAuthExpired,
  tryRefreshSession,
  tryRefreshSessionStatus,
  type RequestOptions,
  type SessionRefreshStatus,
}

const enc = encodeURIComponent

export const api = {
  // --- System & Version ---
  systemInfo: () => request<SystemInfoResponse>('/api/v1/system/info'),

  // --- Auth, 2FA (Passkey / TOTP / Recovery) & Preferences ---
  authStatus: () =>
    request<{ initialized: boolean; readOnly?: boolean }>('/api/v1/auth/status', {
      skipRefresh: true,
    }),
  authSetup: (payload: { username: string; displayName: string; password: string }) =>
    request<TokenPair>('/api/v1/auth/setup', {
      method: 'POST',
      body: JSON.stringify(payload),
      skipRefresh: true,
    }),
  login: (payload: { username: string; password: string }) =>
    request<AuthLoginResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
      skipRefresh: true,
    }),
  authLogin: (payload: { username: string; password: string }) =>
    request<TokenPair & AuthLoginResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
      skipRefresh: true,
    }),
  verifyMfaTotp: (mfaToken: string, code: string) =>
    request<TokenPair>('/api/v1/auth/mfa/totp', {
      method: 'POST',
      body: JSON.stringify({ mfaToken, code }),
      skipRefresh: true,
    }),
  verifyMfaRecovery: (mfaToken: string, recoveryCode: string) =>
    request<TokenPair>('/api/v1/auth/mfa/recovery', {
      method: 'POST',
      body: JSON.stringify({ mfaToken, recoveryCode }),
      skipRefresh: true,
    }),
  beginMfaWebauthn: (mfaToken: string) =>
    request<WebAuthnLoginBeginResponse>('/api/v1/auth/mfa/webauthn/begin', {
      method: 'POST',
      body: JSON.stringify({ mfaToken }),
      skipRefresh: true,
    }),
  finishMfaWebauthn: (
    mfaToken: string,
    challengeToken: string,
    credential: WebAuthnAssertionCredentialJSON,
  ) =>
    request<TokenPair>('/api/v1/auth/mfa/webauthn/finish', {
      method: 'POST',
      body: JSON.stringify({ mfaToken, challengeToken, credential }),
      skipRefresh: true,
    }),
  getSecurityStatus: () => request<AuthSecurityStatus>('/api/v1/auth/security'),
  setupTotp: (currentPassword: string) =>
    request<TotpSetupResponse>('/api/v1/auth/mfa/totp/setup', {
      method: 'POST',
      body: JSON.stringify({ currentPassword }),
    }),
  enableTotp: (code: string) =>
    request<TotpEnableResponse>('/api/v1/auth/mfa/totp/enable', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  disableTotp: (currentPassword: string) =>
    request<{ ok: boolean }>('/api/v1/auth/mfa/totp/disable', {
      method: 'POST',
      body: JSON.stringify({ currentPassword }),
    }),
  beginPasskeyRegister: (currentPassword: string, name: string) =>
    request<PasskeyRegisterBeginResponse>('/api/v1/auth/mfa/passkeys/register/begin', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, name }),
    }),
  finishPasskeyRegister: (
    challengeToken: string,
    name: string,
    credential: WebAuthnRegistrationCredentialJSON,
  ) =>
    request<PasskeyRegisterFinishResponse>('/api/v1/auth/mfa/passkeys/register/finish', {
      method: 'POST',
      body: JSON.stringify({ challengeToken, name, credential }),
    }),
  deletePasskey: (credentialId: string, currentPassword: string) =>
    request<{ ok: boolean }>(`/api/v1/auth/mfa/passkeys/${enc(credentialId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ currentPassword }),
    }),
  regenerateRecoveryCodes: (currentPassword: string) =>
    request<RecoveryCodesResponse>('/api/v1/auth/mfa/recovery-codes/regenerate', {
      method: 'POST',
      body: JSON.stringify({ currentPassword }),
    }),
  authLogout: () => request<{ ok: boolean }>('/api/v1/auth/logout', { method: 'POST', skipRefresh: true }),
  authMe: () => request<{ user: User; preferences: UserPreferences }>('/api/v1/auth/me'),
  getPreferences: () => request<UserPreferences>('/api/v1/preferences'),
  savePreferences: (prefs: Partial<UserPreferences>) =>
    request<UserPreferences>('/api/v1/preferences', {
      method: 'PUT',
      body: JSON.stringify(prefs),
    }),

  // --- Aggregated ---
  getOverview: (refresh = false) =>
    request<GlobalOverview>(`/api/v1/overview${refresh ? '?refresh=1' : ''}`),
  getGuests: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params).toString()
    return request<{ items: UnifiedGuest[]; updatedAt: string }>(`/api/v1/guests${q ? `?${q}` : ''}`)
  },
  search: (q: string) => request<{ items: SearchHit[] }>(`/api/v1/search?q=${enc(q)}`),
  getTasks: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params).toString()
    return request<{ items: UnifiedTask[]; updatedAt: string }>(`/api/v1/tasks${q ? `?${q}` : ''}`)
  },
  getAuditLogs: () => request<{ items: AuditLog[] }>('/api/v1/audit'),

  // --- Instances ---
  listInstances: () => request<{ items: InstanceResponse[] }>('/api/v1/instances'),
  getInstance: (id: string) => request<InstanceResponse>(`/api/v1/instances/${enc(id)}`),
  createInstance: (payload: InstancePayload) =>
    request<InstanceResponse>('/api/v1/instances', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateInstance: (id: string, payload: InstancePayload) =>
    request<InstanceResponse>(`/api/v1/instances/${enc(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteInstance: (id: string) =>
    request<{ ok: boolean }>(`/api/v1/instances/${enc(id)}`, { method: 'DELETE' }),
  probeAdhoc: (payload: InstancePayload & { instanceId?: string }) =>
    request<ProbeResult>('/api/v1/instances/probe', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  probeInstance: (id: string) =>
    request<ProbeResult>(`/api/v1/instances/${enc(id)}/probe`, { method: 'POST' }),
  getCapabilities: (id: string) =>
    request<Capabilities>(`/api/v1/instances/${enc(id)}/capabilities`),

  // --- Nodes ---
  getNodeStatus: (instanceId: string, node: string) =>
    request<NodeStatusResponse>(`/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/status`),
  getNodeHardware: (instanceId: string, node: string, refresh = false) =>
    request<NodeHardwareReport>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/hardware${refresh ? '?refresh=1' : ''}`,
    ),
  getNodeRRD: (instanceId: string, node: string, timeframe = 'hour', cf = 'AVERAGE') =>
    request<{ items: RRDPoint[] }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/rrd?timeframe=${enc(timeframe)}&cf=${enc(cf)}`,
    ),
  nodePower: (instanceId: string, node: string, command: 'reboot' | 'shutdown') =>
    request<{ ok: boolean }>(`/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/power`, {
      method: 'POST',
      headers: { 'X-Confirm-Target': node },
      body: JSON.stringify({ command }),
    }),
  createNodeConsoleSession: (
    instanceId: string,
    node: string,
    body: { protocol?: 'xterm' | 'vnc'; fallbackUsername?: string; fallbackPassword?: string },
  ) =>
    request<ConsoleSessionResponse>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/console/session`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  // --- Storage & Creation (Phase 2B) ---
  getNextID: (instanceId: string) =>
    request<{ vmid: number }>(`/api/v1/instances/${enc(instanceId)}/nextid`),
  getNodeNetworks: (instanceId: string, node: string) =>
    request<{ items: NodeNetworkIface[]; changes?: string; hasPending?: boolean }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/networks`,
    ),
  getAPLTemplates: (instanceId: string, node: string) =>
    request<{ items: APLTemplate[] }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/aplinfo`,
    ),
  downloadAPLTemplate: (instanceId: string, node: string, storage: string, template: string) =>
    request<{ ok: boolean; upid: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/aplinfo`,
      { method: 'POST', body: JSON.stringify({ storage, template }) },
    ),
  queryURLMetadata: (instanceId: string, node: string, url: string, verifyCerts = true) =>
    request<URLMetadata>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/query-url-metadata`,
      { method: 'POST', body: JSON.stringify({ url, verifyCerts }) },
    ),
  downloadURLToStorage: (
    instanceId: string,
    node: string,
    storage: string,
    payload: {
      url: string
      filename: string
      content: 'iso' | 'vztmpl'
      checksum?: string
      checksumAlgorithm?: string
      verifyCerts?: boolean
    },
  ) =>
    request<{ ok: boolean; upid: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/storage/${enc(storage)}/download-url`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  pullOCIToStorage: (
    instanceId: string,
    node: string,
    storage: string,
    payload: { reference: string; filename?: string },
  ) =>
    request<{ ok: boolean; upid: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/storage/${enc(storage)}/oci-pull`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  deleteStorageVolume: (instanceId: string, node: string, storage: string, volid: string) =>
    request<{ ok: boolean; upid?: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/storage/${enc(storage)}/volume?volid=${enc(volid)}`,
      { method: 'DELETE' },
    ),
  uploadStorageFile: (
    instanceId: string,
    node: string,
    storage: string,
    content: 'iso' | 'vztmpl' | 'import' | 'snippets',
    file: File,
    onProgress?: (pct: number, loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; filename: string; upid?: string }> =>
    uploadStorageMultipart(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/storage/${enc(storage)}/upload`,
      content,
      file,
      onProgress,
      signal,
    ),
  createQemuVM: (
    instanceId: string,
    node: string,
    payload: Record<string, unknown> & { secureBoot?: boolean; tpm?: boolean },
  ) =>
    request<{ ok: boolean; vmid: number; upid: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/qemu`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  createLXCContainer: (instanceId: string, node: string, payload: Record<string, unknown>) =>
    request<{ ok: boolean; vmid: number; upid: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/lxc`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  cloneGuest: (
    instanceId: string,
    node: string,
    type: GuestType,
    vmid: number,
    payload: {
      newid: number
      name?: string
      targetNode?: string
      storage?: string
      full?: boolean
      description?: string
    },
  ) =>
    request<{ ok: boolean; newid: number; upid: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/${type}/${vmid}/clone`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  getStorageContent: (instanceId: string, node: string, storage: string, content?: string) => {
    const q = content ? `?content=${enc(content)}` : ''
    return request<{ items: StorageContentItem[] }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/storage/${enc(storage)}/content${q}`,
    )
  },

  // --- Tasks ---
  getTaskStatus: (instanceId: string, node: string, upid: string) =>
    request<TaskStatus>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/tasks/${enc(upid)}/status`,
    ),
  getTaskLog: (instanceId: string, node: string, upid: string, start = 0, limit = 500) =>
    request<{ items: TaskLogLine[] }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/tasks/${enc(upid)}/log?start=${start}&limit=${limit}`,
    ),
  stopTask: (instanceId: string, node: string, upid: string) =>
    request<{ ok: boolean }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/tasks/${enc(upid)}`,
      { method: 'DELETE' },
    ),

  // --- Unified QEMU & LXC ---
  getGuestDetail: (instanceId: string, node: string, type: GuestType, vmid: number) =>
    request<GuestDetailResponse>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/${type}/${vmid}/detail`,
    ),
  getGuestRRD: (
    instanceId: string,
    node: string,
    type: GuestType,
    vmid: number,
    timeframe = 'hour',
    cf = 'AVERAGE',
  ) =>
    request<{ items: RRDPoint[] }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/${type}/${vmid}/rrd?timeframe=${enc(timeframe)}&cf=${enc(cf)}`,
    ),
  guestPower: (
    instanceId: string,
    node: string,
    type: GuestType,
    vmid: number,
    action: 'start' | 'shutdown' | 'stop' | 'reboot' | 'suspend' | 'resume' | 'reset',
  ) =>
    request<{ upid: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/${type}/${vmid}/power/${action}`,
      { method: 'POST' },
    ),
  deleteGuest: (
    instanceId: string,
    node: string,
    type: GuestType,
    vmid: number,
    opts?: { purge?: boolean; destroyUnreferencedDisks?: boolean },
  ) => {
    const q = new URLSearchParams()
    if (opts?.purge) q.set('purge', '1')
    if (opts?.destroyUnreferencedDisks) q.set('destroyUnreferencedDisks', '1')
    const qs = q.toString()
    return request<{ upid: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/${type}/${vmid}${qs ? `?${qs}` : ''}`,
      {
        method: 'DELETE',
        headers: { 'X-Confirm-Target': String(vmid) },
      },
    )
  },
  createGuestConsoleSession: (
    instanceId: string,
    node: string,
    type: GuestType,
    vmid: number,
    body: { protocol?: 'vnc' | 'xterm'; fallbackUsername?: string; fallbackPassword?: string },
  ) =>
    request<ConsoleSessionResponse>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/${type}/${vmid}/console/session`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  createSnapshot: (
    instanceId: string,
    node: string,
    type: GuestType,
    vmid: number,
    payload: { snapname: string; description?: string; vmstate?: boolean },
  ) =>
    request<{ upid: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/${type}/${vmid}/snapshots`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  rollbackSnapshot: (instanceId: string, node: string, type: GuestType, vmid: number, snap: string) =>
    request<{ upid: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/${type}/${vmid}/snapshots/${enc(snap)}/rollback`,
      { method: 'POST' },
    ),
  deleteSnapshot: (instanceId: string, node: string, type: GuestType, vmid: number, snap: string) =>
    request<{ upid: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/${type}/${vmid}/snapshots/${enc(snap)}`,
      { method: 'DELETE' },
    ),
  sendQemuKey: (instanceId: string, node: string, vmid: number, key: string) =>
    request<{ ok: boolean }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/qemu/${vmid}/sendkey`,
      { method: 'POST', body: JSON.stringify({ key }) },
    ),
  requestSpice: (instanceId: string, node: string, type: GuestType, vmid: number) =>
    request<Record<string, unknown>>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/${type}/${vmid}/spice`,
      { method: 'POST' },
    ),
  updateGuestConfig: (
    instanceId: string,
    node: string,
    type: GuestType,
    vmid: number,
    payload: { values?: Record<string, string>; delete?: string[]; revert?: string[] },
  ) =>
    request<{ ok: boolean }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/${type}/${vmid}/config`,
      { method: 'PUT', body: JSON.stringify(payload) },
    ),
  resizeGuestDisk: (
    instanceId: string,
    node: string,
    type: GuestType,
    vmid: number,
    disk: string,
    size: string,
  ) =>
    request<{ ok: boolean; upid?: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/${type}/${vmid}/resize`,
      { method: 'PUT', body: JSON.stringify({ disk, size }) },
    ),
  regenerateCloudInit: (instanceId: string, node: string, vmid: number) =>
    request<{ ok: boolean }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/qemu/${vmid}/cloudinit`,
      { method: 'PUT' },
    ),
  getGuestAgentInfo: (instanceId: string, node: string, vmid: number) =>
    request<{
      available: boolean
      osInfo?: Record<string, unknown>
      fsInfo: Array<Record<string, unknown>>
    }>(`/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/qemu/${vmid}/agent`),

  // --- Node Ops & Backups (Phase 2C) ---
  getNodeServices: (instanceId: string, node: string) =>
    request<{ items: NodeServiceItem[] }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/services`,
    ),
  controlNodeService: (
    instanceId: string,
    node: string,
    service: string,
    action: 'start' | 'stop' | 'restart' | 'reload',
  ) =>
    request<{ ok: boolean; upid: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/services/${enc(service)}/${action}`,
      { method: 'POST' },
    ),
  getNodeSyslog: (
    instanceId: string,
    node: string,
    opts?: { limit?: number; service?: string; since?: string; until?: string; hours?: number },
  ) => {
    const q = new URLSearchParams()
    if (opts?.limit) q.set('limit', String(opts.limit))
    if (opts?.service) q.set('service', opts.service)
    if (opts?.since) q.set('since', opts.since)
    if (opts?.until) q.set('until', opts.until)
    if (opts?.hours) q.set('hours', String(opts.hours))
    const qs = q.toString()
    return request<{ items: SyslogLine[] }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/syslog${qs ? `?${qs}` : ''}`,
    )
  },
  getNodeAPTUpdates: (instanceId: string, node: string) =>
    request<{ items: APTUpdatePkg[] }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/apt/updates`,
    ),
  refreshNodeAPT: (instanceId: string, node: string) =>
    request<{ ok: boolean; upid: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/apt/refresh`,
      { method: 'POST' },
    ),
  getNodeAPTRepositories: (instanceId: string, node: string) =>
    request<APTRepoSummary>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/apt/repositories`,
    ),
  runVZDump: (
    instanceId: string,
    node: string,
    payload: {
      vmid: number
      storage: string
      mode: 'snapshot' | 'suspend' | 'stop'
      compress: 'zstd' | 'lzo' | 'gzip' | '0'
      notesTemplate?: string
      protected?: boolean
    },
  ) =>
    request<{ ok: boolean; upid: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/vzdump`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  updateVolumeConfig: (
    instanceId: string,
    node: string,
    storage: string,
    volid: string,
    payload: { notes?: string; protected?: boolean },
  ) =>
    request<{ ok: boolean }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/storage/${enc(storage)}/volume/config?volid=${enc(volid)}`,
      { method: 'PUT', body: JSON.stringify(payload) },
    ),
  restoreBackup: (
    instanceId: string,
    node: string,
    payload: {
      type: GuestType
      vmid: number
      archive: string
      storage?: string
      force?: boolean
      start?: boolean
    },
  ) =>
    request<{ ok: boolean; upid: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/restore`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  listBackupJobs: (instanceId: string) =>
    request<{ items: BackupJob[] }>(`/api/v1/instances/${enc(instanceId)}/backups/jobs`),
  createBackupJob: (
    instanceId: string,
    payload: {
      schedule: string
      storage: string
      mode: string
      compress: string
      all: boolean
      vmid?: string
      node?: string
      enabled?: boolean
      pruneBackups?: string
      comment?: string
    },
  ) =>
    request<{ ok: boolean }>(`/api/v1/instances/${enc(instanceId)}/backups/jobs`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateBackupJob: (
    instanceId: string,
    jobId: string,
    payload: {
      enabled?: boolean
      schedule?: string
      storage?: string
      mode?: string
      compress?: string
      all?: boolean
      vmid?: string
      node?: string
      exclude?: string
      pruneBackups?: string
      comment?: string
      delete?: string[]
    },
  ) =>
    request<{ ok: boolean }>(`/api/v1/instances/${enc(instanceId)}/backups/jobs/${enc(jobId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteBackupJob: (instanceId: string, jobId: string) =>
    request<{ ok: boolean }>(`/api/v1/instances/${enc(instanceId)}/backups/jobs/${enc(jobId)}`, {
      method: 'DELETE',
    }),
  getNotBackedUpGuests: (instanceId: string) =>
    request<{ items: NotBackedUpGuest[] }>(
      `/api/v1/instances/${enc(instanceId)}/backups/not-backed-up`,
    ),

  // --- Alerting Engine & Channels (Phase 2D) ---
  getAlertSummary: () => request<AlertSummary>('/api/v1/alerts/summary'),
  listAlertEvents: (opts?: { status?: string; severity?: string; limit?: number }) => {
    const q = new URLSearchParams()
    if (opts?.status) q.set('status', opts.status)
    if (opts?.severity) q.set('severity', opts.severity)
    if (opts?.limit) q.set('limit', String(opts.limit))
    const qs = q.toString()
    return request<{ items: AlertEvent[] }>(`/api/v1/alerts/events${qs ? `?${qs}` : ''}`)
  },
  ackAlertEvent: (eventId: string) =>
    request<{ ok: boolean }>(`/api/v1/alerts/events/${enc(eventId)}/ack`, { method: 'POST' }),
  resolveAlertEvent: (eventId: string) =>
    request<{ ok: boolean }>(`/api/v1/alerts/events/${enc(eventId)}/resolve`, { method: 'POST' }),
  ackAllAlertEvents: () =>
    request<{ ok: boolean; acknowledged: number }>('/api/v1/alerts/events/ack-all', {
      method: 'POST',
    }),
  evaluateAlertsNow: (force = false) =>
    request<AlertEvaluateResult>(`/api/v1/alerts/evaluate${force ? '?force=1' : ''}`, {
      method: 'POST',
    }),
  listAlertRules: () => request<{ items: AlertRule[] }>('/api/v1/alerts/rules'),
  createAlertRule: (payload: {
    name: string
    enabled?: boolean
    severity: AlertSeverity
    scopeInstanceId?: string
    scopeNode?: string
    metric: string
    operator: 'gte' | 'lte' | 'eq'
    threshold: number
    durationSec?: number
    cooldownMin?: number
    notifyOnResolve?: boolean
    channelIds?: string[]
  }) =>
    request<AlertRule>('/api/v1/alerts/rules', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateAlertRule: (
    ruleId: string,
    payload: Partial<{
      name: string
      enabled: boolean
      severity: AlertSeverity
      scopeInstanceId: string
      scopeNode: string
      metric: string
      operator: 'gte' | 'lte' | 'eq'
      threshold: number
      durationSec: number
      cooldownMin: number
      notifyOnResolve: boolean
      channelIds: string[]
      silenceUntil: string
    }>,
  ) =>
    request<AlertRule>(`/api/v1/alerts/rules/${enc(ruleId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteAlertRule: (ruleId: string) =>
    request<{ ok: boolean }>(`/api/v1/alerts/rules/${enc(ruleId)}`, { method: 'DELETE' }),
  listAlertChannels: () => request<{ items: AlertChannel[] }>('/api/v1/alerts/channels'),
  createAlertChannel: (payload: {
    name: string
    type: AlertChannelType
    enabled?: boolean
    config: ChannelConfigPayload
  }) =>
    request<AlertChannel>('/api/v1/alerts/channels', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateAlertChannel: (
    channelId: string,
    payload: {
      name?: string
      type?: AlertChannelType
      enabled?: boolean
      config?: ChannelConfigPayload
    },
  ) =>
    request<AlertChannel>(`/api/v1/alerts/channels/${enc(channelId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteAlertChannel: (channelId: string) =>
    request<{ ok: boolean }>(`/api/v1/alerts/channels/${enc(channelId)}`, { method: 'DELETE' }),
  testAlertChannel: (channelId: string) =>
    request<{ ok: boolean; error?: string }>(`/api/v1/alerts/channels/${enc(channelId)}/test`, {
      method: 'POST',
    }),
  listAlertSubscriptions: () =>
    request<{ items: EventSubscriptionItem[] }>('/api/v1/alerts/subscriptions'),
  updateAlertSubscriptions: (items: EventSubscriptionItem[]) =>
    request<{ ok?: boolean; items: EventSubscriptionItem[] }>('/api/v1/alerts/subscriptions', {
      method: 'PUT',
      body: JSON.stringify({ items }),
    }),

  // --- Phase 3: Network Management, Resource Pools, Guest Migrate, Batch Tags & 3-Tier Firewall ---
  createNodeNetwork: (instanceId: string, node: string, payload: NodeNetworkPayload) =>
    request<{ ok: boolean }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/networks`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  updateNodeNetwork: (instanceId: string, node: string, iface: string, payload: NodeNetworkPayload) =>
    request<{ ok: boolean }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/networks/${enc(iface)}`,
      { method: 'PUT', body: JSON.stringify(payload) },
    ),
  deleteNodeNetwork: (instanceId: string, node: string, iface: string) =>
    request<{ ok: boolean }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/networks/${enc(iface)}`,
      { method: 'DELETE', headers: { 'X-Confirm-Target': iface } },
    ),
  applyNodeNetwork: (instanceId: string, node: string) =>
    request<{ ok: boolean; upid?: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/networks/apply`,
      { method: 'PUT', headers: { 'X-Confirm-Target': node } },
    ),
  revertNodeNetwork: (instanceId: string, node: string) =>
    request<{ ok: boolean }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/networks/revert`,
      { method: 'DELETE' },
    ),

  listPools: (instanceId: string) =>
    request<{ items: PoolSummary[]; warnings?: Record<string, string> }>(
      `/api/v1/instances/${enc(instanceId)}/pools`,
    ),
  createPool: (instanceId: string, payload: { poolid: string; comment?: string }) =>
    request<{ ok: boolean }>(`/api/v1/instances/${enc(instanceId)}/pools`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updatePool: (
    instanceId: string,
    poolId: string,
    payload: {
      comment?: string
      vms?: string
      storage?: string
      delete?: boolean
      allowMove?: boolean
    },
  ) =>
    request<{ ok: boolean }>(`/api/v1/instances/${enc(instanceId)}/pools/${enc(poolId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deletePool: (instanceId: string, poolId: string) =>
    request<{ ok: boolean }>(`/api/v1/instances/${enc(instanceId)}/pools/${enc(poolId)}`, {
      method: 'DELETE',
      headers: { 'X-Confirm-Target': poolId },
    }),

  migrateGuest: (
    instanceId: string,
    node: string,
    type: GuestType,
    vmid: number,
    payload: { targetNode: string; online?: boolean; restart?: boolean; withLocalDisks?: boolean },
  ) =>
    request<{ ok: boolean; upid: string }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/${type}/${vmid}/migrate`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  batchGuestTags: (payload: {
    mode: 'add' | 'remove' | 'replace'
    tags: string[]
    targets: Array<{ instanceId: string; node: string; type: GuestType; vmid: number }>
  }) =>
    request<BatchTagResponse>('/api/v1/guests/batch/tags', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getFirewall: (
    scope: FirewallScope,
    instanceId: string,
    opts?: { node?: string; guestType?: GuestType; vmid?: number },
  ) => {
    const base =
      scope === 'cluster'
        ? `/api/v1/instances/${enc(instanceId)}/firewall`
        : scope === 'node'
          ? `/api/v1/instances/${enc(instanceId)}/nodes/${enc(opts?.node || '')}/firewall`
          : `/api/v1/instances/${enc(instanceId)}/nodes/${enc(opts?.node || '')}/${opts?.guestType || 'qemu'}/${opts?.vmid || 0}/firewall`
    return request<FirewallPayload>(base)
  },
  updateFirewallOptions: (
    scope: FirewallScope,
    instanceId: string,
    payload: {
      enable?: boolean
      policyIn?: string
      policyOut?: string
      policyForward?: string
      ebtables?: boolean
      dhcp?: boolean
      ndp?: boolean
      macfilter?: boolean
      ipfilter?: boolean
      logLevelIn?: string
      logLevelOut?: string
      digest?: string
    },
    opts?: { node?: string; guestType?: GuestType; vmid?: number },
  ) => {
    const base =
      scope === 'cluster'
        ? `/api/v1/instances/${enc(instanceId)}/firewall`
        : scope === 'node'
          ? `/api/v1/instances/${enc(instanceId)}/nodes/${enc(opts?.node || '')}/firewall`
          : `/api/v1/instances/${enc(instanceId)}/nodes/${enc(opts?.node || '')}/${opts?.guestType || 'qemu'}/${opts?.vmid || 0}/firewall`
    return request<{ ok: boolean }>(`${base}/options`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
  },
  createFirewallRule: (
    scope: FirewallScope,
    instanceId: string,
    payload: FirewallRulePayload,
    opts?: { node?: string; guestType?: GuestType; vmid?: number },
  ) => {
    const base =
      scope === 'cluster'
        ? `/api/v1/instances/${enc(instanceId)}/firewall`
        : scope === 'node'
          ? `/api/v1/instances/${enc(instanceId)}/nodes/${enc(opts?.node || '')}/firewall`
          : `/api/v1/instances/${enc(instanceId)}/nodes/${enc(opts?.node || '')}/${opts?.guestType || 'qemu'}/${opts?.vmid || 0}/firewall`
    return request<{ ok: boolean }>(`${base}/rules`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
  updateFirewallRule: (
    scope: FirewallScope,
    instanceId: string,
    pos: number,
    payload: FirewallRulePayload,
    opts?: { node?: string; guestType?: GuestType; vmid?: number },
  ) => {
    const base =
      scope === 'cluster'
        ? `/api/v1/instances/${enc(instanceId)}/firewall`
        : scope === 'node'
          ? `/api/v1/instances/${enc(instanceId)}/nodes/${enc(opts?.node || '')}/firewall`
          : `/api/v1/instances/${enc(instanceId)}/nodes/${enc(opts?.node || '')}/${opts?.guestType || 'qemu'}/${opts?.vmid || 0}/firewall`
    return request<{ ok: boolean }>(`${base}/rules/${pos}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
  },
  deleteFirewallRule: (
    scope: FirewallScope,
    instanceId: string,
    pos: number,
    opts?: { node?: string; guestType?: GuestType; vmid?: number; digest?: string },
  ) => {
    const base =
      scope === 'cluster'
        ? `/api/v1/instances/${enc(instanceId)}/firewall`
        : scope === 'node'
          ? `/api/v1/instances/${enc(instanceId)}/nodes/${enc(opts?.node || '')}/firewall`
          : `/api/v1/instances/${enc(instanceId)}/nodes/${enc(opts?.node || '')}/${opts?.guestType || 'qemu'}/${opts?.vmid || 0}/firewall`
    const qs = opts?.digest ? `?digest=${enc(opts.digest)}` : ''
    return request<{ ok: boolean }>(`${base}/rules/${pos}${qs}`, {
      method: 'DELETE',
    })
  },

  // --- Phase 4A: Node Disk Stacks (ZFS / LVM / Directory), Ceph & Storage Config CRUD ---
  getNodeDisksOverview: (instanceId: string, node: string) =>
    request<NodeDisksOverview>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/disks/overview`,
    ),
  getNodeCeph: (instanceId: string, node: string) =>
    request<CephOverview>(`/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/ceph`),
  listStorageConfigs: (instanceId: string) =>
    request<{ items: StorageConfigItem[] }>(
      `/api/v1/instances/${enc(instanceId)}/storage-configs`,
    ),
  createStorageConfig: (instanceId: string, payload: StorageConfigCreatePayload) =>
    request<{ ok: boolean }>(`/api/v1/instances/${enc(instanceId)}/storage-configs`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateStorageConfig: (
    instanceId: string,
    storageId: string,
    payload: StorageConfigUpdatePayload,
  ) =>
    request<{ ok: boolean }>(
      `/api/v1/instances/${enc(instanceId)}/storage-configs/${enc(storageId)}`,
      { method: 'PUT', body: JSON.stringify(payload) },
    ),
  deleteStorageConfig: (instanceId: string, storageId: string) =>
    request<{ ok: boolean }>(
      `/api/v1/instances/${enc(instanceId)}/storage-configs/${enc(storageId)}`,
      { method: 'DELETE', headers: { 'X-Confirm-Target': storageId } },
    ),

  // --- Phase 4B: HA High Availability, Node Certificates/ACME & Hardware Resource Mappings ---
  getHA: (instanceId: string) =>
    request<HAOverviewResponse>(`/api/v1/instances/${enc(instanceId)}/ha`),
  createHAResource: (
    instanceId: string,
    payload: {
      sid: string
      state?: string
      group?: string
      maxRestart?: number
      maxRelocate?: number
      comment?: string
    },
  ) =>
    request<{ ok: boolean }>(`/api/v1/instances/${enc(instanceId)}/ha/resources`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateHAResource: (
    instanceId: string,
    sid: string,
    payload: {
      state?: string
      group?: string
      maxRestart?: number
      maxRelocate?: number
      comment?: string
      digest?: string
      delete?: string[]
    },
  ) =>
    request<{ ok: boolean }>(`/api/v1/instances/${enc(instanceId)}/ha/resources/${enc(sid)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteHAResource: (instanceId: string, sid: string) =>
    request<{ ok: boolean }>(`/api/v1/instances/${enc(instanceId)}/ha/resources/${enc(sid)}`, {
      method: 'DELETE',
      headers: { 'X-Confirm-Target': sid },
    }),

  getNodeCertificates: (instanceId: string, node: string) =>
    request<NodeCertificatesResponse>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/certificates`,
    ),
  renewNodeACME: (
    instanceId: string,
    node: string,
    force = false,
    mode: 'auto' | 'order' | 'renew' = 'auto',
  ) =>
    request<{ ok: boolean; upid: string; action?: 'order' | 'renew' }>(
      `/api/v1/instances/${enc(instanceId)}/nodes/${enc(node)}/certificates/acme/renew`,
      {
        method: 'POST',
        headers: { 'X-Confirm-Target': node },
        body: JSON.stringify({ force, mode }),
      },
    ),

  listResourceMappings: (instanceId: string) =>
    request<ResourceMappingsResponse>(`/api/v1/instances/${enc(instanceId)}/mappings`),
  createResourceMapping: (
    instanceId: string,
    kind: ResourceMappingKind,
    payload: {
      id: string
      description?: string
      map: string[]
      mdev?: boolean
      liveMigrationCapable?: boolean
    },
  ) =>
    request<{ ok: boolean }>(`/api/v1/instances/${enc(instanceId)}/mappings/${kind}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteResourceMapping: (instanceId: string, kind: ResourceMappingKind, mappingId: string) =>
    request<{ ok: boolean }>(
      `/api/v1/instances/${enc(instanceId)}/mappings/${kind}/${enc(mappingId)}`,
      { method: 'DELETE', headers: { 'X-Confirm-Target': mappingId } },
    ),

  // --- Phase 4C: Multi-User RBAC, Password Change & Encrypted Config Backup ---
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean; accessToken: string; expiresIn: number }>('/api/v1/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  listUsers: () => request<{ items: ManagedUser[] }>('/api/v1/users'),
  resetUserMfa: (userId: string) =>
    request<{ ok: boolean }>(`/api/v1/users/${enc(userId)}/mfa`, {
      method: 'DELETE',
    }),
  createUser: (payload: {
    username: string
    displayName: string
    password: string
    role: 'admin' | 'operator' | 'viewer'
    isActive?: boolean
  }) =>
    request<User>('/api/v1/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateUser: (
    userId: string,
    payload: {
      displayName?: string
      role?: 'admin' | 'operator' | 'viewer'
      isActive?: boolean
      password?: string
    },
  ) =>
    request<User>(`/api/v1/users/${enc(userId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteUser: (userId: string, username: string) =>
    request<{ ok: boolean }>(`/api/v1/users/${enc(userId)}`, {
      method: 'DELETE',
      headers: { 'X-Confirm-Target': username },
    }),
  revokeUserSessions: (userId: string) =>
    request<{ ok: boolean; revokedSessions: number }>(
      `/api/v1/users/${enc(userId)}/revoke-sessions`,
      { method: 'POST' },
    ),
  exportConfig: (passphrase: string) =>
    request<ConfigExportResponse>('/api/v1/config/export', {
      method: 'POST',
      body: JSON.stringify({ passphrase }),
    }),
  importConfig: (bundle: EncryptedBackupBundle, passphrase: string, dryRun: boolean) =>
    request<ConfigImportPreview>('/api/v1/config/import', {
      method: 'POST',
      body: JSON.stringify({ bundle, passphrase, dryRun }),
    }),

  // --- Admin Escape Hatch Raw Proxy ---
  rawGet: (instanceId: string, rawPath: string) => {
    const clean = rawPath.replace(/^\/+/, '')
    return request<unknown>(`/api/v1/instances/${enc(instanceId)}/raw/${clean}`)
  },
}
