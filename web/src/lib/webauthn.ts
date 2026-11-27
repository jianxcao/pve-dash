/**
 * Browser WebAuthn (Passkey / FIDO2) helpers with zero external dependencies.
 * Supports both raw W3C PublicKeyCredential options and `{ publicKey: ... }` envelopes
 * (compatible with `github.com/go-webauthn/webauthn` and custom Go WebAuthn handlers).
 */

export interface WebAuthnSupportInfo {
  supported: boolean
  browserApiAvailable: boolean
  isSecureContext: boolean
  isIpAddress: boolean
  hostname: string
  origin: string
  reason?: string
}

export interface WebAuthnRegistrationCredentialJSON {
  id: string
  rawId: string
  type: string
  authenticatorAttachment?: string
  clientExtensionResults: AuthenticationExtensionsClientOutputs
  response: {
    attestationObject: string
    clientDataJSON: string
    transports?: string[]
  }
}

export interface WebAuthnAssertionCredentialJSON {
  id: string
  rawId: string
  type: string
  authenticatorAttachment?: string
  clientExtensionResults: AuthenticationExtensionsClientOutputs
  response: {
    authenticatorData: string
    clientDataJSON: string
    signature: string
    userHandle?: string
  }
}

export function base64UrlToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const normalized = base64Url.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (normalized.length % 4)) % 4
  const padded = normalized + '='.repeat(padLen)
  const binary = window.atob(padded)
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function base64UrlToBuffer(base64Url: string): ArrayBuffer {
  return base64UrlToUint8Array(base64Url).buffer
}

export function bufferToBase64Url(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    buf instanceof Uint8Array
      ? buf
      : ArrayBuffer.isView(buf)
        ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        : new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return window
    .btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function isIpLiteral(hostname: string): boolean {
  if (!hostname) return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true
  if (hostname.includes(':') || hostname.startsWith('[')) return true
  return false
}

export function getWebAuthnSupportInfo(): WebAuthnSupportInfo {
  if (typeof window === 'undefined') {
    return {
      supported: false,
      browserApiAvailable: false,
      isSecureContext: false,
      isIpAddress: false,
      hostname: '',
      origin: '',
      reason: '当前运行环境不支持浏览器 WebAuthn API',
    }
  }

  const hostname = window.location.hostname
  const origin = window.location.origin
  const browserApiAvailable =
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials?.create === 'function' &&
    typeof navigator.credentials?.get === 'function'
  const secure = Boolean(window.isSecureContext)
  const ipAddress = isIpLiteral(hostname)

  if (!browserApiAvailable) {
    return {
      supported: false,
      browserApiAvailable: false,
      isSecureContext: secure,
      isIpAddress: ipAddress,
      hostname,
      origin,
      reason: '当前浏览器不支持通行密钥 (WebAuthn / Passkey)',
    }
  }

  if (ipAddress) {
    return {
      supported: false,
      browserApiAvailable: true,
      isSecureContext: secure,
      isIpAddress: true,
      hostname,
      origin,
      reason: `WebAuthn 规范不允许在纯 IP 地址 (${hostname}) 下使用通行密钥，请通过 localhost 或 HTTPS 域名访问（当前可使用动态口令 TOTP）`,
    }
  }

  if (!secure) {
    return {
      supported: false,
      browserApiAvailable: true,
      isSecureContext: false,
      isIpAddress: false,
      hostname,
      origin,
      reason: `通行密钥要求安全上下文 (HTTPS 或 http://localhost)，当前连接 (${origin}) 为非加密 HTTP`,
    }
  }

  return {
    supported: true,
    browserApiAvailable: true,
    isSecureContext: true,
    isIpAddress: false,
    hostname,
    origin,
  }
}

function toBufferSource(val: unknown): BufferSource {
  if (typeof val === 'string') {
    return base64UrlToUint8Array(val)
  }
  if (val instanceof ArrayBuffer) {
    return new Uint8Array(val)
  }
  if (ArrayBuffer.isView(val)) {
    const copy = new Uint8Array(new ArrayBuffer(val.byteLength))
    copy.set(new Uint8Array(val.buffer, val.byteOffset, val.byteLength))
    return copy
  }
  throw new Error('无效的 WebAuthn 二进制挑战数据')
}

function unwrapPublicKey<T extends Record<string, unknown>>(input: unknown): T {
  if (!input || typeof input !== 'object') {
    throw new Error('服务器返回的 WebAuthn 参数格式无效')
  }
  const obj = input as Record<string, unknown>
  if (obj.publicKey && typeof obj.publicKey === 'object') {
    return obj.publicKey as T
  }
  return obj as T
}

function normalizeWebAuthnError(err: unknown, fallback: string): Error {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') {
      return new Error('已取消通行密钥验证或验证超时')
    }
    if (err.name === 'InvalidStateError') {
      return new Error('该验证器上已绑定过此账号的通行密钥')
    }
    if (err.name === 'SecurityError') {
      return new Error('当前域名或安全上下文不满足 WebAuthn 要求（请使用 HTTPS 域名或 localhost）')
    }
  }
  return err instanceof Error ? err : new Error(fallback)
}

export async function runWebAuthnRegistration(
  publicKeyOptions: unknown,
): Promise<WebAuthnRegistrationCredentialJSON> {
  const support = getWebAuthnSupportInfo()
  if (!support.supported) {
    throw new Error(support.reason || '当前环境不支持通行密钥注册')
  }

  const raw = unwrapPublicKey<Record<string, unknown>>(publicKeyOptions)
  const userObj = (raw.user ?? {}) as Record<string, unknown>
  const excludeRaw = Array.isArray(raw.excludeCredentials) ? raw.excludeCredentials : []

  const publicKey: PublicKeyCredentialCreationOptions = {
    ...(raw as unknown as PublicKeyCredentialCreationOptions),
    challenge: toBufferSource(raw.challenge),
    user: {
      id: toBufferSource(userObj.id),
      name: String(userObj.name ?? ''),
      displayName: String(userObj.displayName ?? userObj.name ?? ''),
    },
    excludeCredentials: excludeRaw.map((item) => {
      const c = item as Record<string, unknown>
      return {
        type: (c.type as PublicKeyCredentialType) || 'public-key',
        id: toBufferSource(c.id),
        transports: Array.isArray(c.transports)
          ? (c.transports as AuthenticatorTransport[])
          : undefined,
      }
    }),
  }

  let cred: PublicKeyCredential | null = null
  try {
    cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null
  } catch (err) {
    throw normalizeWebAuthnError(err, '通行密钥创建失败')
  }

  if (!cred) {
    throw new Error('未获取到通行密钥凭据')
  }

  const resp = cred.response as AuthenticatorAttestationResponse
  const transports =
    typeof resp.getTransports === 'function' ? resp.getTransports() : undefined

  return {
    id: cred.id,
    rawId: bufferToBase64Url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults:
      typeof cred.getClientExtensionResults === 'function'
        ? cred.getClientExtensionResults()
        : {},
    response: {
      attestationObject: bufferToBase64Url(resp.attestationObject),
      clientDataJSON: bufferToBase64Url(resp.clientDataJSON),
      transports,
    },
  }
}

export async function runWebAuthnAssertion(
  publicKeyOptions: unknown,
): Promise<WebAuthnAssertionCredentialJSON> {
  const support = getWebAuthnSupportInfo()
  if (!support.supported) {
    throw new Error(support.reason || '当前环境不支持通行密钥验证')
  }

  const raw = unwrapPublicKey<Record<string, unknown>>(publicKeyOptions)
  const allowRaw = Array.isArray(raw.allowCredentials) ? raw.allowCredentials : undefined

  const publicKey: PublicKeyCredentialRequestOptions = {
    ...(raw as unknown as PublicKeyCredentialRequestOptions),
    challenge: toBufferSource(raw.challenge),
    allowCredentials: allowRaw?.map((item) => {
      const c = item as Record<string, unknown>
      return {
        type: (c.type as PublicKeyCredentialType) || 'public-key',
        id: toBufferSource(c.id),
        transports: Array.isArray(c.transports)
          ? (c.transports as AuthenticatorTransport[])
          : undefined,
      }
    }),
  }

  let cred: PublicKeyCredential | null = null
  try {
    cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null
  } catch (err) {
    throw normalizeWebAuthnError(err, '通行密钥验证失败')
  }

  if (!cred) {
    throw new Error('未获取到通行密钥签名响应')
  }

  const resp = cred.response as AuthenticatorAssertionResponse
  return {
    id: cred.id,
    rawId: bufferToBase64Url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults:
      typeof cred.getClientExtensionResults === 'function'
        ? cred.getClientExtensionResults()
        : {},
    response: {
      authenticatorData: bufferToBase64Url(resp.authenticatorData),
      clientDataJSON: bufferToBase64Url(resp.clientDataJSON),
      signature: bufferToBase64Url(resp.signature),
      userHandle: resp.userHandle ? bufferToBase64Url(resp.userHandle) : undefined,
    },
  }
}
