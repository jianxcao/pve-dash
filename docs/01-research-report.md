# PVE Dash 深度技术与生态调研报告

> **版本**：v1.0  
> **日期**：2026-11-26  
> **目标目录**：`/Users/jianxcao/work/fun/pve-dash`  
> **调研目的**：围绕“**尽量覆盖 Proxmox VE 全量功能、解决多版本不兼容、支持多套 PVE 统一管理、Go 后端 + 现代 Web 前端、未来演进至移动 App**”五大目标，完成面向工程落地的底层事实调研与技术路线论证。

---

## 1. Proxmox VE 架构本质与 API 覆盖边界实证

### 1.1 为什么“全量实现 PVE 功能”在技术上完全成立？

Proxmox VE（PVE）是业内极少数坚持 **100% API-First（资源导向架构，ROA）** 的虚拟化平台：

1. **统一单一真相源**：PVE 后端由 Perl 编写，所有接口通过 `PVE::RESTHandler` 声明严格的 JSON Schema（包含路径、HTTP Method、入参类型/格式/默认值、返回结构、权限校验规则）。
2. **官方 Web 自身也是纯客户端**：PVE 官方自带的 ExtJS Web 界面、命令行工具 `pvesh`，全部调用同一套 `https://<host>:8006/api2/json/...` REST 接口，没有任何“隐藏私有数据库直连接口”。
3. **内置自描述 Schema 资产（`apidata.js` / `apidoc.js`）**：每台 PVE 节点的 `/usr/share/pve-docs/api-viewer/apidoc.js`（以及官方 `pve-docs` 仓库的 `apidata.js`）都导出了整棵 API 树的完整 JSON Schema 定义。这为我们后续做**接口覆盖度校验、参数表单校验和辅助代码生成**提供了极佳的数据源。

### 1.2 PVE REST API 全景树（7 大核心命名空间）

| 顶级路径 | 对应官方 UI 层级 | 核心子资源与能力覆盖 |
| :--- | :--- | :--- |
| **`/version`** | 全局 | PVE 版本号（`version`）、发行版（`release`）、仓库提交号（`repoid`） |
| **`/access`** | Datacenter → Permissions | `ticket`（登录票据）、`users`、`users/{id}/token`（API Token）、`groups`、`roles`、`acl`、`domains`（PAM/PVE/LDAP/AD/OIDC）、`tfa`（TOTP/WebAuthn/恢复码）、`password`、`permissions` |
| **`/cluster`** | Datacenter（集群级） | `status`、`resources`（全局资源一览）、`config`（集群创建/节点加入/QDevice）、`options`、`nextid`、`tasks`、`log`、`backup` & `backup-info`、`replication`、`ha`（`resources`/`groups`/`rules`/`status`）、`firewall`（`options`/`rules`/`groups`/`aliases`/`ipset`/`refs`）、`mapping`（`pci`/`usb`/`dir`）、`metrics/server`（InfluxDB/Graphite）、`notifications`（`endpoints`/`matchers`/`targets`）、`acme`、`ceph`、`sdn`、`jobs` |
| **`/nodes/{node}`** | 节点级 + 计算实例 | **节点系统**：`status`、`rrddata`、`syslog`、`journal`、`services`、`apt`（`update`/`versions`/`repositories`）、`certificates`（`custom`/`acme`）、`network`、`dns`、`hosts`、`time`、`subscription`、`firewall`、`wakeonlan`、`startall`/`stopall`/`migrateall`/`suspendall`、`tasks/{upid}`、`vzdump`、`query-url-metadata`、`aplinfo`（CT 模板目录）<br>**硬件与本地盘**：`disks`（`list`/`smart`/`initgpt`/`wipedisk`/`lvm`/`lvmthin`/`zfs`/`directory`）、`hardware`（`pci`/`usb`）<br>**节点存储**：`storage/{storage}`（`status`/`content`/`upload`/`download-url`/`import-metadata`/`file-restore`/`prunebackups`/`rrddata`）<br>**Ceph 节点态**：`ceph`（`mon`/`mgr`/`mds`/`osd`/`pool`/`fs`/`crush`/`rules`/`status`/`log`/`cfg`）<br>**QEMU VM**：`qemu/{vmid}`（`status`/`config`/`pending`/`snapshot`/`clone`/`migrate`/`remote_migrate`/`move_disk`/`resize`/`template`/`agent`/`cloudinit`/`firewall`/`rrddata`/`vncproxy`/`termproxy`/`spiceproxy`/`vncwebsocket`/`sendkey`/`monitor`/`feature`）<br>**LXC 容器**：`lxc/{vmid}`（`status`/`config`/`pending`/`snapshot`/`clone`/`migrate`/`remote_migrate`/`move_volume`/`resize`/`template`/`firewall`/`interfaces`/`rrddata`/`vncproxy`/`termproxy`/`spiceproxy`/`vncwebsocket`/`feature`） |
| **`/storage`** | Datacenter → Storage | 全局存储池 CRUD（Dir, LVM, LVM-Thin, ZFS, NFS, CIFS, PBS, Ceph RBD/CephFS, iSCSI, Btrfs, ESXi 等） |
| **`/pools`** | Datacenter → Pools | 资源池创建、编辑、成员（VM/LXC/Storage）绑定 |
| **`/sdn`** | Datacenter → SDN | `zones`（Simple/VLAN/QinQ/VXLAN/EVPN）、`vnets`、`subnets`、`controllers`、`ipams`、`dns`、`fabrics`（PVE 9+）及集群统一 Apply |

### 1.3 实证：官方 HTTP API 未覆盖的「1% 边缘空白区」

实事求是地说，并非宿主机上一切 Linux 运维动作都在 `/api2/json` 里。以下能力 PVE 原生 API **不提供或受限**：

| 空白能力 | 现状说明 | PVE Dash 应对策略 |
| :--- | :--- | :--- |
| **宿主机 CPU/主板/NVMe 实时温度与风扇转速** | PVE 原生 API 无传感器端点（仅 `disks/smart` 含部分硬盘温度），社区玩家常需魔改官方 JS/Perl 源码 | Phase 5 提供**可选**轻量 Host Agent 或 SSH `sensors -j` 采集，非侵入式补充，不强制依赖 |
| **宿主机 GRUB / IOMMU 内核启动参数修改** | 涉及 `/etc/default/grub`、`/etc/modules` 与 `update-grub` | 提供内置宿主机 `termproxy` 终端 + IOMMU 只读检测（基于 `/nodes/{node}/hardware/pci`） |
| **Hookscript 脚本文件直接上传/编辑** | 仅支持在 VM 配置引用 snippets 存储路径，编辑脚本内容无专用编辑器 API | 通过 Snippets 上传接口或宿主机终端处理 |
| **非标准 QEMU `args:` 高级参数** | API 允许 root 修改，但结构为自由文本 | 在高级配置/原始配置编辑区保留专业编辑能力并做权限校验 |
| **旧版 APT 软件源精细排障** | 多数场景 `/apt/repositories` 已覆盖，但自定义第三方源/去订阅弹窗仍常靠终端 | 基础源管理走 API，复杂操作一键进宿主机终端 |

**结论**：PVE 官方 Web 的功能约 **99%** 都可通过 `/api2/json` 实现；通过合理的分阶段规划与 Schema 表单引擎，完全可以打造覆盖度 95%+ 的全功能替代品，并额外补齐官方最弱的“多独立 PVE 管理”与“移动端体验”。

---

## 2. PVE 多版本演进与不兼容实证矩阵（7.4 → 8.x → 9.x）

“多版本不兼容”不是玄学，必须落到**具体的版本号、具体的破坏性变更和具体的接口差异**上。下表梳理了 PVE 7.4 到 PVE 9.x 的真实 API 与行为变更：

### 2.1 核心版本差异清单

| 版本节点 | 关键新增 API / 特性 | 破坏性变更 / 废弃项 / 注意事项 | 对 PVE Dash 的具体影响 |
| :--- | :--- | :--- | :--- |
| **PVE 7.4**（LTS 尾版） | 稳定基础 API；cgroup v1/v2 并存 | 无 SDN 核心化、无 `/cluster/mapping`、无 `/cluster/notifications`、无 OCI 支持 | **建议设为最低兼容基线**（PVE 6 及 7.0–7.3 已 EOL，不浪费精力兼容） |
| **PVE 8.0** | 新增硬件资源映射 `/cluster/mapping/pci` 与 `/cluster/mapping/usb`；新增 CPU 类型 `x86-64-v2-AES`；Ceph Quincy/Reef | 硬件直通既支持旧式 `hostpci0=0000:01:00.0` 又支持新式 `mapping=<id>` | PCI/USB 直通表单需根据版本探测切换或双模式兼容 |
| **PVE 8.1** | **SDN 正式内置核心**；**全新通知框架 `/cluster/notifications`**（Targets/Matchers） | 传统邮件通知逐步被新通知系统接管 | 低于 8.1 隐藏“通知路由”与“SDN”模块或提示需安装插件 |
| **PVE 8.2 – 8.4** | **ESXi/OVF 导入向导**（`import-metadata`、ESXi 存储类型）；Backup Fleecing；**Virtiofs** 共享目录映射（`/cluster/mapping/dir`）；nftables 防火墙预览；`remote_migrate` 持续完善 | 部分存储导入元数据端点仅 8.2+ 存在 | 导入向导与目录映射按能力开关动态开启 |
| **PVE 9.0**（Debian 13 Trixie） | **HA Rules（亲和性/反亲和性规则 `/cluster/ha/rules`）**；**SDN Fabrics（OpenFabric/OSPF）**；厚置备 LVM-over-SAN 卷链快照；vTPM 状态存 qcow2；内核 6.14+ | **4 项关键破坏性变更**：<br>1. **强制 cgroup v2**（彻底移除 v1）<br>2. **权限模型变动**：移除 `VM.Monitor`；新增独立 `VM.Replicate`；创建/管理特权 LXC 强制需要 `Sys.Modify`<br>3. **防火墙规则校验更严格**：旧版松散格式会被拒绝<br>4. **APT 仓库转向 deb822 `.sources` 格式**；传统 HA Groups 标记弃用 | 1. 角色/权限编辑器必须按版本渲染权限项<br>2. HA 页面需同时兼容 7/8 的 `groups` 与 9+ 的 `rules`<br>3. 防火墙表单必须严格前端+后端预校验<br>4. APT 源解析需兼容 `.list` 和 `.sources` |
| **PVE 9.1 – 9.3+** | **原生 OCI 容器镜像支持**（直接拉取 Docker/OCI 镜像作为 LXC 模板，支持 GUI 配环境变量）；第三方存储插件 UI Schema 生成；Ceph Squid/Tentacle | OCI 镜像拉取与环境变量字段为 9.1+ 专属 | LXC 创建向导在 9.1+ 自动解锁“从 OCI 镜像创建”标签页 |

### 2.2 解决多版本不兼容的 4 项工程机制

1. **连接期版本探测（`GET /api2/json/version`）**：每次建立/刷新实例连接时获取并缓存 SemVer 版本号，派生强类型的 `Capabilities` 能力标志位（如 `SupportsMapping`、`SupportsSDN`、`SupportsHARules`、`SupportsOCI`、`SupportsNotifications`、`UseStrictPVE9ACL`）。
2. **领域模型防腐层（Anti-Corruption Layer）**：Go 后端永远不把不同版本参差不齐的原始 PVE JSON 直接裸透给前端（除显式 Raw 逃生接口外），而是在 Adapter 层归一成稳定内部 DTO。
3. **宽容反序列化 + 运行时降级**：Go 端不使用 `DisallowUnknownFields()`，对可能缺失的字段统一用指针/零值语义处理；当遇到可选接口返回 `501 Not Implemented` 时自动将对应能力降级并在 UI 温和提示。
4. **基于 `apidata.js` 的多版本 Schema 回归测试**：收集 PVE 7.4 / 8.4 / 9.x 三份官方 `apidata.js` 作为测试夹具（Fixtures），在 CI 中自动检测我们的接口路径和参数名是否偏离官方 Schema。

---

## 3. 核心协议、鉴权与高危工程深坑实证

这是过去很多第三方 PVE 项目烂尾或体验极差的真正原因。调研确认以下 6 个核心技术细节：

### 3.1 鉴权双模式：API Token vs User Ticket

| 维度 | API Token (`PVEAPIToken`) | User Ticket (`PVEAuthCookie` + `CSRFPreventionToken`) |
| :--- | :--- | :--- |
| **请求头** | `Authorization: PVEAPIToken=user@realm!tokenid=uuid` | `Cookie: PVEAuthCookie=...` + 写请求需 `CSRFPreventionToken` |
| **生命周期** | 长期有效（可设过期时间），无状态 | **2 小时过期**，需定期调用 `/access/ticket` 续期 |
| **权限模型** | 支持 Privilege Separation（权限取 User 与 Token 交集） | 直接继承用户全部权限 |
| **关键踩坑点** | **部分 PVE 版本的 `termproxy`（LXC/宿主机终端）对 Token 的用户名格式（含 `!tokenid`）存在严格校验或需 `Referer`，偶发报 `does not look like a valid user name`** | 账密需加密保存于后端，且开启 2FA（TFA）的账号无法无人值守自动续期 |

**PVE Dash 工程方案**：
- 添加 PVE 实例时**默认推荐 API Token**（安全、免续期、支持 2FA 账号），同时**允许绑定可选的 Service Ticket 账号或按需临时 Ticket 登录**。
- 当检测到某节点用 API Token 调用 `termproxy` 失败（HTTP 400/401/500）时，若实例配置了备用凭据则自动无缝切 Ticket 建连；否则向前端弹出轻量的一次性 PVE 密码验证框换取临时 Ticket，彻底避免控制台不可用。

### 3.2 远程控制台底层协议精确拆解

#### A. noVNC 图形桌面（`vncproxy` → `vncwebsocket`）
1. Go 后端向 PVE 发起：`POST /api2/json/nodes/{node}/qemu/{vmid}/vncproxy`，表单参数 `websocket=1&generate-password=1`（LXC 亦可走 `/lxc/{vmid}/vncproxy`）。
2. PVE 返回短期一次性票据：`{ port, ticket, user, upid, password }`（注意 `ticket` 有效期极短，不可缓存，必须现申现连）。
3. Go 后端发起上游 WebSocket 升级：
   - URL：`wss://{pve_host}:8006/api2/json/nodes/{node}/qemu/{vmid}/vncwebsocket?port={port}&vncticket={url.QueryEscape(ticket)}`
   - **双重认证（最常见 401 坑）**：Query 里传 `vncticket` 只是授权该 VNC 会话，**WebSocket HTTP Upgrade 请求头里仍必须携带 `Authorization: PVEAPIToken=...`（或 `Cookie: PVEAuthCookie=...`）**！
4. 建立上游 WSS 后，Go 后端与前端 `@novnc/novnc` 建立下游 WS，直接透传 RFB 二进制帧，同时把 `password`（或 `ticket`）通过安全信道给前端完成 RFB 认证。

#### B. xterm.js 终端（`termproxy` → `vncwebsocket`）精确线协议
PVE 的 `pve-xtermjs` 使用一套**非常具体的自定义文本帧协议**（不同于普通 SSH WebSocket）：
1. 调用 `POST /api2/json/nodes/{node}/{qemu|lxc}/{vmid}/termproxy`（宿主机 Shell 为 `POST /api2/json/nodes/{node}/termproxy`），拿到 `port`、`ticket`、`user`。
2. 同上双重认证方式升级 `wss://.../vncwebsocket?port={port}&vncticket={url.QueryEscape(ticket)}`。
3. **首包认证（必须带 `\n`）**：连接打开后，发送的第一帧必须是 `{user}:{ticket}\n`，等待 PVE 返回纯文本 `OK`（少换行符会直接断连）。
4. **上行数据帧（Client → PVE）**：
   - 终端输入：`0:{byte_length}:{payload}`（注意是**UTF-8 字节长度**而非字符数！中文输入若按字符数算会直接错位断连！）
   - 窗口尺寸同步：`1:{cols}:{rows}:`（例如 `1:120:36:`）
   - 心跳保活：`2:`（PVE 服务端有 **5 分钟无活动自动断连**超时，Go 代理层每 30 秒自动发送 `2:` 即可彻底防断连）
5. **下行数据帧（PVE → Client）**：无任何自定义包装，原始 PTY stdout/stderr 字节流 1:1 推送。

**设计亮点**：由 Go 后端直接封装上述握手、UTF-8 字节计长和 30 秒心跳保活，对外暴露极其干净的标准化 WebSocket 协议给 Web 前端和未来 App！

### 3.3 大文件流式上传（避免内存爆炸）

- PVE 上传接口 `POST /nodes/{node}/storage/{storage}/upload` 要求 `multipart/form-data`，包含 `content`（`iso`/`vztmpl`/`import`）和 `filename`。
- 常见坑：传统 Web 框架（如默认 `ParseMultipartForm`）会把 8GB 的 Windows ISO 先缓存到内存或临时磁盘再转发，导致 BFF 容器 OOM 或磁盘写满。
- **Go 最佳实践**：使用 `http.Request.MultipartReader()` + `io.Pipe()` 边读边通过 `multipart.NewWriter` 流式转发到 PVE，全过程内存恒定在几十 MB 以内，且可通过自定义 `io.Reader` 实时统计已传输字节并推送进度条。

### 3.4 异步任务（UPID）与 `pveproxy` 并发压力保护

- PVE 所有耗时动作均返回 UPID，结构固定为：
  `UPID:{node}:{pid_hex}:{pstart_hex}:{starttime_hex}:{type}:{id}:{user}:`
- 日志接口 `GET /nodes/{node}/tasks/{upid}/log?start={line}&limit=500` 支持基于行号 `start` 的增量拉取。
- **性能坑**：PVE 节点自带的 `pveproxy` 是基于 Perl AnyEvent 的服务，默认并发 Worker 有限。如果有 5 个浏览器标签页同时每秒轮询 10 个接口，极易把 `pveproxy` 打卡甚至触发超时。
- **Go 最佳实践**：Go 后端引入 **Singleflight + 短 TTL 内存缓存（2–3 秒）+ 按需订阅 SSE 推送**。无论打开多少个 Web/App 端，Go 后端对每个 PVE 实例在 2 秒窗口内最多只发 1 次 `/cluster/resources` 请求，大幅减轻宿主机负担。

---

## 4. 竞品与开源生态对标分析

| 项目 | 定位与特点 | 技术栈 | 优势 | 局限 / 与我们的差异 |
| :--- | :--- | :--- | :--- | :--- |
| **PVE 官方 Web** | 官方原生全功能控制台 | Perl + ExtJS | 100% 功能覆盖、零额外部署 | UI 停留在十年前、弹窗极深、无多独立集群聚合、手机端不可用 |
| **Proxmox Datacenter Manager (PDM 1.x)** | 官方多集群控制面 | Rust + Yew (Wasm) | 官方出品、支持多 Remote 聚合、跨集群迁移、裸机自动安装、Ceph 总览 | 偏企业重型监控与顶层调度，单节点/单 VM 细粒度操作（硬件/快照/终端等）仍常需回跳 PVE，且偏传统企业桌面风、无独立移动 App 路线 |
| **Proxmox Pulse** | 轻量监控大盘 | Node/Go 轻量容器 | 颜值高、部署简单、擅长状态总览与告警 | **偏只读监控**，缺少完整虚拟化生命周期与深度配置管理 |
| **PegaProx / ProxUI** | 社区第三方现代 Web UI | React/TS 等 | 界面现代化、补强了 Cloud-Init 或多集群体验 | 覆盖的 PVE 功能面仍偏子集（缺 Ceph/SDN/HA/全量硬件配置/多版本适配体系） |
| **PVE-Electrified** | 侵入式改造原生 Web | React + Vite + Node | 可直接给原生 UI 注入插件 | 侵入宿主机系统文件，升级 PVE 易冲突，无法跨多独立集群 |
| **ProxMobo (iOS)** | 优秀商业原生 App | SwiftUI | 移动端体验一流 | 闭源收费、仅 Apple 生态、无 Web 控制面 |

**PVE Dash 的明确差异化定位**：
> **非侵入式（零宿主机改造）** + **原生多独立 PVE 聚合** + **分阶段迈向 95%+ 全量 PVE 管理深度** + **精密暗黑极速 UI** + **一套代码覆盖桌面 Web / 移动 PWA / 未来 Capacitor 原生 App**。

---

## 5. 技术栈深度选型论证

### 5.1 后端：Go 生态与 Proxmox SDK 选型

#### Q1：为什么不直接重度依赖现有 Go Proxmox SDK？
调研了目前主流的 Go Proxmox 库：
- **`Telmate/proxmox-api-go`**：生态最老牌（Terraform Provider 底座），但代码设计强耦合 Terraform 的声明式资源模型，历史包袱重，且对 PVE 8.2–9.x 新接口（SDN Fabrics、HA Rules、Notifications、OCI、Import）覆盖严重滞后。
- **`luthermonson/go-proxmox`**：API 风格比 Telmate 现代清晰，适合写常规运维脚本，但覆盖率远不足以支撑“尽量全量 PVE 管理”（缺大量 Ceph/SDN/Firewall/ACME/Disks/Access/Notifications 子树），且升级受限于上游节奏。
- **`FreekingDean/proxmox-api-go`（基于 `apidata.js` 生成）**：证明了解析 `apidata.js` 自动生成 Go 类型完全可行，但纯生成的代码往往缺乏领域语义抽象、缺少跨版本兼容逻辑和流式 WS/Upload 定制能力。

**最终推荐方案（混合架构，兼得全覆盖与高可控）**：
1. **自研极简核心传输层 `internal/pve/client`**：基于 Go 标准库 `net/http`，原生掌控 TLS 指纹锁定（TOFU）、连接池、Token/Ticket 双鉴权、多 Endpoint 自动 Failover、流式上传与 `coder/websocket` 升级。
2. **核心领域强类型模块 + `apidata.js` 辅助 Schema 校验**：对高频领域（Cluster/Node/QEMU/LXC/Storage/Task/Snapshot/Backup）写干净优雅的 Go Struct 与 Adapter；利用官方 `apidata.js` 自动生成端点清单与参数 Schema 供校验和前端动态表单复用。
3. **受控 Raw 透传通道**：对极其冷门的 PVE 参数或刚发布的新版端点，允许通过统一的权限审计代理直通，保证**永远不会因为 SDK 没写而卡死用户**。

#### Q2：Go 核心组件推荐

| 层级 | 推荐选型 | 核心理由 |
| :--- | :--- | :--- |
| **HTTP 路由** | **`go-chi/chi/v5`** | 100% 兼容标准 `http.Handler`，零反射、极轻量，与 `net/http` 流式上传、SSE、WebSocket 升级无缝配合（备选：`gin`，团队熟悉亦可） |
| **WebSocket** | **`github.com/coder/websocket`** | 原 `nhooyr.io/websocket`，原生支持 `context.Context` 超时取消、并发安全，比已归档维护态的 `gorilla/websocket` 更现代 |
| **本地数据库** | **SQLite (`modernc.org/sqlite`) + PostgreSQL 可选** | `modernc.org/sqlite` 为纯 Go 实现，**彻底免 CGO**，一条命令即可交叉编译 `linux/amd64`、`linux/arm64`、`darwin/arm64` 单文件二进制！开启 WAL 模式满足中小规模并发；企业多副本部署可无缝切 PG |
| **数据访问** | **`sqlc` 或 `GORM`（推荐 `sqlc` + `goose` 迁移）** | 编译期 SQL 类型安全、零运行时反射开销，适合高可靠基础设施工具 |
| **日志与配置** | **`log/slog`（标准库）+ `caarlos0/env` / YAML** | 零额外重型依赖，支持 JSON 结构化日志 |
| **凭据加密** | **Go 标准库 `crypto/aes` (AES-256-GCM) + `golang.org/x/crypto/argon2`** | 落库 PVE Token/密码全部密文加密存储 |
| **静态资源打包** | **Go `embed.FS`** | 前端构建产物直接嵌入 Go 二进制，发布单文件与 ~30MB Scratch/Alpine Docker 镜像 |

### 5.2 前端：React vs Vue 深度对比与推荐

用户提出前端可选 Vue 或 React。结合本项目的两个强约束——**“高密度专业控制台 + 后续 Capacitor 做移动 App”**，对比如下：

| 对比维度 | React 19 + TypeScript（**主推**） | Vue 3 + TypeScript（**备选等价**） |
| :--- | :--- | :--- |
| **UI 与设计技能协同** | **`shadcn/ui` (Radix UI) + Tailwind v4** 为原版一等生态，与本项目的 `ui-ux-pro-max` / `ui-styling` 技能栈完美契合，无障碍（Modal 焦点陷阱、键盘导航、Command `Cmd+K`）开箱即用 | `shadcn-vue` (Reka UI) / `PrimeVue` / `Naive UI` 同样成熟，但社区复杂组件模板略少于原版 shadcn |
| **重型控制台组件生态** | `@tanstack/react-table` + `@tanstack/react-virtual` + `cmdk` + `@novnc/novnc` + `@xterm/xterm` + `echarts` 生态极度成熟 | `@tanstack/vue-table` + `@tanstack/vue-virtual` + `@novnc/novnc` + `@xterm/xterm` + `echarts` 全部原生支持，同样可行 |
| **移动端演进上限** | **Capacitor 完美支持**；且如果未来项目大获成功、决定从 WebView 升级为纯原生渲染 App，**React 生态可直接平滑复用 Hooks/API/状态层到 React Native (Expo)** | Capacitor 同样完美支持，但若未来脱离 WebView 转纯原生，Vue 生态没有与 React Native 同量级的原生跨端路径 |
| **AI 辅助研发效率** | TypeScript + React + Tailwind + shadcn/ui 的代码生成准确率、组件复用率行业最高 | Vue 3 `<script setup>` 同样简洁直观 |

**选型结论**：
- **默认推荐**：**React 19 + TypeScript + Vite 6 + Tailwind CSS v4 + shadcn/ui + TanStack Query/Table/Virtual + Zustand + ECharts + Capacitor**。
- **解耦保障**：Go 后端完全提供标准 REST JSON + SSE + WebSocket API，与前端框架零耦合。如果你个人更偏爱 **Vue 3**，可 100% 按本设计文档平替为 `Vue 3 + Pinia + Vue Router + shadcn-vue (Reka UI) + TanStack Query/Table`。

---

## 6. 调研总结与风险清单

| 风险点 | 严重度 | 缓解方案 |
| :--- | :---: | :--- |
| PVE 表单参数过于庞大导致开发周期失控 | 高 | 采用 **80/20 体验优先 + Schema 动态表单引擎 + 原始配置编辑逃生舱**，分 5 阶段交付 |
| 多客户端同时打开导致 PVE `pveproxy` 过载 | 高 | Go 后端统一汇聚 + Singleflight 2–3s 缓存 + SSE 扇出，绝不让前端直连裸轮询 |
| 某台跨网 PVE 离线拖垮全局仪表盘 | 高 | 实例级独立超时（3s）+ 并发 `errgroup` 局部容错 + 熔断降级状态展示 |
| API Token 调用 `termproxy` 遇版本兼容异常 | 中 | 后端自动识别错误码并支持无缝切 Ticket 凭据或前端临时密码换票 |
| 大文件 ISO 上传导致 BFF 容器 OOM | 中 | `MultipartReader` + `io.Pipe` 全链路零落盘流式转发 |
| 自签名证书安全与体验平衡 | 中 | 引入 SSH 风格的 **TOFU（首次信任指纹锁定）**，兼顾 Homelab 零配置与防中间人攻击 |
