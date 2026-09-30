<div align="center">

<img src="assets/icon-256.png" width="96" alt="DeviceKeeper">

# DeviceKeeper · 设备守护

**别让一只手滑毁掉整节课。**

把内置 USB 设备从任务栏「安全删除硬件」里藏起来，并持续守护不让系统写回。

[![Platform](https://img.shields.io/badge/platform-Windows%207%2B-3E63DD?style=flat-square&logo=windows)](#系统要求)
[![Runtime](https://img.shields.io/badge/runtime-Node.js%20%7C%20.NET%20Framework%204.0-1F874B?style=flat-square&logo=node.js)](#系统要求)
[![Dependencies](https://img.shields.io/badge/dependencies-zero-1F874B?style=flat-square)](#技术栈)
[![License](https://img.shields.io/badge/license-MIT-9AA1AC?style=flat-square)](LICENSE)

### [⬇️ 下载开箱即用版（83 MB，解压双击即用）](https://github.com/Levent628/DeviceKeeper/releases/download/v1.0.0/DeviceKeeper-v1.0.0-win64.zip)

<sub>已内置 Node 运行时与编译好的主程序，无需配置环境 · [全部版本](https://github.com/Levent628/DeviceKeeper/releases)</sub>

</div>

---

## 这是什么

希沃一体机之类的教学设备，前面板通常插着 **USB 无线网卡**、**USB 集线器** 这些"内置"外设。它们会被 Windows 当成可移动设备，老老实实出现在任务栏的「安全删除硬件」里。

然后学生在讲台上收拾东西时手一滑——

> 网卡被弹出 → 直播断流、课件投屏断开、课堂互动全部掉线。

而且很多机型弹掉之后**不会自动恢复**，要重启电脑、重新配对，一节课就废了。

DeviceKeeper 做的事很简单：**修改这些设备的 `Capabilities` 注册表值，让它们从「安全删除硬件」列表里消失，同时保证设备照常工作**；再起一个守护循环，防止系统把它写回去。

> 守护 ≠ 禁用。设备该联网联网，该传数据传数据，只是不再给你"弹出"的选项。

## 效果

|  | 守护前 | 守护后 |
|---|---|---|
| 任务栏「安全删除硬件」 | 出现 USB 网卡、集线器 | ✅ 消失 |
| 设备功能 | 正常 | ✅ 正常 |
| 误点风险 | 一失手就掉线 | ✅ 无处可点 |

## 特性

- **真·便携** — 单个文件夹，自带 `node.exe`，拷到任何 Windows 机器双击即用，不装运行时、不写系统目录、绿色免安装
- **控制台走浏览器** — 界面是本地 Web UI（`127.0.0.1` + 随机 token + Host 校验），双主题、响应式，改代码即见效
- **改前必备份** — 每次写入前自动 `reg export` 备份原值，写入后**回读校验**，不符自动回滚，绝不留下烂摊子
- **双守护手法** — 按设备实际能力位自动选择：清除 `REMOVABLE` 位 / 标记 `SurpriseRemovalOK`，不适用的设备明确拒绝而不是硬写
- **持续守护** — 5 秒一轮 diff，系统写回即修复，并记录累计修复次数
- **开机自启** — 双计划任务：`ONSTART+SYSTEM` 静默守护 + `ONLOGON` 显示托盘，全程不弹窗
- **零依赖后端** — 纯 Node 内置模块，`npm install` 都不需要
- **可诊断** — 一键导出完整诊断报告（系统信息 / 排除强度 / 每台设备的手法与原值 / 能力位解码 / 完整日志）

## 快速开始

> 想直接上手？下载 [**开箱即用版 zip**](https://github.com/Levent628/DeviceKeeper/releases/download/v1.0.0/DeviceKeeper-v1.0.0-win64.zip)，解压后跳到第 **2** 步。包内已含 Node 运行时和编译好的主程序，无需任何环境配置。

### 1. 编译主程序（仅源码用户，约 3 秒）

双击根目录的 **`编译程序.bat`** → 生成 `DeviceKeeper.exe`

> 用系统自带的 .NET Framework 编译器，不需要安装任何东西。
> `build/` 里是编译用的源文件，**不要**直接双击它们。
> 若使用开箱即用版，此步可跳过——exe 已编译好。

### 2. 启动

双击 `DeviceKeeper.exe` → UAC 提权点「是」（要写注册表，必须管理员）→ 右下角出现托盘图标。

### 3. 打开控制台

双击托盘图标，浏览器自动打开控制台 → 点「刷新」看到设备列表。

### 4. 守护

找到你的 USB 网卡 / 前面板集线器 → 点「守护」→ 设备立刻从任务栏消失。

勾选「开机自启」，之后重启自动生效，不用再管。

### 5. 部署到教室机器

把整个文件夹拷到 U 盘 → 复制到班级机本地（如 `C:\DeviceKeeper`）→ 重复步骤 2-4。

> 首次运行若被 SmartScreen 拦截（本地无签名），点「更多信息」→「仍要运行」。

## 工作原理

### 托盘判据

Windows 只在「安全删除硬件」里列出 *支持安全删除* 的设备。关键能力位是 `Capabilities` 中的 **`SURPRISE_REMOVAL_OK (0x80)`**：

- 该位为 **1** → 设备可被意外拔出、无需安全删除 → **不出现**在托盘
- 该位为 **0** → **出现**在托盘

所以把它置 1，设备就从托盘消失了。用 55 台真实设备反向验证过，这个判据完美分割了"进托盘的"和"不进托盘的"两类设备。

### 两种手法

程序会根据设备的原始值自动二选一，日志里会写明用了哪种：

| 手法 | 适用条件 | 操作 |
|---|---|---|
| `clear-removable` | 有 `REMOVABLE (0x4)` 位 | 原值 **−4**，清除可移动位（经典博客做法） |
| `mark-surprise` | 无 `REMOVABLE` 位（如 WiFi / Billboard） | 原值 **+0x80**，并写 `Device Parameters\SurpriseRemovalOK=1` |

两者都不适用的设备，程序会**明确拒绝**，绝不写入负数或越界值。

### 为什么改完还要"重启设备"

注册表改完 ≠ 设备已采用。系统需要**重新枚举**该设备才会读到新值。因此守护成功后默认会自动 `pnputil /restart-device`（约 1 秒，网络设备会瞬断），让变更立即生效。

如果仍然无效，「刷新托盘」按钮会重启 `explorer.exe` 强制系统托盘重建（任务栏短暂闪烁，属正常现象）。

### 关于 U 盘 ⚠️

**本工具对 U 盘 / 移动硬盘无效**，这是已实测确认的结论，不是 bug。

U 盘的"可弹出"来自**存储媒体层**（`USBSTOR` 枚举的媒体节点），而非普通设备节点，改设备注册表无法把它从托盘移除——即使守护写入成功（实测 `0x10 → 0x90`）依然能弹出。

本工具适用于 **USB 网卡、USB 集线器**这类单一 USB 设备。列表里存储设备已标注提示。

> 如果确实要全局隐藏所有 U 盘的弹出项，需要设 `HKLM\SYSTEM\CurrentControlSet\Services\usbstor\Parameters\DisableRemovalInterface=1`，但那是**一刀切**，会影响所有 U 盘，本工具不提供。

## 界面

**排除强度**（三档，切换即时生效并记住选择）：

| 档位 | 说明 |
|---|---|
| `严格` | 只显示经典"可移除且需安全删除"设备（对应博客里的网卡情形） |
| `宽松` | 默认。与系统「安全删除硬件」托盘规则一致，WiFi / Billboard 等在此可见 |
| `关闭排除` | 不按能力位过滤，列出全部在线 USB 设备，供人工挑选 |

托盘里有设备却在列表里看不到？切到「关闭排除」即可。

**其他操作**：

- **使生效** — 手动重启该设备以应用变更
- **刷新托盘** — 重启 explorer 强制托盘重建（兜底手段）
- **解除守护** — 精确还原原值（含 `SurpriseRemovalOK`，原本不存在则删除），可一键恢复
- **守护引擎** — 总开关，关闭后停止自动修复
- **导出日志** — 生成完整诊断报告

## 目录结构

```
DeviceKeeper/
├─ DeviceKeeper.exe   主程序（C# 托盘 + 启动器，requireAdministrator）
├─ node.exe           内置运行时（请勿删除，83 MB）
├─ server.js          后端服务（HTTP API + 注册表 + 守护循环 + 计划任务）
├─ public/            网页界面（单页，含本地字体，离线可用）
├─ assets/icon.ico    图标
├─ build/             源码与编译脚本（tray.cs / app.manifest）
├─ 编译程序.bat        一键编译
├─ README.md          本文件
├─ README.txt         离线纯文本版说明（给现场老师看）
└─ LICENSE            MIT

数据目录（自动创建）：%ProgramData%\DeviceKeeper\
├─ config.json        守护配置
├─ backups/           每次守护前的注册表原值备份（.reg）
├─ logs/              app.log + 每次启动的独立会话日志
└─ token              API 访问令牌
```

### 三种获取方式

| 方式 | 适合 | 做法 |
|---|---|---|
| **开箱即用版** | 直接部署到教室 | 下载 [Release zip](https://github.com/Levent628/DeviceKeeper/releases/download/v1.0.0/DeviceKeeper-v1.0.0-win64.zip)，解压双击 `DeviceKeeper.exe` |
| **源码 + 本地编译** | 想看代码 / 二次开发 | `git clone` → 双击 `编译程序.bat` → 从 [nodejs.org](https://nodejs.org/) 下载 Node 22 的 `node.exe` 放入根目录 |
| **仅需主程序** | 已有 Node 环境 | 从 Release 附件取 exe，或自行编译 |

## 技术栈

| 层 | 实现 |
|---|---|
| 后端 | Node.js 内置模块（`http` / `fs` / `child_process`），**零 npm 依赖** |
| 前端 | 原生 HTML/CSS/JS 单页，Inter + JetBrains Mono 本地字体，深浅双主题 |
| 主程序 | C# 5 / WinForms（系统 `csc.exe` 编译，无需 .NET SDK） |
| 系统交互 | `reg.exe`（读写注册表 / 备份）、`pnputil`、`schtasks`（开机自启） |

### 安全设计

- 服务只监听 `127.0.0.1`，带随机 token（`timingSafeEqual` 比对）+ `Host` 头校验，防 DNS rebinding
- 写操作走白名单正则 `^(USB|USBSTOR)\\[A-Za-z0-9&.\-_]+$`，全部经 `execFile` 参数数组传递，杜绝命令注入
- 任何注册表写入都遵循 **备份 → 写入 → 回读校验 → 不符回滚**

## 系统要求

- Windows 7 SP1 / 8 / 10 / 11（x64）
- .NET Framework 4.0+（Win7 以上系统自带）
- **管理员权限**（写注册表必需）
- 不需要安装 Node.js——已内置

## 卸载

控制台里逐台「解除守护」→ 关闭「开机自启」→ 右键托盘「退出」→ 删除整个目录。

> 即便直接删目录也**没有残留风险**：受守护的设备会在下次重启后自动恢复原值。

## 故障排查

| 现象 | 处理 |
|---|---|
| 提示「只读模式」 | 未以管理员运行，右键 exe →「以管理员身份运行」 |
| 守护失败「拒绝访问」 | 用「开机自启」的 SYSTEM 服务跑（开机后自动生效）；或检查杀软拦截 |
| 守护成功但托盘里还在 | 点「使生效」重启设备；仍无效再点「刷新托盘」 |
| 列表不全 | 「排除强度」切到「宽松」或「关闭排除」 |
| 托盘图标不显示 | 确认 exe 未被安全软件拦截（本地无签名） |
| 端口被占用 | 是否重复运行；或设置环境变量 `DK_PORT` 换端口 |

**还是不行？** 点控制台「导出日志」，会生成一份完整诊断报告（txt）——包含系统信息、排除强度、每台设备的手法与原值、能力位解码、完整日志。把它发到 [Issues](https://github.com/Levent628/DeviceKeeper/issues) 即可精准定位，无需现场截图。

## 免责声明

本工具会修改 Windows 设备注册表。程序已在写入前做自动备份与回读校验，并支持一键还原，但**请仍在理解原理后使用**，并在批量部署前先在一台机器上验证。因使用本工具造成的任何后果由使用者自行承担。

本项目为个人开源作品，与希沃（Seewo）等设备厂商无关联。

## License

[MIT](LICENSE)

---

<div align="center">
<sub>如果它帮你保住了一节课，欢迎点个 ⭐</sub>
</div>
