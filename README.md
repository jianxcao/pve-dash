# PVE Dash

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Go](https://img.shields.io/badge/Go-1.24+-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Proxmox VE](https://img.shields.io/badge/Proxmox%20VE-7.4%20%7C%208.x%20%7C%209.x-E57000)](https://www.proxmox.com/)

> **现代化、全功能、原生支持多集群的 Proxmox VE 控制平面（单二进制部署 · Web + PWA · 面向移动端演进）**

**PVE Dash** 旨在解决 Proxmox VE 原生 ExtJS 界面交互老旧、信息层级冗杂、移动端难以操作以及原生缺乏多独立集群统一治理等痛点。后端采用 **Go 单二进制（内置 SQLite 与前端静态资源）**，前端采用 **React 19 + TypeScript + Tailwind CSS v4 + ECharts + noVNC + xterm.js**，原生将 **LXC 容器与 QEMU 虚拟机视为一等公民**，完整兼容 **PVE 7.4 / 8.x / 9.x（含 PVE 9 deb822 软件源与 OCI 镜像拉取）**。

---

## 核心特性（已完成 Phase 1 + Phase 2 + Phase 3 + Phase 4）

### 多集群与统一控制平面
- **多独立 PVE 实例纳管与 Failover**：支持同时管理多个独立的 PVE 节点/集群，自动探测 PVE 版本与能力矩阵（Capabilities），支持 API Token / Ticket 认证、TLS TOFU 证书指纹锁定与高可用节点故障转移。
- **双模式侧边栏 + 全局 `⌘K` 命令面板**：一键切换「功能视角」与「资源树视角」；`⌘K` 支持跨实例毫秒检索 VM、LXC、节点、存储、主题及快捷命令。
- **全局写保护锁（只读模式）**：支持服务端环境变量 `PVE_DASH_READ_ONLY=true` 强制只读及顶栏一键切换「读写就绪 / 写保护」，防止日常巡检误操作。
- **完整操作审计与全局任务抽屉**：所有变更操作自动记录本地审计日志；底部全局任务抽屉支持 SSE 实时追尾 PVE UPID 任务日志与中止任务。

### 宿主机未直通硬件与 SMART 深度体检
- **未直通硬件总览**：自动区分宿主机内核持有的 GPU（Intel / AMD / NVIDIA）、物理硬盘与已直通给 VM 的设备，支持一键折叠/展开直通设备。
- **硬盘 SMART 综合健康度（%）**：解析 NVMe 损耗度、可用备用块、介质错误与 SATA 重映射/待映射扇区，给出 `0–100%` 量化评分、分级徽章与结构化 SMART 报告弹窗，精准识别“PVE 仅显示 PASSED 但存在坏扇区”的隐患盘。
- **缺失依赖三级降级与一键修复**：自动检测宿主机 `intel-gpu-tools`、`smartmontools`、`lm-sensors`、`nvme-cli` 安装状态，缺失时优雅降级并支持一键复制安装命令直达宿主机终端。

### 计算实例（QEMU VM & LXC 一等公民）
- **统一列表与详情监控**：QEMU 与 LXC 同屏检索、过滤、电源操作、ECharts RRD 多时间窗口监控（CPU / 内存 / 网络 / 磁盘 IO）与实时网卡 IP 采集。
- **可视化硬件配置与热调**：在线修改 CPU/内存/开机自启/备注，支持在线磁盘扩容（Resize）、Cloud-Init 参数配置与重新生成、QEMU Guest Agent 宿主机信息查看，以及 `Pending` 待重启变更 Diff 清晰标红。
- **双模式创建向导与克隆**：向导式创建 QEMU 虚拟机与 LXC 容器（自动获取 `nextid`、预加载 ISO/CT 模板与网桥列表），支持模板与实例克隆、快照树创建/回滚/删除。
- **多标签控制台工作台**：内置 `noVNC` 图形控制台（含快捷组合键）与 `xterm.js` 宿主机 / 容器 / 串口终端（原生处理 PVE `0:/1:/2:` 帧协议与心跳保活），移动端配备触控虚拟快捷键栏。

### 存储中心、备份恢复与节点运维
- **存储全链路管理**：浏览卷/ISO/CT 模板/备份归档，支持零 OOM 流式大文件上传（`io.Pipe`）、URL 直链下载与元数据探测、130+ 官方 LXC 模板库一键拉取、PVE 9.1+ OCI 镜像拉取。
- **备份与容灾中心（`/backups`）**：单实例即时 `vzdump` 备份、保护锁与备注管理、按需恢复至原/新 VMID；集群定时备份计划（`/cluster/backup`）CRUD 与未纳入定时备份实例自动巡检。
- **节点系统运维**：在节点详情页集成 **Systemd 核心服务管理**、**Syslog / Journald 实时日志**（支持服务/时间窗口/关键字过滤与最新优先）以及 **APT 待升级包与软件源检视**（兼容传统 `.list` 与 PVE 9 deb822 `.sources`）。

### 多通道阈值告警中心（`/alerts`）
- **后台自动巡检引擎**：30 秒周期自动巡检 11 类指标（实例/节点离线、宿主机 CPU/内存/封装温度、存储容量、VM/LXC CPU/内存、硬盘 SMART 健康度与温度、未覆盖备份数），支持持续防抖、冷却去重、单规则静默与故障自动恢复。
- **6 大通知通道（AES-256-GCM 加密）**：原生支持 **飞书**、**钉钉**、**企业微信**、**Telegram Bot**、**Bark (iOS)** 与 **通用 JSON Webhook（HMAC-SHA256）**，支持脱敏预览、一键测试发送与顶栏实时铃铛徽章。

### 节点网络、资源池与三级防火墙（Phase 3）
- **宿主机网络配置与热重载**：在节点详情页可视化管理 `Linux Bridge`、`Bond` 链路聚合、`802.1Q VLAN`、`OVSBridge` 与物理网卡（支持 VLAN 感知、MTU、IPv4/IPv6 CIDR 网关），自动检测 `/etc/network/interfaces.new` 暂存变更，支持一键撤销或二次确认调用 `ifreload2` 应用配置。
- **三级防火墙统一治理（Cluster / Node / Guest）**：覆盖数据中心集群级、宿主机节点级与单个 VM/LXC 实例级防火墙，支持总开关与默认入站/出站/转发策略、DHCP/MAC/IP 过滤、内置服务宏（SSH/HTTP/HTTPS/Proxmox 等）规则增删改与单条启停，并在集群级展示 IP 别名（Aliases）、IP 集合（IPSets）与安全组（Security Groups）。
- **资源池与增强批量操作（`/governance` & `/compute`）**：提供独立「集群治理与安全」工作台，支持资源池 CRUD、跨池迁入与成员跳转；计算列表支持批量电源二次确认、批量追加/移除/替换标签、批量加入资源池，并在实例详情页支持跨节点迁移向导。

### 磁盘栈 / Ceph、HA 高可用、证书 ACME 与多用户 RBAC（Phase 4）
- **节点磁盘栈与 Ceph 监控**：在节点详情页可视化浏览 **ZFS 池（含 vdev 拓扑展开与读写/校验错误数）**、**LVM 卷组 / Thin Pool（数据+元数据占比）** 与 **本地目录挂载**；支持 **Ceph 集群健康度（HEALTH_OK / WARN / ERR）、MON 仲裁状态、OSD 延迟与存储池 PG/副本监控**，未安装 Ceph 时提供清晰引导卡片。
- **全局存储挂载配置 CRUD**：在存储中心支持直接新增/编辑/移除集群级存储定义（`dir` / `nfs` / `cifs` / `pbs` / `lvm` / `lvmthin` / `zfspool`），严格按存储插件类型与 PVE 版本能力矩阵动态约束内容类型（含 PVE 9.2 细粒度类型与 `import`），并自动保护内置 `local` 存储。
- **HA 高可用、节点证书/ACME 与硬件资源映射**：自动识别 **PVE 9+ HA Rules** 与 **PVE 7/8 HA Groups** 模式，展示 Quorum/CRM/LRM 状态并支持受管 HA 资源 CRUD；节点详情页集成 **SSL 证书到期状态、SHA-256 指纹复制与 ACME 一键申请/续签**；支持 PVE 8.0+ **PCI/GPU、USB** 及 PVE 8.2+ **宿主机目录（virtiofs）** 集群资源映射管理。
- **多用户 RBAC、即时会话吊销与加密配置备份**：原生支持 `admin`（超级管理员）/ `operator`（运维员）/ `viewer`（只读观众）三级角色，角色降级与强制踢下线基于 `token_version` 实时生效；提供基于 **Argon2id + AES-256-GCM** 的口令加密配置导出与「先预检后增量无损合入」导入，以及带快捷预设的管理员 Raw PVE API 探测器。

### 6 套精选视觉主题
- 内置 4 套深色主题（**曜石黑 Obsidian** 默认纯黑、**子夜流光 Midnight Glass**、**工业机架 Rack Industrial**、**翠影碳黑 Emerald Carbon**）与 2 套浅色主题（**工作室白 Studio Light**、**温润纸感 Warm Paper**），ECharts 图表与表面层级实时同步并持久化至 SQLite。

---

## 快速开始

### 环境要求
- **Go 1.24+**
- **Node.js 20+**（用于构建前端静态资源）

### 从源码编译并运行（单二进制模式）

```bash
# 1. 克隆仓库
git clone https://github.com/jianxcao/pve-dash.git
cd pve-dash

# 2. 构建前端产物（自动输出至 web/dist 供 Go embed.FS 打包）
cd web
npm ci
npm run build
cd ..

# 3. 编译 Go 单二进制
go build -o bin/pve-dash ./cmd/pve-dash

# 4. 启动服务（默认监听 :8080，数据保存在 ./data）
PVE_DASH_LISTEN=:8080 PVE_DASH_DATA_DIR=./data ./bin/pve-dash
```

启动后访问 **`http://127.0.0.1:8080`**，首次打开会引导创建本地管理员账号，随后即可在「实例连接管理」中添加你的 Proxmox VE 节点或集群。

### 前后端分离开发模式

```bash
# 终端 1：启动 Go 后端（开启开发期 CORS）
PVE_DASH_LISTEN=:8080 PVE_DASH_DATA_DIR=./data PVE_DASH_DEV_CORS=true go run ./cmd/pve-dash

# 终端 2：启动 Vite 前端热更新（自动代理 /api 至 :8080）
cd web && npm run dev
```

---

## 环境变量配置

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PVE_DASH_LISTEN` | `:8080` | HTTP 服务监听地址（如 `127.0.0.1:18080` 或 `:8080`） |
| `PVE_DASH_DATA_DIR` | `./data` | SQLite 数据库（`pve-dash.db`）与自动生成密钥文件的存储目录 |
| `PVE_DASH_MASTER_KEY` | 自动生成 | 32 字节或 64 位十六进制主密钥，用于 AES-256-GCM 加密 PVE 凭据与告警通道密钥 |
| `PVE_DASH_JWT_SECRET` | 自动生成 | 32 字节或 64 位十六进制密钥，用于签发登录 JWT |
| `PVE_DASH_PUBLIC_URL` | 空 | 外部 HTTPS 访问地址（配置 `https://...` 时自动开启 Secure Cookie） |
| `PVE_DASH_SECURE_COOKIE` | `false` | 显式启用 `Secure` Cookie 属性 |
| `PVE_DASH_TRUST_PROXY` | `false` | 部署在受信任反向代理（Nginx / Caddy / Traefik）后时设为 `true`，按 `X-Forwarded-For` 解析客户端 IP |
| `PVE_DASH_READ_ONLY` | `false` | 设为 `true` 时服务端强制拒绝所有写操作（全局只读巡检模式） |
| `PVE_DASH_DEV_CORS` | `false` | 本地开发分离调试时允许跨域 |

> **提示（可选 SSH 硬件遥测）**：仅配置 PVE API Token 即可使用 95%+ 功能；若希望采集宿主机 GPU 实时频段/功耗（`intel_gpu_top`）、详细传感器及全部硬盘完整 SMART 指标，可在「实例连接管理」中填写本机已配置免密登录的 `SSH Host`（例如 `pve1` 或 `root@192.168.1.10`）。

---

## 技术栈与项目结构

```text
pve-dash/
├── cmd/pve-dash/          # Go 主入口（优雅启停 HTTP 服务、连接池与后台告警巡检引擎）
├── internal/
│   ├── api/               # chi 路由、CSRF/RBAC 鉴权守卫、统一错误映射与按领域拆分的处理器
│   ├── config/            # 环境变量加载与主密钥自动管理
│   ├── crypto/            # Argon2id 密码哈希、AES-256-GCM 凭据加密、TLS 指纹计算
│   ├── pve/               # 多端点 Failover 客户端、连接池、待机安全硬件探针、控制台 WS 代理
│   ├── service/           # 多集群单飞聚合器、认证缓存、告警评估引擎、6 大通道异步通知器
│   └── store/             # 纯 Go SQLite（modernc.org/sqlite）WAL 读写分离存储层
├── web/                   # React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui 前端
│   ├── embed.go           # //go:embed all:dist 单二进制嵌入
│   └── src/
│       ├── components/    # 布局、双模式侧栏、命令面板、按需 ECharts、noVNC/xterm、硬件与三级防火墙
│       ├── features/      # 按路由懒加载的模块化业务域（总览 / 计算 / 节点 / 存储 / 备份 / 治理 / 告警 / 控制台 / 实例 / 审计 / 设置）
│       ├── hooks/         # 跨页共享集群范围选择、RBAC 控制台启动器与响应式媒体查询 Hooks
│       ├── lib/           # 模块化 HTTP/XHR 自动续期客户端、SSE 切片订阅流、主题体系、能力矩阵
│       └── stores/        # Zustand 应用偏好与多标签持久化控制台状态
├── docs/                  # 架构调研、PRD、后端与前端设计文档
└── design-system/         # 设计令牌与视觉规范资产
```

---

## 路线图

- [x] **Phase 1（MVP）**：多集群接入与 TOFU 锁定、全局总览、QEMU/LXC 统一控制、RRD 监控、多标签 noVNC/xterm 控制台、宿主机未直通硬件与 SMART 健康度体检、6 套主题系统
- [x] **Phase 2（核心运维闭环）**：全局写保护锁、在线硬件配置/扩容/Cloud-Init、VM/LXC 创建向导、流式上传与模板/OCI 镜像库、备份恢复与集群定时备份、节点服务/日志/APT 运维、多通道阈值告警中心
- [x] **Phase 3（网络与集群治理）**：节点网桥/Bond/VLAN 管理与 `ifreload` 热重载、计算实例批量电源确认/批量标签/批量资源池与跨节点迁移、集群/节点/实例三级防火墙统一视图
- [x] **Phase 4（高级特性与多用户安全）**：ZFS/LVM/目录磁盘栈与 Ceph 监控、全局存储挂载 CRUD、HA 高可用（兼容 PVE 9 Rules / PVE 8 Groups）、节点 SSL 证书与 ACME 申请续签、PCI/USB/目录硬件映射、多用户 RBAC / 会话吊销、口令加密配置备份与迁移
- [ ] **Phase 5（移动端与发布）**：Capacitor iOS / Android 打包、多架构 Docker 镜像与 GitHub Releases 自动构建

---

## 设计与架构文档

| 序号 | 文档 | 内容概要 |
| :--- | :--- | :--- |
| 01 | [深度技术与生态调研报告](./docs/01-research-report.md) | PVE API 边界实证、7.4→8.x→9.x 版本差异、noVNC/xterm 协议与竞品对标 |
| 02 | [产品需求文档 (PRD)](./docs/02-prd.md) | 全量功能清单、多 PVE 治理逻辑与 Phase 1–5 分阶段路线 |
| 03 | [系统架构与 Go 后端设计](./docs/03-architecture-and-backend-design.md) | 连接池与 Failover、能力矩阵、WebSocket 代理、SSE 遥测与安全方案 |
| 04 | [前端架构与 UI/UX 设计规范](./docs/04-frontend-and-ui-design.md) | 令牌架构、信息架构、核心页面交互与移动端演进方案 |

---

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源，欢迎提交 Issue 与 Pull Request。
