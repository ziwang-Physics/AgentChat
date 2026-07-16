# MobaXterm SSH + VNC 混合工作流

## 核心思路

```
┌─ MobaXterm ─────────────────────────────────────┐
│                                                  │
│  SSH Terminal ────── 命令行操作（不走X11）  ──────► Linux Server │
│                                                  │          │
│  SSH Tunnel :5901 ──── VNC 加密通道 ─────────────► localhost:5901 │
│                                                  │          │
│  TigerVNC Viewer ──── 图形界面 ─────────────────► vncserver :1  │
│                                                  │          │
└──────────────────────────────────────────────────┘          │
     按需启动/关闭 ──────────────────────────────► vncserver -kill :1
```

**一句话总结**：MobaXterm 只负责 SSH 终端（命令行），VNC 独立负责图形界面，SSH 隧道加密保护 VNC 流量，GUI 按需启动用完即关。

---

## 一、Step 1: 禁用 MobaXterm X11 Forwarding

### 为什么必须关

如果不关 `DISPLAY` 变量，GUI 程序会连接到 X11 forwarding 提供的 X Server（`localhost:10.0`），而非 VNC 桌面（`:1`），这正是卡顿根源。

### 操作

**MobaXterm Session 设置**：
1. 右键 Session → `Edit session`
2. `Advanced SSH settings` → 取消勾选 `☐ X11-Forwarding`
3. 保存，重新连接

**验证**（SSH 登录后）：
```bash
echo $DISPLAY
# 应为空。如果有值（如 localhost:10.0），说明 X11 未关闭
```

**临时关闭**（不修改 Session 配置）：
```bash
unset DISPLAY
```

**安全建议**：生产环境优先使用 SSH 密钥认证而非密码登录：
```bash
# Windows 端生成密钥对（PowerShell）
ssh-keygen -t ed25519 -C "your-email@example.com"
# 公钥上传到服务器
ssh-copy-id user@remote-server
```

---

## 二、Step 2: 服务端安装 VNC Server

### 选型建议

| 场景 | 推荐 | 原因 |
|------|------|------|
| 通用/HPC 计算节点 | **TigerVNC** | 稳定、发行版原生支持、兼容性最好 |
| 需要流畅 Chrome/3D/视频 | **TurboVNC** | SIMD 加速 JPEG、自适应质量、自适应色度子采样、Tight Encoding，高刷新 GUI 提升明显 |
| 已有图形桌面 :0 | x11vnc | attach 到现有 X，但不适合无头服务器 |

### 安装

```bash
# === TigerVNC (Debian/Ubuntu) ===
sudo apt install tigervnc-standalone-server tigervnc-common -y

# === TigerVNC (RHEL/CentOS/Fedora) ===
sudo dnf install tigervnc-server -y

# === TurboVNC（需要手动下载） ===
# https://sourceforge.net/projects/turbovnc/files/
wget https://sourceforge.net/projects/turbovnc/files/3.1/turbovnc_3.1_amd64.deb
sudo dpkg -i turbovnc_*.deb
```

---

## 三、Step 3: VNC 按需启动/关闭

### 首次配置（设置 VNC 密码）

```bash
vncpasswd
# 输入 6-8 位密码（仅用于 VNC 连接，非系统密码）
```

### 启动 VNC

```bash
# 基本启动（监听本地回环，外部不可见）
vncserver :1 -localhost yes -geometry 1920x1080 -depth 24

# 输出示例：
# New 'server:1 (username)' desktop at :1 on machine servername
# Starting applications specified in ~/.vnc/xstartup
# Log file is ~/.vnc/servername:1.log
```

**参数说明**：

| 参数 | 值 | 说明 |
|------|-----|------|
| `:1` | display 编号 | VNC 端口 = 5900 + display（:1 → 5901） |
| `-localhost` | yes | **安全关键**：仅监听 127.0.0.1，外网不可见 |
| `-geometry` | 1920x1080 | 桌面分辨率 |
| `-depth` | 24 | 色深 |

### 配置桌面环境

**方式 A：`~/.vnc/xstartup`（传统方式，TigerVNC 1.x 及部分发行版）**

```bash
#!/bin/bash
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS

# ⚠️ 一次只保留一个桌面环境！不要同时取消多个注释
# === 仅需跑 Chrome → Fluxbox/Openbox（最轻量，推荐）===
fluxbox &
# 或: openbox &

# === 需要完整桌面 → Xfce（轻量平衡之选）===
# startxfce4 &

# === 不推荐远程使用 ===
# gnome-session &   # 资源占用大
```

```bash
chmod +x ~/.vnc/xstartup
```

**方式 B：`~/.vnc/config`（新版 TigerVNC 推荐，部分发行版默认）**

```ini
# ~/.vnc/config
session=xfce
geometry=1920x1080
depth=24
localhost=yes
```

> **注意**：不同发行版（Ubuntu/Debian vs RHEL 9/Rocky）的 TigerVNC 版本和配置方式有差异。如 `xstartup` 不生效，检查 `~/.vnc/config` 或查阅发行版 TigerVNC 文档。

### 关闭 VNC

```bash
vncserver -kill :1
# 输出：Killing Xvnc process ID 12345
```

### DISPLAY 变量说明（核心概念）

理解 DISPLAY 变量是让整个工作流正常运转的关键：

```bash
# === SSH 终端（X11 forwarding 关闭后）===
echo $DISPLAY
# (空) → GUI 程序无法启动，这正是我们想要的

# === VNC 桌面内部（通过 VNC Viewer 连接后，打开终端）===
echo $DISPLAY
# :1 → 所有 GUI 程序渲染到 VNC X server

# ⚠️ 绝对不要做的事：
# export DISPLAY=localhost:10.0   ← 这会重新走 X11 forwarding！
```

**快捷 alias**（加入 `~/.bashrc`）：

```bash
# VNC 桌面内部运行时自动指向正确的 display
# 通常不需要设置——VNC 桌面内 DISPLAY 自动为 :1

# 在 SSH 终端中启动单个 GUI 到 VNC（如果 VNC 已在运行）：
alias gui='DISPLAY=:1'           # 用法: gui firefox
alias chrome-vnc='DISPLAY=:1 google-chrome-stable --disable-gpu'
alias matlab-vnc='DISPLAY=:1 matlab -nodesktop'
```

---

## 四、Step 4: MobaXterm SSH 隧道配置

### 目的

VNC 绑定在 `localhost:5901`，外网无法直连。通过 SSH 隧道将本地端口映射过去，所有流量经 SSH 加密。

### 配置方式

**方式 A：MobaXterm 本地端口转发（推荐，持久化）**

在 MobaXterm 的 SSH 会话设置中找到 "SSH 端口转发/Port Forwarding" 功能（不同版本菜单位置可能略有差异，通常在 Session 编辑 → Advanced/Network 标签下）：
   ```
   Forwarded port: 5901
   SSH server:     <你的服务器IP>
   Remote host:    localhost
   Remote port:    5901
   ```
3. 保存 → 每次 SSH 连接自动建立隧道

**方式 B：命令行 SSH 隧道**

```bash
ssh -L 5901:localhost:5901 user@remote-server
```

### 多用户场景（display 号自动分配）

如果多人共用服务器，VNC display 号可能冲突：

```bash
# 自动分配可用 display
vncserver -localhost yes -geometry 1920x1080

# 查看当前使用的 display 和端口
vncserver -list
# 输出：
# :1  12345  5901
# :2  12346  5902

# 关闭时指定对应 display
vncserver -kill :2
```

---

## 五、Step 5: Windows 端 VNC Viewer

### TigerVNC Viewer（推荐）

1. 下载：https://sourceforge.net/projects/tigervnc/files/
2. 连接：输入 `localhost:5901`
3. 输入之前 `vncpasswd` 设置的密码

### 从命令行启动 VNC Viewer

```powershell
# PowerShell（Windows）
& "C:\Program Files\TigerVNC\vncviewer.exe" localhost:5901
```

### VNC Viewer 编码优化

在 TigerVNC Viewer 中调整以下参数可进一步优化流畅度：

| 设置 | 低带宽推荐 | 高带宽推荐 | 说明 |
|------|-----------|-----------|------|
| Encoding | Tight | Tight/RAW | Tight 编码压缩率高 |
| Compression | 6-9 | 0-2 | 越高压缩越多（CPU 换带宽） |
| Quality (JPEG) | 4-6 | 8-9 | 低质量=更小数据量=更流畅 |
| Desktop resize | 自动适应 | 固定分辨率 | 自动适应窗口大小 |

**命令行带参数启动**：
```powershell
# 低带宽优化
& "C:\Program Files\TigerVNC\vncviewer.exe" -QualityLevel=6 -CompressLevel=9 -PreferredEncoding=Tight localhost:5901
```

---

## 六、Step 6: 自动化方案

### ⚠️ 前提说明

**推荐使用 MobaXterm 已建立的 SSH 会话来管理 VNC**——命令行操作和端口隧道都在同一个 MobaXterm 窗口中完成。以下自动化脚本适合"完全从零启动"的场景，但由于 SSH 隧道会阻塞进程，需要特殊处理。

### 方案 A：MobaXterm 内手动操作（推荐，最简单）

在 MobaXterm SSH 终端中直接操作即可——MobaXterm 的 Tunnel 配置会保持端口转发：

```bash
# 在 MobaXterm SSH 终端中：
vncserver :1 -localhost yes -geometry 1920x1080 -depth 24
# 然后 Alt+Tab 切换到 TigerVNC Viewer → 连接 localhost:5901
```

### 方案 B：PowerShell 脚本（独立启动，不依赖 MobaXterm）

```powershell
# 保存为 start-remote-gui.ps1
param(
    [string]$Server = "your-server-ip",
    [string]$User = "your-username",
    [int]$Display = 1
)

$VncPort = 5900 + $Display
$VncViewer = "C:\Program Files\TigerVNC\vncviewer.exe"

# Step 1: SSH 远程启动 vncserver（短连接，执行完即退出）
Write-Host "=== Step 1: 启动远程 VNC server :${Display} ==="
ssh ${User}@${Server} "vncserver :${Display} -localhost yes -geometry 1920x1080 -depth 24"
if ($LASTEXITCODE -ne 0) {
    Write-Error "vncserver 启动失败，检查 display :${Display} 是否已被占用"
    exit 1
}

# Step 2: 后台启动 SSH 隧道（-N 不执行命令，-f 后台运行）
Write-Host "=== Step 2: 建立 SSH 隧道 ==="
ssh -N -f -L ${VncPort}:localhost:${VncPort} ${User}@${Server}
# -N: 不执行远程命令(仅转发)
# -f: 认证后转入后台运行

# Step 3: 启动 VNC Viewer
Write-Host "=== Step 3: 启动 VNC Viewer ==="
Start-Process -FilePath $VncViewer -ArgumentList "localhost:${VncPort}"

Write-Host "=== 完成！VNC 桌面在 localhost:${VncPort} ==="
Write-Host "使用完毕后:"
Write-Host "  1. 关闭 VNC Viewer 窗口"
Write-Host "  2. SSH 到服务器执行: vncserver -kill :${Display}"
Write-Host "  3. 关闭 SSH 隧道: Get-Process ssh | Stop-Process"
```

**使用方式**：
```powershell
.\start-remote-gui.ps1 -Server "10.0.0.5" -User "wangzi"
```

### 方案 C：MobaXterm Macros（自动化录制）

MobaXterm 内置宏功能可以录制操作序列：
1. `Macros` → `Record macro`
2. 在终端输入 `vncserver :1 -localhost yes -geometry 1920x1080`
3. 停止录制 → 保存为 "StartVNC"
4. 以后一键重放

> **局限**：宏不会解析动态输出（如自动分配的 display 号），建议固定使用 `:1`。

---

## 七、完整操作流程速查

```bash
# ====== 服务端 (SSH 终端中) ======

# 1. 首次：设置密码
vncpasswd

# 2. 需要 GUI 时：启动 VNC
vncserver :1 -localhost yes -geometry 1920x1080 -depth 24

# 3. 查看运行中的 VNC
vncserver -list

# 4. 用完后：关闭 VNC
vncserver -kill :1


# ====== Windows 端 ======

# 1. MobaXterm: SSH 连接（X11 forwarding 已关闭）
# 2. MobaXterm: 确保 5901 端口隧道已建立（Tunneling 配置）
# 3. TigerVNC Viewer: 连接 localhost:5901
```

---

## 八、高级场景

### 仅运行单个应用（不启动完整桌面）

编辑 `~/.vnc/xstartup`：

```bash
#!/bin/bash
# 仅启动浏览器 + 极简窗口管理器
fluxbox &
# 根据实际安装的浏览器选择（按需取消注释一行）：
# google-chrome-stable --disable-gpu --no-first-run &
# chromium-browser --disable-gpu --no-first-run &
# firefox &
```

```bash
vncserver :1 -localhost yes -geometry 1600x900 -depth 24
# VNC 桌面中只会看到 Chrome 窗口
```

### 多显示器 / 自定义分辨率

```bash
vncserver :1 -localhost yes -geometry 2560x1440 -depth 24
vncserver :1 -localhost yes -geometry 1366x768  # 低带宽
```

### 排障

```bash
# VNC 无法启动：检查端口占用
ss -tlnp | grep 590

# VNC 桌面灰屏/黑屏：检查 xstartup 或 config
cat ~/.vnc/xstartup
# 临时修复：直接用 twm（最基础窗口管理器）
echo "twm &" > ~/.vnc/xstartup && chmod +x ~/.vnc/xstartup

# VNC 日志
tail -f ~/.vnc/*.log

# 残留 VNC 无法正常关闭时（确认是自己的会话！）
vncserver -list                    # 先确认 PID
kill <PID>                         # 精确杀掉自己的进程
# ⚠️ 多用户服务器上绝对不要用 pkill Xvnc（会杀掉他人会话）
# ⚠️ 删除 /tmp/.X1-lock 前确认对应 PID 已不存在
```

---

## 九、与纯 X11 Forwarding 的对比

| | X11 Forwarding (旧方案) | SSH + VNC 混合 (新方案) |
|---|---|---|
| Chrome 流畅度 | ⭐ 卡顿 | ⭐⭐⭐⭐ 流畅 |
| 带宽消耗 | >50 Mbps | 3-10 Mbps |
| SSH 终端体验 | 正常 | 正常（无变化） |
| GUI 启动方式 | 自动（DISPLAY 环境变量） | 手动 `vncserver :1` |
| 关闭 GUI | 关窗口即可 | `vncserver -kill :1` |
| 安全性 | X11 流量经 SSH 加密 | VNC 流量经 SSH 隧道加密 |
| 资源占用 | 无额外进程 | VNC X server ~100-300MB RAM |
| 断线恢复 | ❌ 断开即丢失所有窗口 | ✅ VNC server 继续运行，重连后窗口仍在（SSH 终端会话丢失需 screen/tmux） |
| 需要服务端安装 | 不需要 | 需要 VNC server |
