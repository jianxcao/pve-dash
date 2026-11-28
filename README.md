# PVE Dash

**PVE Dash 是一个可自托管的 Proxmox VE 多集群管理面板。** 你可以在同一页查看多套 PVE 的节点、QEMU 虚拟机和 LXC 容器，找出负载最高的实例，打开它的控制台，或检查它是否已纳入定时备份。

面板可以部署在任何能访问 PVE API 的主机上。一份 Go 程序同时提供 Web 界面和 API，用本地 SQLite 保存面板账号、实例连接和告警配置。虚拟机、磁盘和备份归档仍由各自的 PVE 管理。

[Docker 部署](#docker-部署) · [Docker Compose 部署](#docker-compose-部署) · [接入第一套 PVE](#接入第一套-pve) · [功能说明](#功能说明) · [配置与维护](#配置与维护)

## 关注项目

- ⭐ **收藏项目**　登录 GitHub，在仓库右上角点 **Star**，以后可以从自己的 Stars 列表找到部署说明。[打开项目仓库](https://github.com/jianxcao/pve-dash)
- 🔔 **订阅版本发布**　在仓库右上角选 **Watch → Custom → Releases**，即可收到新版本通知。习惯用阅读器也可以直接订阅更新。[发布记录](https://github.com/jianxcao/pve-dash/releases) · [订阅 Atom](https://github.com/jianxcao/pve-dash/releases.atom)
- **关注作者**　想了解作者的其他自托管工具，可以到 GitHub 主页点 **Follow**。[关注 @jianxcao](https://github.com/jianxcao)

## Docker 部署

准备一台已安装 Docker 的主机，确保容器能访问 PVE 的 HTTPS 地址（通常是 `8006` 端口）。下面两种部署方式任选一种。镜像 `jianxcao/pve-dash` 支持 `linux/amd64` 和 `linux/arm64`。[Docker Hub 镜像与标签](https://hub.docker.com/r/jianxcao/pve-dash/tags)

在准备长期保存数据的目录执行以下命令。`8080:8080` 左边是宿主机端口，如果已被占用，可以改为 `18080:8080`。

```bash
mkdir -p pve-dash/data
cd pve-dash

docker run -d \
  --name pve-dash \
  --restart unless-stopped \
  -p 8080:8080 \
  -e TZ=Asia/Shanghai \
  -v "$PWD/data:/app/data" \
  jianxcao/pve-dash:latest
```

浏览器打开 `http://localhost:8080`。从其他设备访问时，把 `localhost` 换成部署主机的 IP 或域名。以下命令可在宿主机检查面板是否已启动，健康接口应返回 `"ok": true`。

```bash
curl -fsS http://127.0.0.1:8080/healthz
docker logs --tail 50 pve-dash
```

## Docker Compose 部署

使用 Docker 和 Compose 插件（`docker compose`）。在新目录下载仓库的编排文件和配置模板。已有项目源码时，可在仓库根目录复制 `.env.example` 为 `.env`，直接执行启动步骤。[编排文件](./docker-compose.yml) · [配置模板](./.env.example)

```bash
mkdir -p pve-dash/data
cd pve-dash
curl -fsSLO https://raw.githubusercontent.com/jianxcao/pve-dash/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/jianxcao/pve-dash/main/.env.example -o .env
```

默认访问端口是 `8080`。如需更换，先编辑 `.env`，例如设为 `PVE_DASH_PORT=18080`。然后在 `docker-compose.yml` 所在目录启动服务。

```bash
docker compose up -d
docker compose ps
docker compose logs --tail 50 pve-dash
```

浏览器打开 `http://部署主机IP:8080`，使用自定义端口时将 `8080` 替换为实际值。容器内的服务和健康检查始终使用 `8080`，数据库与自动生成的密钥保存在编排文件旁的 `./data/`。

## 接入第一套 PVE

1. **创建面板管理员。** 首次打开页面的人可以创建管理员，请先在受信任的网络中完成初始化，设置 PVE Dash 的本地用户名和密码。首次初始化和添加实例都需要写权限，此时请保持 `PVE_DASH_READ_ONLY=false`。
2. **添加连接。** 在侧栏打开「实例连接管理 → 添加 PVE 实例」，填写名称和节点地址，例如 `https://pve1.example.com:8006`。同一集群的其他节点可作为备用端点，数字越小越优先。另一套独立集群应单独添加为一个实例。
3. **填写 PVE 凭据。** 选择「API Token」并填入完整 Token ID（如 `dash@pve!panel`）和 Token Secret。也可以选择「账号密码 (Ticket)」或「Token + 账密回退」。面板账号决定谁能在 Dash 中发起操作，PVE 凭据的权限决定目标集群允许执行哪些操作。
4. **测试并保存。** 点击「测试连接、探测版本能力并获取 TLS 指纹」。使用默认的 TOFU（首次信任）时，先与节点证书的 SHA-256 指纹核对，再勾选确认并保存。使用受信任 CA 的环境也可选「严格校验」。
5. **确认接入结果。** 回到「全局总览」查看在线节点和资源用量，再打开「虚拟机与容器」核对 VMID 和运行状态。其他集群按相同步骤接入。

## 功能说明

### 多集群总览与任务追踪

- **跨集群巡检。** 总览汇总已接入实例的节点、CPU、内存、存储和高负载 VM/LXC。可从总览进入节点或工作负载详情，也可将侧栏切为资源树，按集群逐层查找。
- **按名称或 VMID 找资源。** 用 `Ctrl+K` 或 `⌘K` 打开全局搜索，定位虚拟机、容器、节点与存储池。
- **跟进耗时任务。** 备份、迁移等 PVE 操作会产生任务 ID（UPID）。在任务抽屉中可以跟踪状态、查看实时日志，并在权限允许时中止任务。

### 虚拟机、容器与控制台

- **创建与日常管理。** 在「虚拟机与容器」按类型、状态筛选 QEMU VM 和 LXC。创建向导支持从 ISO 安装虚拟机、用模板创建容器，也可以克隆已有实例。日常操作包括启停、批量修改标签、加入资源池，以及同一集群内的跨节点迁移。
- **配置与回滚。** 在详情页调整 CPU、内存和磁盘容量，查看等待重启生效的配置。虚拟机支持 Cloud-Init 配置。可以创建、回滚和删除快照，并从历史图表查看 CPU、内存、网络与磁盘 I/O 的变化。
- **浏览器控制台。** 用 noVNC 打开虚拟机图形界面，用 xterm.js 连接容器、已配置的虚拟机串口或管理员宿主机 Shell。控制台支持多标签，切换面板页面可保留连接。手机端提供软键盘输入和 `Ctrl`、`Alt` 等组合键，面板也可安装为 PWA。
- **显示偏好。** 顶栏可切换深浅主题、字号和表格密度，方便在桌面上密集查看资源，或在小屏设备上阅读。

### 节点、网络与集群治理

- **宿主机巡检。** 「节点与硬件」展示 GPU、磁盘、直通设备和可获取的 SMART 健康数据。需要更多温度、频率或功耗指标时，可在实例连接中配置免密 SSH 遥测。可见指标取决于硬件和宿主机已安装的采集工具。
- **节点运维。** 查看系统日志、管理服务、检查 APT 更新与软件源。网络面板可以配置网桥、Bond、VLAN，查看待应用的变更，并选择应用或撤销。
- **治理与高可用。** 管理资源池及集群、节点、VM/LXC 三级防火墙，配置 PCI、USB 等资源映射。可将工作负载加入 HA 保护，查看 PVE 7/8 的 HA 组或 PVE 9 的 HA 规则。节点已配置 ACME 账号和域名时，还可从面板申请或续签证书。

### 存储与工作负载备份

| 要完成的操作 | 面板入口与能力 |
| --- | --- |
| 准备安装介质 | 在「存储中心」浏览存储卷、上传 ISO 或容器模板，也可从 URL 下载或从模板目录拉取。PVE 9.1 及以上可拉取 LXC OCI 镜像。 |
| 检查存储容量与健康 | 在「存储中心」管理目录、NFS、SMB/CIFS、PBS 等存储定义。在「节点与硬件」查看 ZFS 拓扑、LVM/LVM-thin 容量或 Ceph 健康状态。 |
| 立即备份或恢复一台机器 | 从 VM/LXC 详情提交 `vzdump` 备份，给归档添加备注或保护标记。恢复时可指定新的 VMID，覆盖已有 VMID 需要显式确认。 |
| 找出漏备的机器 | 在「备份中心」管理集群定时备份计划，查看哪些 VM/LXC 尚未纳入计划。 |

### 告警、账号与审计

- **阈值告警。** 在「告警中心」为节点离线、CPU 或内存占用、存储容量、温度、SMART 健康度、未覆盖备份等设置规则。可设置超限持续时间、通知冷却和静默截止时间，也可选择在指标恢复时通知。
- **事件订阅。** 单独订阅电源操作、迁移、快照、备份、基础设施变更，以及登录异常和账号权限变更。运维事件可选择仅在失败时推送。通知通道包括飞书、钉钉、企业微信、Telegram、Bark、通用 Webhook 和 Notify。[Notify 项目](https://github.com/jianxcao/notify)
- **多人协作。** 管理员（`admin`）管理连接、账号和宿主机 Shell，运维员（`operator`）按授权操作工作负载，只读用户（`viewer`）查看资源。管理员可在「操作审计日志」查找操作人、目标与执行结果。
- **账号保护。** 本地账号可启用 TOTP 或通行密钥（Passkey）作为第二重验证，并保存一次性恢复码。通行密钥需要通过 HTTPS 域名或本机 `localhost` 访问。管理员可以吊销会话或重置用户的双重验证。

## 配置与维护

### 常用配置

| 设置 | 默认行为 | 何时修改 |
| --- | --- | --- |
| `PVE_DASH_PORT` | Compose 发布宿主机端口 `8080` | 修改 Compose 的外部访问端口。使用 `docker run` 时改 `-p` 左侧端口。 |
| `PVE_DASH_PUBLIC_URL` | 空 | 使用 HTTPS 反向代理时填入实际外部地址，如 `https://dash.example.com`，用于来源校验和 Passkey，并启用 Secure Cookie。代理需支持控制台 WebSocket 和实时事件流（SSE）。 |
| `PVE_DASH_TRUST_PROXY` | `false` | 服务只接受受信任反向代理的流量时可开启，使审计记录使用代理转发的客户端 IP。 |
| `PVE_DASH_READ_ONLY` | `false` | 已完成接入后设为 `true`，可由服务端限制资源变更及交互控制台，适合只读巡检。 |
| `PVE_DASH_MASTER_KEY`、`PVE_DASH_JWT_SECRET` | 留空时在数据目录生成 `.master.key` 和 `.jwt.key` | 分别用于凭据加密和会话签名。需要自行管理密钥时，为两项分别设置独立的 32 字节密钥或 64 位十六进制字符串。 |

Compose 用户修改 `.env` 后执行 `docker compose up -d` 使配置生效。使用 `docker run` 时，用 `-e 变量名=值` 传入应用配置。仓库的编排文件已固定容器内监听地址 `:8080` 和数据目录 `/app/data`。[完整环境变量模板](./.env.example)

### 更新与数据备份

- **Compose 更新。** 在部署目录执行 `docker compose pull`，然后执行 `docker compose up -d`。如需固定版本，把编排文件中 `image:` 的 `latest` 换成已发布的标签。`docker compose down` 可停止并移除服务，绑定挂载的 `./data/` 保留在宿主机。
- **Docker 更新。** 先执行 `docker pull jianxcao/pve-dash:latest`，再依次执行 `docker stop pve-dash` 和 `docker rm pve-dash`。回到原部署目录，使用原端口、环境变量和同一个 `data/` 挂载重新运行上方的 `docker run` 命令。
- **备份整个面板。** 停止面板后，备份整个 `data/` 目录（包括 SQLite 数据库和隐藏密钥文件）再启动。恢复时挂载这份目录。如果自行设置了主密钥和签名密钥，还要单独保管并恢复相同的值。
- **只迁移连接和告警配置。** 管理员可在「系统设置」用独立口令加密导出 PVE 连接、通知通道、告警规则和事件订阅，在目标面板先预检再导入。虚拟机和容器的数据请使用上文的工作负载备份功能。

### 忘记密码或丢失验证设备

在部署主机上执行以下命令。先查出面板用户名，再选择与问题对应的重置命令，将示例中的 `admin` 换成实际账号。两种重置都会吊销该账号的旧会话。

```bash
docker exec pve-dash pve-dash --list-users

# 忘记密码时生成新的随机密码，终端仅显示一次
docker exec pve-dash pve-dash --reset-password admin

# 丢失双重验证设备且恢复码用尽时，清除该账号的双重验证绑定
docker exec pve-dash pve-dash --reset-mfa admin
```

### 二进制与源码运行

可从发布页下载 Linux、macOS 或 Windows 的对应压缩包。解压后执行 `./pve-dash`（Windows 为 `pve-dash.exe`），默认监听 `:8080`，数据写入当前工作目录的 `./data/`。[GitHub Releases](https://github.com/jianxcao/pve-dash/releases)

从源码构建需要 Go 1.24+ 和 Node.js 22。前端资源由 Go 嵌入可执行文件，在仓库根目录依次执行以下命令。

```bash
(cd web && npm ci && npm run build)
mkdir -p bin
CGO_ENABLED=0 go build -trimpath -o bin/pve-dash ./cmd/pve-dash
./bin/pve-dash
```

本地开发时可用 `PVE_DASH_DEV_CORS=true go run ./cmd/pve-dash` 启动后端，在另一终端进入 `web/` 执行 `npm run dev`。Vite 监听 `5173` 端口，并将 `/api` 代理至本机 `8080`。

## 项目文档与反馈

- 了解设计背景与需求范围。[技术调研](./docs/01-research-report.md) · [产品需求](./docs/02-prd.md)
- 阅读实现与界面设计。[Go 后端架构](./docs/03-architecture-and-backend-design.md) · [前端与交互设计](./docs/04-frontend-and-ui-design.md)
- 报告问题时请附上 PVE 版本、面板版本、部署方式和复现步骤。[提交 Issue](https://github.com/jianxcao/pve-dash/issues)

开源许可采用 [MIT License](./LICENSE)。
