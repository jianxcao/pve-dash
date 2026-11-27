# PVE Dash

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Go](https://img.shields.io/badge/Go-1.24+-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Docker](https://img.shields.io/badge/GHCR-linux%2Famd64%20%7C%20arm64-2496ED?logo=docker&logoColor=white)](https://github.com/jianxcao/pve-dash/pkgs/container/pve-dash)
[![Proxmox VE](https://img.shields.io/badge/Proxmox%20VE-7.4%20%7C%208.x%20%7C%209.x-E57000)](https://www.proxmox.com/)

> **现代化、全功能、原生支持多集群的 Proxmox VE 控制平面（零依赖单二进制 / 多架构 Docker · Web + PWA · 移动端触控控制台）**

**PVE Dash** 旨在解决 Proxmox VE 原生 ExtJS 界面交互老旧、信息层级冗杂、移动端难以操作以及原生缺乏多独立集群统一治理等痛点。后端采用 **纯 Go 单二进制（内置读写分离 SQLite 与前端静态资源）**，前端采用 **React 19 + TypeScript + Tailwind CSS v4 + 按需 ECharts + noVNC + xterm.js**，原生将 **LXC 容器与 QEMU 虚拟机视为一等公民**，完整兼容 **PVE 7.4 / 8.x / 9.x（含 PVE 9 deb822 软件源、HA Rules 与 OCI 镜像拉取）**。

---

## 核心特性（已完成 Phase 1 – Phase 5）

### 多集群与统一控制平面
- **多独立 PVE 实例纳管与 Failover**：支持同时管理多个独立的 PVE 节点/集群，自动探测 PVE 版本与能力矩阵（Capabilities），支持 API Token / Ticket 认证、TLS TOFU 证书指纹锁定与高可用多端点故障转移。
- **双模式侧边栏 + 全局 `⌘K` 命令面板**：一键切换「功能视角」与「资源树视角」；`⌘K` 支持跨实例毫秒检索 VM、LXC、节点、存储、主题及快捷命令。
- **全局写保护锁（只读模式）**：支持服务端环境变量 `PVE_DASH_READ_ONLY=true` 强制只读及顶栏一键切换「读写就绪 / 写保护」，防止日常巡检误操作。
- **完整操作审计与全局任务抽屉**：所有变更操作自动记录本地审计日志；全局任务抽屉（桌面端侧栏 + 移动端底部抽屉）支持 SSE 实时追尾 PVE UPID 任务日志与中止任务。

### 宿主机未直通硬件与 SMART 深度体检
- **未直通硬件总览**：自动区分宿主机内核持有的 GPU（Intel / AMD / NVIDIA）、物理硬盘与已直通给 VM 的设备，支持一键折叠/展开直通设备。
- **硬盘 SMART 综合健康度（%）与待机保护**：解析 NVMe 损耗度、可用备用块、介质错误与 SATA 重映射/待映射扇区，给出 `0–100%` 量化评分与结构化 SMART 报告弹窗；后台巡检自动附带 `-n standby,0` 待机保护，绝不唤醒休眠机械盘。
- **缺失依赖三级降级与一键修复**：自动检测宿主机 `intel-gpu-tools`、`smartmontools`、`lm-sensors`、`nvme-cli` 安装状态，缺失时优雅降级并支持一键复制安装命令直达宿主机终端。

### 计算实例（QEMU VM & LXC 一等公民）与移动触控控制台
- **统一列表与详情监控**：QEMU 与 LXC 同屏检索、过滤、客户端分页、电源操作、ECharts RRD 多时间窗口监控（CPU / 内存 / 网络 / 磁盘 IO）与实时网卡 IP 采集，支持在线迁移后自动跟随跳转新节点。
- **可视化硬件配置与热调**：在线修改 CPU/内存/开机自启/备注，支持在线磁盘扩容（Resize）、Cloud-Init 参数配置与重新生成、QEMU Guest Agent 宿主机信息查看，以及 `Pending` 待重启变更 Diff 清晰标红。
- **双模式创建向导与克隆**：快速/专家双模式创建 QEMU 虚拟机（支持 UEFI Secure Boot 与 TPM 2.0）与 LXC 容器（自动获取 `nextid`、预加载 ISO/CT 模板与网桥列表），支持模板与实例克隆、快照树创建/回滚/删除。
- **持久化多标签控制台与移动端适配**：内置切换路由不断连的 `noVNC` 图形控制台与 `xterm.js` 宿主机 / 容器 / 串口终端；移动端配备 **VNC 软键盘文本/密码输入栏**、**xterm 粘滞 `CTRL`/`ALT` 虚拟键栏** 以及 `visualViewport` 软键盘高度自适应防遮挡。

### 存储中心、备份恢复与节点运维
- **存储全链路管理**：浏览卷/ISO/CT 模板/备份归档，支持零 OOM 流式大文件上传（`io.Pipe` + 连接前多端点容灾）、URL 直链下载与元数据探测、130+ 官方 LXC 模板库一键拉取、PVE 9.1+ OCI 镜像拉取。
- **备份与容灾中心（`/backups`）**：单实例即时 `vzdump` 备份、保护锁与备注管理、按需恢复至原/新 VMID；集群定时备份计划（`/cluster/backup`）CRUD 与未纳入定时备份实例自动巡检。
- **节点系统运维**：在节点详情页集成 **Systemd 核心服务管理**、**Syslog / Journald 实时日志**（自动对齐宿主机时区与最新日志追尾）以及 **APT 待升级包与软件源检视**（兼容传统 `.list` 与 PVE 9 deb822 `.sources`）。

### 统一通知中心与 [jianxcao/notify](https://github.com/jianxcao/notify) 深度集成（`/alerts`）
- **7 大加密通知通道**：原生支持 **[Notify 统一通知平台](https://github.com/jianxcao/notify)**、**飞书**、**钉钉**、**企业微信**、**Telegram Bot**、**Bark (iOS)** 与 **通用 JSON Webhook（HMAC-SHA256）**，所有凭据经 AES-256-GCM 加密存储，支持连通性测试与单规则「恢复时同步发送 `[已恢复]` 通知」（`notifyOnResolve`）开关。
- **`Notify` 平台一键对接与 PVE 原生 Webhook 联动**：
  - 在「通知通道」选择 **Notify 统一通知平台**，填入推送地址（如 `https://notify.example.com:2053/api/v1/notify/pve`，或填基础地址配合 `App ID` 自动拼接），按需配置可选 `Bearer Token`、转发目标 `Targets` 与面板跳转链接 `Panel URL`。
  - 面板内置 **「Notify 模板与 PVE 8.1+ 原生 Webhook 指南」** 弹窗，可一键复制标准 `pve` 消息模板 JSON；在 Proxmox VE 官方控制台（`数据中心 → 通知 → 添加 Webhook`）指向同一 Notify 接口后，即可用同一套模板汇总 PVE Dash 巡检/审计通知与宿主机底层 `vzdump`、HA Fencing、ZFS 复制通知。
- **3 大类可勾选通知订阅矩阵（周期阈值 + 8 细项主动事件）**：
  1. **监控巡检阈值（11 类指标）**：30 秒周期自动巡检实例/节点离线、宿主机 CPU/内存/封装温度、存储容量、VM/LXC CPU/内存、硬盘 SMART 健康度与温度、未覆盖备份数，支持持续时长防抖、冷却去重与静默窗口。
  2. **运维生命周期事件（5 细项，支持切换「全部推送 / 仅失败时告警」)**：`vm.lifecycle`（创建/克隆/转模板/销毁/在线迁移）、`vm.power`（开/关/重启/强停/挂起）、`vm.config_snapshot`（配置变更/磁盘扩容/Cloud-Init/快照）、`backup.ops`（手动备份/恢复/备份计划变更）、`node.infra`（节点网络/服务/存储定义/防火墙/HA/资源池/硬件映射变更）。
  3. **账号与安全审计事件（3 细项）**：`security.login_anomaly`（密码错误、2FA 失败与限流爆破拦截，带同 IP 冷却聚合）、`security.login_success`（登录提醒与首次出现的新来源 IP 高亮预警）、`security.account_change`（用户增删改、角色变更、2FA 绑定/重置与加密配置导入导出）。

### 账号双重验证（2FA / MFA）与多用户 RBAC（`/settings`）
- **WebAuthn / FIDO2 通行密钥 (Passkey)**：纯 Go 原生实现，支持绑定多枚通行密钥，完整兼容 **Mac Touch ID 指纹 / iCloud 钥匙串**、**Windows Hello**、**Bitwarden 通行密钥**及硬件安全密钥免验证码一键登录。
  > **安全上下文提示**：遵循浏览器 W3C WebAuthn 规范，注册与调用通行密钥须通过 **`https://` 域名**（反向代理配置 `PVE_DASH_PUBLIC_URL=https://pve-dash.example.com`）或本地 **`http://localhost`** 访问；通过纯内网 IP 访问时，面板会自动检测并引导使用 TOTP 动态口令验证。
- **TOTP 动态口令验证器**：基于 RFC 6238 标准，后端离线直出 SVG 绑定二维码（零第三方依赖、零外网请求），兼容 **Bitwarden 验证器**、**Google / Microsoft Authenticator**、1Password 等客户端，内置时间步长防重放保护。
- **一次性应急恢复码与管理员重置**：首次开启任一 2FA 方式自动生成 **8 组 `XXXX-XXXX` 一次性恢复码**（支持一键复制、下载 `.txt` 备份与随时重新生成）；管理员可在「用户与权限」列表中查看全员 2FA 状态并执行应急 **重置 2FA**。
- **三级 RBAC、实时会话吊销与加密配置迁移**：支持 `admin` / `operator` / `viewer` 三级权限（严密拦截非管理员修改宿主机特权直通参数），角色降级或重置密码基于 `token_version` 秒级吊销旧会话与活跃终端；支持 **Argon2id + AES-256-GCM** 口令加密配置导出与「先预检后无损合入」导入。

### 节点网络、三级防火墙、磁盘栈 / Ceph 与 HA 高可用
- **宿主机网络配置与热重载**：可视化管理 `Linux Bridge`、`Bond`、`802.1Q VLAN`、`OVSBridge` 与物理网卡，检测暂存变更并支持一键撤销或二次确认调用 `ifreload2` 热应用。
- **三级防火墙与资源池治理**：覆盖集群级、节点级与 VM/LXC 实例级防火墙（含安全组、IPSet、Alias 与内置服务宏），支持资源池 CRUD 与计算实例批量标签/批量入池。
- **ZFS / LVM / Ceph、全局存储挂载、HA 与证书 ACME**：可视化浏览 ZFS vdev 拓扑、LVM Thin 与 Ceph 健康度/OSD/PG；支持全局存储挂载（NFS / SMB / PBS / Directory 等）CRUD、兼容 PVE 9 HA Rules 与 PVE 7/8 HA Groups 的高可用管理、节点 SSL 证书检视与 ACME 续签、以及 PCI/USB/目录（`virtiofs`）集群资源映射。

### PWA 独立应用、6 套精选视觉主题与全局字号调节
- **标准 PWA 支持**：内置多尺寸桌面/移动端图标、随当前视觉主题实时同步的移动端状态栏 `theme-color` 与安全静态资源 Service Worker（严格旁路 `/api/*`、SSE 与 WebSocket，服务升级重启时自动轮询恢复）。
- **6 套精选主题 + 3 档全局字号与排版密度**：4 套深色主题（**曜石黑 Obsidian**、**子夜流光 Midnight Glass**、**工业机架 Rack Industrial**、**翠影碳黑 Emerald Carbon**）与 2 套浅色主题（**工作室白 Studio Light**、**温润纸感 Warm Paper**）；内置 **紧凑 (`13px`) / 标准推荐 (`14px` 默认) / 舒展大字 (`15px`)** 三档全局字号集中控制（全站严守 `>= 12px` 字号下限，自动联动 ECharts 图表与 xterm 终端字号）以及「舒展标准 / 高密度紧凑」表格间距切换，在顶栏主题菜单、`⌘K` 命令面板与设置中心一键实时生效并持久化至账户偏好。

---

## 快速开始

### 方式一：Docker Compose 一键部署（推荐）

仓库内置开箱即用的 [`docker-compose.yml`](./docker-compose.yml) 与环境变量模板 [`.env.example`](./.env.example)（官方多架构镜像同时支持 `linux/amd64` 与 `linux/arm64`）：

```bash
mkdir -p pve-dash && cd pve-dash
curl -fsSLO https://raw.githubusercontent.com/jianxcao/pve-dash/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/jianxcao/pve-dash/main/.env.example -o .env

# 启动服务（数据与自动生成的加密主密钥持久化在 ./data）
docker compose up -d
```

也可直接使用单条 `docker run` 启动：

```bash
docker run -d \
  --name pve-dash \
  --restart unless-stopped \
  -p 8080:8080 \
  -e TZ=Asia/Shanghai \
  -v "$(pwd)/data:/app/data" \
  ghcr.io/jianxcao/pve-dash:latest
```

### 方式二：下载预编译单二进制（GitHub Releases）

前往 [GitHub Releases](https://github.com/jianxcao/pve-dash/releases) 下载对应平台（`linux_amd64` / `linux_arm64` / `darwin_arm64` / `darwin_amd64` / `windows_amd64`）压缩包，解压后零外部依赖直接运行：

```bash
# 查看构建版本信息
./pve-dash --version

# 启动服务（默认监听 :8080，数据保存在 ./data）
PVE_DASH_LISTEN=:8080 PVE_DASH_DATA_DIR=./data ./pve-dash
```

### 方式三：从源码编译（Go 1.24+ & Node.js 22+）

```bash
git clone https://github.com/jianxcao/pve-dash.git
cd pve-dash

# 1. 构建前端产物（自动输出至 web/dist 供 Go embed.FS 打包）
cd web && npm ci && npm run build && cd ..

# 2. 编译纯静态 Go 单二进制（可选注入版本号）
CGO_ENABLED=0 go build -trimpath \
  -ldflags "-s -w -X github.com/jianxcao/pve-dash/internal/version.Version=v1.0.0" \
  -o bin/pve-dash ./cmd/pve-dash

# 3. 启动服务
PVE_DASH_LISTEN=:8080 PVE_DASH_DATA_DIR=./data ./bin/pve-dash
```

启动后浏览器访问 **`http://localhost:8080`**，首次打开将引导创建本地管理员账号，随后即可在「实例连接管理」中接入你的 Proxmox VE 节点或集群。

### 前后端分离开发模式

```bash
# 终端 1：启动 Go 后端（开启开发期 localhost CORS）
PVE_DASH_LISTEN=:8080 PVE_DASH_DATA_DIR=./data PVE_DASH_DEV_CORS=true go run ./cmd/pve-dash

# 终端 2：启动 Vite 前端热更新（自动代理 /api 至 :8080）
cd web && npm run dev
```

---

## 忘记密码 / 丢失 2FA 密钥应急恢复（后端 CLI）

当管理员忘记登录密码，或更换手机导致 TOTP 验证器、WebAuthn 通行密钥及一次性恢复码全部不可用时，可直接通过宿主机终端执行 `pve-dash` 内置的应急恢复 CLI：

- **在线免停机恢复**：依托 SQLite WAL 并发读写机制，所有 CLI 命令均可**在 PVE Dash 服务正常运行期间直接在线执行**，无需停止容器或后台进程。
- **实时吊销与安全审计**：执行 `--reset-mfa` 或 `--reset-password` 后，系统会自动递增该账号的 `token_version`、立即吊销全部历史登录会话，并写入本地安全审计日志（`cli.mfa_reset` / `cli.password_reset`）。
- **防进程列表泄露**：禁止在命令行参数中直接拼接明文密码（避免 `ps aux` 或 Shell 历史泄露）；默认由 `crypto/rand` 生成 18 位高强度随机密码并仅在终端输出一次，也支持配合 `--password-stdin` 从标准输入安全传入新密码（`8–128` 字节）。

### Docker / Docker Compose 环境

容器镜像已将 `pve-dash` 注册至系统 `PATH` 并默认指向 `PVE_DASH_DATA_DIR=/app/data`：

```bash
# 1. 查看面板全部账号、角色、启用状态与 2FA 绑定状态
docker exec pve-dash pve-dash --list-users

# 2. 丢失 2FA 设备时：清空指定账号的 TOTP、通行密钥 (Passkey) 与恢复码
docker exec pve-dash pve-dash --reset-mfa admin

# 3a. 忘记密码（推荐）：重置密码并自动生成 18 位安全随机密码（同时自动解除账号禁用状态）
docker exec pve-dash pve-dash --reset-password admin

# 3b. 忘记密码（指定新密码）：通过标准输入安全注入密码（注意添加 -i 保持 stdin 连通）
printf '%s\n' 'YourNewStrongPass#2026' | docker exec -i pve-dash pve-dash --reset-password admin --password-stdin
```

### 单二进制 / 源码编译环境

请确保 `PVE_DASH_DATA_DIR` 与运行中服务的数据库目录一致（默认 `./data`；若直接下载 Release 二进制请将 `./bin/pve-dash` 替换为 `./pve-dash`）：

```bash
# 1. 查看面板账号列表（若提示“数据库中尚无用户”，请核对 PVE_DASH_DATA_DIR 路径）
PVE_DASH_DATA_DIR=./data ./bin/pve-dash --list-users

# 2. 重置指定账号的全部双因素认证（TOTP / 通行密钥 / 恢复码）
PVE_DASH_DATA_DIR=./data ./bin/pve-dash --reset-mfa admin

# 3a. 重置密码并输出一次性 18 位随机临时密码
PVE_DASH_DATA_DIR=./data ./bin/pve-dash --reset-password admin

# 3b. 从标准输入读取指定新密码完成重置
printf '%s\n' 'YourNewStrongPass#2026' | PVE_DASH_DATA_DIR=./data ./bin/pve-dash --reset-password admin --password-stdin
```

---

## 环境变量配置

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PVE_DASH_LISTEN` | `:8080` | HTTP 服务监听地址（如 `127.0.0.1:8080` 或 `:8080`） |
| `PVE_DASH_DATA_DIR` | `./data` | SQLite 数据库（`pve-dash.db`）与自动生成密钥文件的持久化目录（Docker 内默认为 `/app/data`） |
| `PVE_DASH_MASTER_KEY` | 自动生成 | 32 字节或 64 位十六进制主密钥（`openssl rand -hex 32`），用于 AES-256-GCM 加密 PVE 凭据、TOTP 密钥与通知通道密钥 |
| `PVE_DASH_JWT_SECRET` | 自动生成 | 32 字节或 64 位十六进制密钥，用于签发会话 JWT 与二步验证挑战令牌 |
| `PVE_DASH_PUBLIC_URL` | 空 | 外部 HTTPS 访问地址（如 `https://pve-dash.example.com`；用于 CSRF/WS 源校验、WebAuthn Passkey RP 域名推导并自动启用 `Secure` Cookie） |
| `PVE_DASH_SECURE_COOKIE` | `false` | 显式启用 `Secure` Cookie 属性 |
| `PVE_DASH_TRUST_PROXY` | `false` | 部署在受信任反向代理（Nginx / Caddy / Traefik）后时设为 `true`，按 `X-Forwarded-For` / `X-Forwarded-Proto` 解析真实来源 IP 与 HTTPS 状态 |
| `PVE_DASH_READ_ONLY` | `false` | 设为 `true` 时服务端强制拒绝所有写操作（全局只读巡检模式） |
| `PVE_DASH_DEV_CORS` | `false` | 本地前后端分离调试时允许 `localhost` 跨域（生产环境切勿开启） |

> **提示（可选 SSH 硬件遥测）**：仅配置 PVE API Token 即可使用 95%+ 功能；若希望采集宿主机 GPU 实时频段/功耗（`intel_gpu_top`）、详细传感器及全部硬盘完整 SMART 指标，可在「实例连接管理」中填写免密登录的 `SSH Host`（支持 `pve1`、`root@198.51.100.10:2222` 或 `root@[2001:db8::1]:22`；Docker 部署时可按需只读挂载 `~/.ssh:/root/.ssh:ro`）。

---

## 技术栈与项目结构

```text
pve-dash/
├── .github/workflows/     # GitHub Actions 自动化流水线（ci.yml 竞态测试与构建校验 / release.yml 多架构打包与 GHCR 发布）
├── Dockerfile             # 多阶段多架构（linux/amd64, linux/arm64）容器构建定义
├── docker-compose.yml     # 开箱即用的 Docker Compose 编排文件
├── .env.example           # 环境变量配置模板
├── cmd/pve-dash/          # Go 主入口与在线应急恢复 CLI（支持 --version / --list-users / --reset-mfa / --reset-password）
├── internal/
│   ├── api/               # chi 路由、CSRF/RBAC 鉴权守卫、2FA 接口、统一错误映射与按领域拆分的处理器
│   ├── config/            # 环境变量加载与主密钥自动管理
│   ├── crypto/            # Argon2id 密码哈希、AES-256-GCM 凭据加密、TLS 指纹计算
│   ├── pve/               # 多端点 Failover 客户端、连接池、待机安全硬件探针、控制台 WS 代理
│   ├── service/           # 多集群单飞聚合器、Passkey/TOTP/离线二维码认证服务、阈值告警与异步事件通知引擎
│   ├── store/             # 纯 Go SQLite（modernc.org/sqlite）WAL 读写分离存储层
│   └── version/           # 构建版本号、Commit 与编译时间元数据注入
├── web/                   # React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui 前端
│   ├── embed.go           # //go:embed all:dist 单二进制嵌入
│   ├── public/            # Web App Manifest、多尺寸 PWA 图标与安全静态缓存 Service Worker (sw.js)
│   └── src/
│       ├── components/    # 布局、双模式侧栏、命令面板、按需 ECharts、移动端增强 noVNC/xterm、硬件与三级防火墙
│       ├── features/      # 按路由懒加载的模块化业务域（总览 / 计算 / 节点 / 存储 / 备份 / 治理 / 告警与订阅 / 控制台 / 实例 / 审计 / 设置与 2FA）
│       ├── hooks/         # 跨页共享集群范围选择、RBAC 控制台启动器与响应式媒体查询 Hooks
│       ├── lib/           # 模块化 HTTP/XHR 自动续期客户端、WebAuthn 助手、SSE 切片订阅流、主题体系、能力矩阵
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
- [x] **Phase 5（统一通知、双重验证、PWA 与容器化发布）**：`jianxcao/notify` 深度集成与 8 细项运维/安全事件订阅、WebAuthn 通行密钥（Touch ID / Bitwarden）+ 离线二维码 TOTP 双重验证与应急恢复码、完整 PWA 与移动端 VNC/终端软键盘适配、多架构 Docker（GHCR）与 GitHub Releases 自动化构建发布

---

## 设计与架构文档

| 序号 | 文档 | 内容概要 |
| :--- | :--- | :--- |
| 01 | [深度技术与生态调研报告](./docs/01-research-report.md) | PVE API 边界实证、7.4→8.x→9.x 版本差异、noVNC/xterm 协议与竞品对标 |
| 02 | [产品需求文档 (PRD)](./docs/02-prd.md) | 全量功能清单、多 PVE 治理逻辑与分阶段演进路线 |
| 03 | [系统架构与 Go 后端设计](./docs/03-architecture-and-backend-design.md) | 连接池与 Failover、能力矩阵、WebSocket 代理、SSE 遥测与安全方案 |
| 04 | [前端架构与 UI/UX 设计规范](./docs/04-frontend-and-ui-design.md) | 令牌架构、信息架构、核心页面交互与响应式 PWA 设计规范 |

---

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源，欢迎提交 Issue 与 Pull Request。
