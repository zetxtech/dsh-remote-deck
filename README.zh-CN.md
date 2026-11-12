# Remote Deck · 远程工作台

**给 DeepSeek Harness 的 SSH 工作区插件：一个窗口，本地对话与远程对话并存。**

把任意一台 SSH 机器接进 DSH，把远端目录变成普通工作区。在这个工作区里，模型读写文件、
搜索、执行命令、开终端、转发端口，全部发生在远端；界面还是你现在这个窗口。

- **对话优先**：只有一个状态胶囊、几处标识；控制台点开才出现，不抢主界面。
- **多机并行**：每台机器一个颜色身份、一条独立连接、一组自己的工作区与会话。
- **远端零安装**：只用 `sshd`——SFTP 读文件、exec 通道跑命令与搜索、PTY 开终端、
  `direct-tcpip` 做端口转发。

## 界面

| 控制台 | 快速面板 |
| --- | --- |
| ![控制台](docs/design/v2/03.png) | ![快速面板](docs/design/v2/01.png) |

| 会话标识 | 添加机器 |
| --- | --- |
| ![会话标识](docs/design/v2/02.png) | ![添加机器](docs/design/v2/05.png) |

| 新建工作区 | 终端与端口 |
| --- | --- |
| ![新建工作区](docs/design/v2/04.png) | ![终端与端口](docs/design/v2/06.png) |

截图由 `docs/design/v2/` 的脱敏设计稿渲染；主机名、地址和路径均为演示数据
（`dev-box`、`203.0.113.10`、`/srv/demo-app`）。

## 能力

| 模块 | 内容 |
| --- | --- |
| 连接 | 多机器、密钥/密码、`~/.ssh/config` 导入、测试连接（系统/延迟）、按机器自动连接（默认关闭，可在对话框/快速面板/控制台切换）、keepalive + 退避重连 |
| 远端文件 | 自己的引导卡 + 侧栏标签页：远端路径、**按类型图标**（软链/设备/未知类型都有默认图标）、**隐藏文件开关**、**Ctrl/Shift 多选**、**多选打包下载**、一次确认的**永久删除**、可取消任务栏、**双击在新标签预览** |
| 设置 | 「设置 → 远端工作台」集中管理终端字体与字号、监控阈值与传输上限 |
| 侧栏终端 | 在远端工作区里，Web 右侧栏的终端直接开**远端 PTY**（`bash -l`），不再是本地 shell |
| 监控 | 头部胶囊下拉显示 CPU、内存与「会话路径顶级目录所在存储体」的剩余容量；任一指标越过阈值时胶囊出现感叹号；刷新间隔、各指标开关与阈值都可在设置里调整 |
| 传输 | 目录可流式打包成 `tar.gz` 下载（默认跳过软链，不跟随、不跨挂载点），文件可上传到当前目录（SFTP 写入）。下载前会预扫描并汇报文件数/体积/不可读项；上传失败可选「跳过 / 跳过该目录 / 停止」；两个方向都有大小上限 |
| 头部胶囊 | 点击展开下拉：当前机器的端口转发（逐行可打开/复制/停止），底部按钮进入该机器的远程开发界面 |
| 跳板机 | 支持 ProxyJump：`[user@]host[:port]`，逗号分隔可串多跳。某一跳若匹配已配置的机器就复用它的凭据，否则回退用目标机自己的密钥 |
| 工作区 | 面包屑浏览、筛选、键盘操作、自定义侧栏名、添加/移除（不删远端目录） |
| 会话标识 | 头部机器胶囊、侧栏彩色徽标、悬停卡远程路径；本地会话保持原样 |
| 控制台 | 机器栏、主机概览、指标、工作区卡片、最近会话、搜索，以及远程文件浏览/下载/本地定位 |
| 终端 | 完整 xterm.js 终端：颜色、光标、全屏程序，键盘/Ctrl 组合/粘贴，重连缓冲 |
| 端口 | 自动发现监听端口、一键转发、持久化、连接恢复后重建 |
| Agent 工具 | `bash` 带 `run_in_background` 起远端后台任务，`remote_job` 查看列表/增量输出/终止，`remote_forward` 申请与管理端口转发 |
| 主题 | 浅色/深色，跟随 DSH 主题 |

## Agent 工具

三个工具把模型接到远端机器上：

| 工具 | 作用 |
| --- | --- |
| `bash` + `run_in_background` | 命令在远端 detach 执行（`setsid`，独立会话），输出写进该作业自己的文件，调用立刻返回作业 id，不再同步等结果 |
| `remote_job` | `list` 列出运行中与已结束的作业（状态、pid、已运行时长）；`output` 读取某个偏移之后的新输出（`wait: true` 一直跟到退出）；`kill` 结束整个进程组；`forget` 清理已结束作业及其远端目录 |
| `remote_forward` | `list` 现有转发；`detect` 发现远端监听端口；`start` 把远端端口转发到 DSH 机器的 `127.0.0.1:<本地端口>`；`stop` 按 id 关闭。由 Agent 创建的转发会记下来源：控制台「端口转发」页标为 `Agent`，会话头部胶囊把当前机器的转发数计在机器名后面 |

当组合里带 DSH 任务注册表时（桌面版默认有），每个远端后台作业会同时登记进去：它出现在会话头部的
任务列表里（可展开看实时输出、两下确认即可停止），照常发完成通知，也能被内置的 `job_list` /
`job_output` / `job_kill` 直接管理。注册表不可用时自动退回只用 `remote_job`。

头部胶囊与 DSH 自带的 chip（智能体团队、标准模式等）同处一行，尺寸也对齐它们：28px 高、
`var(--dsw-radius-sm)` 圆角、12px 字号、中性色与同一套悬停底色——机器身份只由连接圆点的颜色保留。

后台作业的记录只存在 DSH 进程内，**不跨 DSH 重启**：重启后远端进程照旧运行，但作业列表是空的。
需要比 DSH 活得更久的服务，请改用 `tmux` 或 `systemd-run --user` 启动。

## 安装

插件市场上架后（或 npm 发布后）：

```sh
dsh plugin add dsh-remote-deck
```

直接从 GitHub 安装：

```sh
dsh plugin add git+https://github.com/dsh-plugins-cn/dsh-remote-deck.git
```

国内网络可走 GitHub 代理：

```sh
dsh plugin add "git+https://ghproxy.laiyouxi.com/https://github.com/dsh-plugins-cn/dsh-remote-deck.git"
```

从源码安装：

```sh
git clone https://github.com/dsh-plugins-cn/dsh-remote-deck.git
cd dsh-remote-deck
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile desktop
```

装完重启 DSH（或窗口里按 `Ctrl+R`），侧栏底部出现 **SSH** 胶囊，导航里出现 **远程开发**。

插件**没有任何 npm 依赖**：`ssh2` 及其依赖内置在 `vendor/node_modules`，终端资源在
`vendor/xterm`。安装过程不会执行任何构建脚本。

## 从 dsh-remote-ssh 迁移

- 首次加载会把 `<DSH_HOME>/remote-ssh` 的连接复制过来，并**原地复用**已有工作区，
  侧栏位置、会话归属都不变。
- 旧插件在卸载前一直可用；**同一个 profile 不要同时启用两个**（都会接管 `ctx.fs`）。
- 一条命令切换（会先备份 `package.json`，旧插件文件保留以便回滚）：

  ```powershell
  .\install.ps1 -Profile desktop -RemoveOld
  ```

- 一键回滚：

  ```powershell
  .\install.ps1 -Rollback                 # 还原 package.json.bak-before-deck
  ```

插件数据在 `<DSH_HOME>/remote-deck`，重装不丢。

## 原理

```text
┌────────────────────────────── DSH 桌面 ─────────────────────────────────┐
│ 对话 · 侧栏 · Remote Deck 控制台                                        │
│        │ ctx.fs / ctx.shell / ripgrep / tools                           │
│        ▼                                                                │
│ host 半：连接池、工作区 stub、回环 API                                   │
└────────┬────────────────────────────────────────────────────────────────┘
         │ SSH（ssh2）：exec 通道 · SFTP · PTY · 端口转发
         ▼
   远端机器：只需要 sshd（Linux / macOS）
```

远程工作区是 `<DSH_HOME>/remote-deck/workspaces` 下带标记文件的目录，标记记录连接 id 和远端
POSIX 路径。落在标记目录下的路径走 SFTP；命令走带远端 cwd 的 exec 通道；ripgrep 移到远端；
终端是一条 PTY；每个转发是一个本地监听。

### 远端 bash 行为

- 每次调用都会注册成 DSH 后台 job。前台等待默认 10 分钟
  （`DSH_REMOTE_DECK_FOREGROUND_TIMEOUT_MS`）；超时后命令**继续在后台运行**，工具返回 job id，
  **不会杀进程**。用内置 `job_output` / `job_list` 跟进，用 `job_kill` 停止。
- `run_in_background: true` 立即返回 job id，适合常驻服务与长时间验收。
- 远端 stdin 立即关闭：需要交互输入的命令（例如没带 `PGPASSWORD` 的 `psql`）会快速返回自己的
  错误，而不是把整个 turn 挂死。
- 工作目录严格：相对路径相对会话工作区解析；目录不存在直接报错，不再静默回退到 home。
- 每个流输出上限 4 MiB（`DSH_REMOTE_DECK_MAX_OUTPUT_BYTES`），超出标记
  `[output truncated; …]`。
- 停止工具或 `job_kill` 会向记录的远端 pid 发 TERM→KILL；`setsid`/双 fork 脱离的孙进程可能
  残留，这类命令请自己加 `timeout`。

## 安全

- 远端命令在 SSH 主机上执行，不经过本地 DSH 沙箱/审批层；远端账号就是执行边界。对不可信仓库请
  在连接记录里固定 `hostKeyFingerprint`，并使用受限账号。
- 远端工作区暂不支持 `apply_patch`，请用 `edit`/`write`。
- 远程会话把 POSIX 路径路由到 SSH 主机、把盘符/反斜杠路径（`C:\\...`、`E:\\...`）
  路由到本机，远程开发仍然可以使用 Windows 本机文件与资源；两边都可访问，请留意来自
  遥测/远端内容的路径指令。
- 本地回环 API 只对本地 DSH 源反射 CORS；`/local/download` 限定在工作区、Remote Deck 数据与
  attachments 目录。

- 密码、私钥口令存 DSH 凭据库，不写进 `connections.json`。
- 浏览器半通过带回环 token 的本地 HTTP 与 host 通信；终端与转发接口同样受 token 保护。
- 移除工作区只取消本地注册，插件从不删除远端文件。

## 要求

- DSH 桌面版 0.2.x 及以上；Node 20+。
- 远端有 `sshd`，支持 Linux / macOS，远端 shell 为 `bash`。

## 已知限制

- 远端后台作业（`remote_job`）的记录不跨 DSH 重启保留；远端进程本身仍在运行。
- 终端内置 xterm.js（颜色、光标、全屏程序）；如果资产加载被拦截，会回退为纯文本行渲染。
- 界面目前中文优先，英文文案在 v1.1.0。
- `~/.ssh/config` 导入覆盖 Host/HostName/Port/User/IdentityFile/ProxyJump；代理命令与
  known_hosts 固定还没接进连接对话框。
- 自动端口发现依赖 `ss` 或 `netstat`；手动转发不受影响。

## 开发

```sh
npm run check        # 语法 + manifest
npm test             # 解析器单元测试
npm run pack:dry     # 查看发布文件清单
```

脱敏后的设计稿与渲染截图在 `docs/design/v2/`，验收结果记录在 CHANGELOG。
版本计划见 [ROADMAP.md](ROADMAP.md)，发布步骤见 [PUBLISH.md](PUBLISH.md)，
日常迭代与故障处理见 [docs/MAINTENANCE.md](docs/MAINTENANCE.md)。

## 许可证

MIT
