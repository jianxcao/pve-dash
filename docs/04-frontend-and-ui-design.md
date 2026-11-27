# PVE Dash 前端架构、UI/UX 设计规范与移动端 App 方案

> **版本**：v1.0  
> **日期**：2026-11-26  
> **设计源资产**：本方案基于项目设计技能（`ui-ux-pro-max` + `design-system` + `ui-styling`）生成的源资产进行架构级深化：  
> - 主规范：[design-system/pve-dash/MASTER.md](../design-system/pve-dash/MASTER.md)  
> - W3C DTCG 令牌：[design-system/pve-dash/tokens.json](../design-system/pve-dash/tokens.json)  
> - CSS 变量表：[design-system/pve-dash/tokens.css](../design-system/pve-dash/tokens.css)  
> - 静态预览：[design-system/pve-dash/preview.html](../design-system/pve-dash/preview.html)  
> - 页面覆写：[overview.md](../design-system/pve-dash/pages/overview.md) · [guest-detail.md](../design-system/pve-dash/pages/guest-detail.md) · [console.md](../design-system/pve-dash/pages/console.md)

---

## 1. 设计哲学：告别 ExtJS，打造「精密暗黑基础设施控制平面」

### 1.1 针对 PVE 原生 UI 的五大体验重构

| 原生 PVE ExtJS 顽疾 | PVE Dash 的重构方案 |
| :--- | :--- |
| 左侧资源树过深，找一台跨节点 VM 需层层展开 | **“全局功能导航 + 可切换资源树 + `Cmd+K` 全局瞬搜”** 三位一体，任何机器 2 秒直达 |
| 弹窗套弹窗，创建虚拟机连续跳 8 个 Tab | **“快速模式（3 步预设）↔ 专家模式（全参数）”** 双态向导；所有编辑改用宽屏右侧抽屉或无刷新表单 |
| 视觉刺眼、数据对齐混乱、实时数字抖动 | **暗黑优先（Dark-First）+ 浅色双主题**，指标全部采用 `Fira Code` + `tabular-nums` 等宽对齐不抖动 |
| 底部任务栏杂乱、报错难看清 | **可折叠全局任务抽屉（32px 迷你状态条 ↔ 实时日志面板）**，支持多实例过滤与一键中止 |
| 手机浏览器彻底崩坏 | **Mobile-First 响应式布局 + 底部 5-Tab 导航 + 终端虚拟快捷键栏**，并平滑封装为 Capacitor 原生 App |

### 1.2 对自动生成设计资产的工程化裁剪说明
`ui-ux-pro-max` 生成的 `MASTER.md` 确立了极具辨识度的基调：**深邃 Slate 暗黑画布（`#0F172A` / `#1B2336`）+ 翡翠状态绿（`#22C55E`）+ `Fira Code` / `Fira Sans` 字体 + `8/10` 高密度 Dashboard 间距体系**。  
结合基础设施运维工具的专业属性，我们在落地时做出 3 项理性优化：
1. **克制使用 Glassmorphism**：数据表格、硬件表单、监控卡片全部采用**清晰实色层级背景 + 1px 精致边框**保证极致可读性与滚动性能；仅在顶部吸顶栏、`Cmd+K` 命令面板与弹窗遮罩上使用轻量毛玻璃（`backdrop-filter: blur(8px)`）。
2. **禁止营销/装饰特效干扰运维**：禁用 Glitch、扫描线、大面积霓虹发光等干扰监控判读的效果；全部过渡动画控制在 `150–250ms`，严格响应 `prefers-reduced-motion`。
3. **补全 Light Mode 浅色主题与全套基础设施状态语义色**：确保白昼机房或偏好浅色模式的用户同样拥有 ≥ 4.5:1 对比度。

---

## 2. 三层设计令牌体系（Primitive → Semantic → Component）

遵循 `design-system` 技能的三层令牌规范，**所有组件严禁硬编码 Hex 色值**，全部引用语义与组件 CSS 变量，通过 Tailwind CSS v4 `@theme inline` 映射。

### 2.1 语义色彩令牌（Dark 优先 + Light 完整配对）

| 语义角色 | CSS 变量 | Dark Mode（默认） | Light Mode | 用途说明 |
| :--- | :--- | :--- | :--- | :--- |
| **主画布背景** | `--color-background` | `#0F172A` (Slate 900) | `#F8FAFC` (Slate 50) | 全局底层背景 |
| **卡片/面板表面** | `--color-card` | `#1B2336` | `#FFFFFF` | 监控卡、表格容器、侧边栏 |
| **次级抬升/悬停层** | `--color-muted` | `#272F42` | `#F1F5F9` | 表头、输入背景、Hover 行 |
| **主强调 / 在线行动色** | `--color-accent` | `#22C55E` (Emerald 500) | `#16A34A` (Green 600) | 主 CTA、开机/健康状态 |
| **主操作交互蓝** | `--color-info` | `#3B82F6` (Blue 500) | `#2563EB` (Blue 600) | 选中态、迁移中、链接与图表主线 |
| **主文本** | `--color-foreground` | `#F8FAFC` | `#0F172A` | 标题、正文、关键指标（对比度 > 13:1） |
| **次级/辅助文本** | `--color-muted-foreground` | `#94A3B8` | `#475569` | 字段标签、时间戳、次要说明（对比度 ≥ 5.5:1） |
| **边框与分隔线** | `--color-border` | `#334155` / `#475569` | `#CBD5E1` | 1px 清晰轮廓与表格分割线 |
| **危险 / 停止异常** | `--color-destructive` | `#EF4444` (Red 500) | `#DC2626` (Red 600) | 销毁、强停、离线、Ceph ERR |
| **警告 / 挂起 / Pending** | `--color-warning` | `#F59E0B` (Amber 500) | `#D97706` (Amber 600) | 暂停、待重启生效变更、高水位警戒、Ceph WARN |
| **已停止 / 中性离线** | `--color-stopped` | `#64748B` (Slate 500) | `#94A3B8` | 已关机 VM/LXC |
| **终端专用纯暗背景** | `--color-console-bg` | `#020617` (Slate 950) | `#020617` | xterm.js / noVNC 控制台恒定深色底 |

> **无障碍硬性约束**：遵循 `ui-ux-pro-max` 规范，**绝不仅凭颜色传递状态**。每个状态徽章必须同时包含「图标/形状指示器 + 中文/英文状态词」（如 `● 运行中`、`■ 已停止`、`▲ 待重启`、`✕ 离线`）。

### 2.2 字体与数据排版规范

- **等宽/标题与指标字体**：`--font-heading: "Fira Code", "JetBrains Mono", ui-monospace, monospace`
  - 所有 **VMID、IP 地址、MAC、CPU%、内存容量、磁盘字节、UPID、时间计数** 必须使用等宽字体并声明 `font-variant-numeric: tabular-nums`，杜绝实时刷新时列宽左右跳动。
- **界面正文与中文回退**：`--font-body: "Fira Sans", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`
- **字号层级（高密度 Dashboard 标尺）**：
  - 页面标题：`20px / 600` (`1.25rem`)
  - 卡片 KPI 大数字：`24px–28px / 700`（等宽）
  - 区块标题：`15px / 600`
  - 正文与表格单元格：`13px–14px / 400`（移动端表单输入框固定 ≥ `16px` 防止 iOS 自动放大页面！）
  - 辅助标签/徽章：`12px / 500`

### 2.3 间距与图标规范

- **密度 8/10 间距体系（源自 `MASTER.md`）**：`--space-xs: 2px` · `--space-sm: 4px` · `--space-md: 8px` · `--space-lg: 12px` · `--space-xl: 16px` · `--space-2xl: 24px` · `--space-3xl: 32px`
- **图标体系**：全站统一使用 **Lucide Icons**（`lucide-react` / `lucide-vue-next`）线性 SVG（默认 `strokeWidth={1.75}`，尺寸 `16px/18px/20px`），**严禁使用 Emoji 替代界面结构图标**。
- **移动端触控安全**：遵循 `pro-rules.md`，在 Capacitor iOS 上按钮触控热区 ≥ `44×44pt`，Android ≥ `48×48dp`，相邻可点击按钮间距 ≥ `8px`，固定顶栏与底栏完整适配 `env(safe-area-inset-top/bottom)`。

---

## 3. 全新信息架构（IA）与自适应布局

### 3.1 桌面端全局工作区骨架（≥ 1024px）

```text
+---------------------------------------------------------------------------------------------------+
| [Logo PVE Dash] [实例切换: 全部实例 (3) ▾]   [🔍 搜索 VM/节点/IP/命令... ⌘K]   [⚡任务 2] [🔔] [☀/🌙] [👤] |  <- 48px 吸顶顶栏
+-------------------------+-------------------------------------------------------------------------+
| 视图模式: [功能] [树状]  | 面包屑: 生产集群 (PVE 9.1) / pve-node-01 / VM 102 (k8s-master-01)          |
|                         |-------------------------------------------------------------------------|
| ▸ 全局总览               |                                                                         |
| ▸ 虚拟机与容器 (42)      |                                                                         |
| ▸ 节点列表 (6)           |                         主内容工作区 (Fluid 自适应)                       |
| ▸ 存储中心 (14)          |                     (支持 Bento 监控网格 / 虚拟滚动表格 /                  |
| ▸ 网络与 SDN             |                      硬件配置表单 / 多标签全屏控制台)                      |
| ▸ Ceph 存储              |                                                                         |
| ▸ 备份与 HA              |                                                                         |
| ▸ 防火墙                 |                                                                         |
| ▸ 权限与资源池           |                                                                         |
| ──────────              |                                                                         |
| ▸ 实例连接管理           |                                                                         |
| ▸ 告警与审计             |                                                                         |
| ▸ 系统设置               |                                                                         |
+-------------------------+-------------------------------------------------------------------------+
| ▲ 运行中任务 (2): [克隆 VM 108 64% ███░░] [备份 CT 201 92% ████░]            最近完成: 12 · 点击展开 |  <- 32px 可折叠任务栏
+---------------------------------------------------------------------------------------------------+
```

**左侧导航「双模式切换」亮点**：
- **功能视角（默认）**：按运维目标直接看“全部 VM/LXC”、“全部节点”、“全部存储”，摆脱跨集群来回点树的痛苦。
- **经典资源树视角（一键切换）**：保留 `Instance → Node → VM / LXC / Storage` 树形结构，照顾资深 PVE 管理员的直觉，并记住用户上次选择。

### 3.2 移动端自适应骨架（< 768px Web & Capacitor App）

```text
+-----------------------------------+  <- Safe Area Top
| [≡] 全部实例 (3) ▾    [🔍] [⚡1]  |  <- 52px 顶栏
+-----------------------------------+
|                                   |
|  主内容区（卡片流布局，无横向溢出） |
|  ┌─────────────────────────────┐  |
|  │ ● 102 · k8s-master-01  [>_] │  |
|  │ 生产集群 · node-01 · 4C 8G  │  |
|  │ CPU 24% ██░░  RAM 61% ████░ │  |
|  └─────────────────────────────┘  |
|                                   |
+-----------------------------------+
| [总览] [计算] [节点] [存储] [更多] |  <- 56px 底部 Tab + Safe Area Bottom
+-----------------------------------+
```

---

## 4. 六大核心页面交互与线框规范

### 4.1 页面 1：多集群全局总览（Overview）
- **顶部 4 枚 KPI 概览卡**（带实时更新时间戳与手动暂停/刷新按钮）：
  1. **集群与节点**：`6 / 6 在线`（若有失联实例，显示醒目琥珀/红色离线角标与“重试”按钮）
  2. **计算实例**：`28 运行中 · 14 已停止`（区分 QEMU / LXC 小图标计数）
  3. **聚合 CPU / 内存水位**：环形/条形进度条 + 精确数值（如 `34.2% · 128 vCPU`、`186 / 384 GiB`）
  4. **聚合存储与健康**：总容量占用 + Ceph 健康胶囊（若有 Ceph）+ 活跃告警数
- **实例矩阵卡片区**：每个 PVE 实例一张结构化卡片，直接呈现版本号标签（如 `PVE 9.1`、`PVE 8.4`）、Quorum 状态、各节点迷你负载条；离线实例灰度显示并给出明确断连原因（如“连接超时 3s”或“证书指纹不匹配”）。
- **实时趋势与 Top N 热点**：左侧为可切换实例的实时流式区域图（ECharts Canvas，支持 Pause/Resume 满足无障碍要求），右侧为 Top 5 CPU/内存消耗 Guest，点击直达详情或终端。

### 4.2 页面 2：虚拟机与容器统一列表（Compute Inventory）
- **顶部高效工具栏**：实例筛选 + 节点筛选 + 类型（全部 / VM / LXC / 模板）+ 状态 + 标签多选 + 搜索框 + 右侧主 CTA `「+ 创建虚拟机 / 容器」`。
- **高性能数据表格**（`@tanstack/react-table` + `@tanstack/react-virtual`）：
  - 列：勾选框 · VMID（等宽）· 名称与标签 · 所属实例/节点 · 类型徽章 · 状态（图标+文字）· IP 地址（一键复制）· CPU 迷你条 · 内存迷你条 · 运行时长 · 快捷操作（`[控制台]` `[开机/关机]` `[更多 ⋯]`）。
- **批量操作浮条**：勾选多行后底部浮出操作条：批量启动、批量优雅关机、批量打标签、批量迁移、批量立即备份。

### 4.3 页面 3：VM / LXC 详情页（Guest Detail）
- **吸顶资源操作头**：
  - 左侧：图标 + VMID + 名称 + 状态徽章 + 版本/所在实例节点标签 + 运行时长 + IP（点击复制）
  - 右侧：**主按钮「控制台 ▾」**（默认点击直接打开 noVNC 或 xterm，下拉选 VNC / 串口 / SPICE `.vv`）+ 电源动作组（启动/关机/重启/强制停止下拉）+ 更多（克隆/迁移/远程迁移/转模板/销毁）
- **二级水平 Tab 导航（按能力矩阵动态裁剪）**：
  - `概览监控`（实时状态 + RRD 历史图表 + Guest Agent 网卡/文件系统信息 + 备注 Markdown 编辑）
  - `硬件 / 资源`（清晰分组列表，**若某项存在 `pending` 待重启生效更改，行内直接显示 `当前值 → 新值 [待重启生效]` 琥珀色标记与一键撤销按钮**；磁盘行直接带「扩容」「移动存储」「分离」快捷操作）
  - `Cloud-Init`（仅 QEMU：表单化编辑 + 一键重新生成镜像）
  - `快照`（可视化树状结构，清晰标注当前 `You are here`，一键创建/回滚/删快照）
  - `备份`（列表 + 立即备份 + 一键恢复向导 + 文件级浏览）
  - `防火墙`（开关 + 拖拽排序规则表 + 实时日志）
  - `复制` / `选项` / `任务历史` / `原始配置（逃生舱）`

### 4.4 页面 4：双模式创建向导（Create Guest Wizard）
彻底改造官方 8 步弹窗：
- **模式 A：快速模式（默认，3 步完成 90% 日常建机）**：
  - Step 1：**选择目标与来源**（选实例/节点 → 从常用模板克隆、选择 ISO/CT 模板、或 PVE 9.1+ 直接输入 OCI 镜像如 `nginx:alpine`）
  - Step 2：**规格预设与网络**（一键选预设如 `小规格 2C2G` / `标准 4C8G` / `大内存 8C16G` 或滑块微调 + 选存储池 + 选网桥 + 可选填 Cloud-Init 用户名/SSH Key）
  - Step 3：**配置摘要预览与创建**（勾选“创建后自动启动”，提交后底部任务栏实时追踪进度，完成弹 Toast 一键进控制台）
- **模式 B：专家模式（右上角一键切换）**：
  - 左侧纵向步骤目录，无刷新展开 PVE 全部参数（BIOS/OVMF/vTPM、CPU Flags/NUMA、SCSI 控制器/Cache/Discard/IOThread、多网卡多队列、PCI 直通、Guest Agent 等），**表单验证失败时绝不清空用户输入**（严格遵守 `console.md` 覆写规则）。

### 4.5 页面 5：多标签全屏控制台工作台（Console Workspace）
PVE Dash 最杀手级的生产力体验：
- **支持浏览器内多标签与左右分屏**：可以一边开 `node-01` 宿主机 `xterm.js` 查日志，一边并排看 `VM 102` 的 `noVNC` 装系统，再开第三个标签操作 `LXC 205`！
- **极简顶部工具条（36px，纯暗 `#020617`）**：
  - 控制台标签页列表（显示 `实例/名称` + 连接绿点 + 关闭按钮）
  - 快捷动作：发送快捷键（`Ctrl+Alt+Del` / `Ctrl+Alt+F1..F7`）、剪贴板文本粘贴输入（解决 noVNC 无法直接粘贴密码的痛点！）、缩放适应模式、截图保存、重连、分屏/全屏切换。
- **移动端专属悬浮快捷键栏（xterm.js 底部吸盘，位于软键盘上方）**：
  - 横向可滑动快捷按键：`ESC` · `TAB` · `CTRL`（粘滞切换）· `ALT` · `↑` `↓` `←` `→` · `|` · `/` · `-` · `~` · `粘贴` · `收起键盘`。

### 4.6 页面 6：存储、节点磁盘与网络配置
- **磁盘与 SMART 面板**：一目了然展示型号、容量、类型（NVMe/SSD/HDD）、温度、磨损百分比（Wearout）、健康状态徽章，点击抽屉展开完整 SMART 原始属性。
- **上传与下载队列浮窗**：支持拖放多个 ISO 同时上传（或填 URL 让 PVE 后台拉取），右下角进度条实时更新，切换页面不中断。
- **节点网络配置安全机制**：新增/编辑 Bridge/Bond/VLAN 后进入「待应用改动队列」，顶部展示高亮 Diff 提示栏并提供「应用网络配置」与「撤销改动」，防止改错网卡导致宿主机失联。

---

## 5. 关键前端工程架构与 Schema 动态表单引擎

### 5.1 推荐前端技术栈（React 主推 / Vue 等价对照）

| 能力层 | React 19 主推方案 | Vue 3 等价替代方案 |
| :--- | :--- | :--- |
| 构建与语言 | Vite 6 + TypeScript 5.8 (Strict) | Vite 6 + TypeScript 5.8 (Strict) |
| 路由 | `@tanstack/react-router`（类型安全路由 + 搜索参数状态化） | `vue-router` v4 |
| UI 组件基座 | **shadcn/ui (Radix UI)** + Tailwind CSS v4 | `shadcn-vue` (Reka UI) + Tailwind CSS v4 |
| 服务端状态 | `@tanstack/react-query` v5 + 自定义 SSE 缓存同步器 | `@tanstack/vue-query` v5 |
| 客户端全局状态 | `zustand`（控制台多标签状态、侧栏模式、任务抽屉） | `pinia` |
| 表单与校验 | `react-hook-form` + `zod` | `vee-validate` + `zod` |
| 大数据表格 | `@tanstack/react-table` + `@tanstack/react-virtual` | `@tanstack/vue-table` + `@tanstack/vue-virtual` |
| 命令面板 | `cmdk`（集成于 shadcn Command） | `reka-ui` Command |
| 监控图表 | `echarts`（Canvas 渲染，高性能支持万级数据点与缩放） | `echarts` |
| 远程控制台 | `@novnc/novnc` + `@xterm/xterm` (`fit`/`web-links`/`webgl` addons) | 完全相同 |
| 图标 | `lucide-react` | `lucide-vue-next` |
| 跨端移动封装 | `@capacitor/core` + iOS / Android 工程 | 完全相同 |

### 5.2 前端目录结构规划（`web/`）

```text
web/
├── src/
│   ├── app/                    # 路由配置、Providers（Query, Theme, Sidebar, SSE）
│   ├── styles/
│   │   ├── tokens.css          # 同步自 design-system/pve-dash/tokens.css + Light 主题与状态色
│   │   └── globals.css         # Tailwind v4 @theme inline 映射与全局无障碍焦点样式
│   ├── lib/
│   │   ├── api/                # 强类型 API Client（自动附带凭证与 401 无感刷新）
│   │   ├── sse/                # SSE 订阅管理器（断线指数退避重连 + 写入 QueryCache）
│   │   ├── capabilities.ts     # 版本能力判断 Hook（useCapability(instanceId, 'lxcOciImages')）
│   │   └── platform.ts         # 运行环境探测（Web / PWA / Capacitor iOS / Android）
│   ├── components/
│   │   ├── ui/                 # shadcn/ui 原子组件
│   │   ├── layout/             # AppShell, TopBar, DualModeSidebar, MobileTabBar, TaskDrawer
│   │   ├── console/            # ConsoleWorkspace, NoVncViewer, XtermViewer, MobileKeyBar
│   │   ├── charts/             # RealtimeAreaChart, RrdMetricPanel, ResourceBar（带无障碍降级表）
│   │   ├── schema-form/        # 【核心】Schema 驱动动态表单渲染器（应对 PVE 海量配置项）
│   │   └── danger-confirm/     # 高危操作二次名称输入确认弹窗
│   ├── features/               # 按业务域内聚的页面模块
│   │   ├── overview/
│   │   ├── instances/
│   │   ├── compute/            # VM & LXC 列表、详情、硬件、创建向导
│   │   ├── nodes/
│   │   ├── storage/
│   │   ├── network-sdn/
│   │   ├── ceph/
│   │   ├── ha-backup/
│   │   ├── access-pools/
│   │   └── settings-alerts/
│   └── main.tsx
├── capacitor.config.ts         # Phase 5 移动端配置
├── ios/                        # Capacitor 原生 iOS 工程（Phase 5 生成）
└── android/                    # Capacitor 原生 Android 工程（Phase 5 生成）
```

### 5.3 核心利器：Schema-Driven Form（动态表单引擎）

PVE 存在大量“结构高度相似但字段繁多”的配置页（例如 15 种存储后端、5 种 SDN Zone、各类防火墙参数、通知目标配置、虚拟机 30+ 项 Options）。如果手写几十套硬编码表单，维护成本极高。

我们设计一套轻量 **Schema-Driven Form 渲染器**：
- 每类配置用一个声明式 JSON/TS Schema 描述字段名、控件类型（文本/数字带单位/开关/枚举下拉/多选/密钥/动态数组）、校验规则（Zod）、分组（`basic` vs `advanced` 折叠区）以及 **`minVersion`（最低 PVE 版本）**。
- 结合 `tools/schema-sync` 从官方 `apidata.js` 提取的字段说明与约束，能够以 **1/5 的代码量** 覆盖 Phase 3 & Phase 4 绝大部分企业级配置表单，并自动遵循版本能力裁剪！

### 5.4 状态更新与性能保障
- 实时遥测数据通过单一 SSE 通道写入 `TanStack Query` 缓存，仅重渲染变化的行；在 `document.hidden === true`（标签页切后台）时自动暂停图表重绘并通知后端降频。
- 遵循 `ui-ux-pro-max` 指导：不盲目全量套 `React.memo`，仅针对高频刷新的监控行、图表容器和虚拟列表单元格做定向记忆化，列表 `key` 严格使用稳定全局 URN（`{instanceId}:{type}:{node}:{vmid}`）。

---

## 6. Capacitor 移动 App 演进方案（Phase 5 详细设计）

### 6.1 一套代码，双目标构建
- **Web 构建**：`vite build` → 输出至 `web/dist/` → Go 后端 `embed.FS` 打包为单二进制与 Docker 镜像，并附带 `manifest.webmanifest` + Service Worker 支持手机 PWA。
- **App 构建**：`VITE_TARGET=capacitor vite build && npx cap sync` → 静态资源全部**离线内嵌打包进 iOS `.ipa` 与 Android `.apk`**（绝不采用远程套壳 URL，保证启动速度与 App Store 过审）。

### 6.2 App 连接架构与网络层适配
- **服务器切换器（Server Switcher）**：App 首次打开支持添加多个自建 `PVE Dash Go` 服务地址（如“家庭内网”、“公司外网”），登录 Token 存入原生安全密钥库。
- **环境感知 API Client（`src/lib/platform.ts`）**：
  - Web 模式使用相对路径 `/api/v1/...` + `HttpOnly Cookie`；
  - Capacitor 模式读取当前选中的 `serverBaseUrl` + `Authorization: Bearer <token>`（配合 `@capacitor/http` 原生网络栈，彻底规避 WebView CORS 问题）。
- **（远期可选扩展）无后端直连单 PVE 模式**：通过自定义 150 行 Swift/Kotlin Capacitor Plugin 封装原生 TLS TOFU 证书信任与直连 `/api2/json`，满足极简用户不部署 Go 后端的尝鲜需求。

### 6.3 必备原生插件清单

| 能力 | Capacitor 插件 | 业务场景 |
| :--- | :--- | :--- |
| **安全密钥存储** | `capacitor-secure-storage-plugin` / Keychain & Keystore | 加密保存服务端 Token 与 Refresh Token |
| **生物识别应用锁** | `@capgo/capacitor-native-biometric` | 打开 App 或执行销毁/关机前校验 Face ID / 指纹 |
| **触觉反馈** | `@capacitor/haptics` | 电源操作成功、高危确认、终端快捷键按压震动反馈 |
| **原生告警推送** | `@capacitor/push-notifications` | 对接 Go 后端告警引擎（APNs / FCM），点通知直达异常节点/VM 详情页 |
| **状态栏与安全区** | `@capacitor/status-bar` + `@capacitor/keyboard` | 沉浸式暗黑状态栏、软键盘弹起时精准推起 `xterm.js` 终端高度与快捷键条 |
| **网络状态感知** | `@capacitor/network` | 断网/切 5G/切 Tailscale 时自动触发 SSE 与控制台重连 |

### 6.4 移动端交付与 App Store 合规检查清单（源自 `pro-rules.md`）
- [ ] 前端资源全部本地打包，离线状态可正常打开服务器管理页并给出友好断网提示（杜绝苹果 4.2 网页套壳拒审）
- [ ] iOS 触控目标 ≥ `44×44pt`，Android ≥ `48×48dp`，相邻按钮间距 ≥ `8px`
- [ ] 深色与浅色双模式正文对比度 ≥ `4.5:1`，分隔线在双模式下均清晰可辨
- [ ] 顶部刘海/灵动岛与底部手势条完整应用 Safe Area，无内容被遮挡
- [ ] 在 `375px` 小屏与横屏模式下（尤其控制台横屏全屏）均无布局溢出与手势冲突
- [ ] 支持系统 Dynamic Type 动态字号与 `prefers-reduced-motion`
