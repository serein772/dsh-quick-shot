# Quick shot（`dsh-quick-shot`）

[English](README.md) | 中文

**仅支持 Windows。** 截图由宿主在首次使用时编译的 WinForms / C# helper 完成，没有非 Windows 的降级路径。

输入框工具栏上的相机按钮，把屏幕选区变成附件：

1. 点发送按钮旁边的相机图标。
2. Harness 窗口收起，出现带暗色遮罩的选区浮层。
3. 拖拽框选想要的区域（Esc 或右键取消，长时间无操作也会取消）。标签实时显示选区像素尺寸。
4. 窗口恢复，PNG 作为待发送附件落进输入框，随下一条消息发出。

按钮是 `conversation.input.right` 槽位里的一个小幽灵图标，和输入框其他控件排在一起、跟随宿主主题。它旁边是一个很小的取图范围切换。截图进行中相机图标会变成转圈；取消或失败通过输入框自己的提示条反馈。

## 取图范围

相机按钮旁有个显示器/窗口小图标用来切换取图范围，选择会被记住（`localStorage`，刷新后仍生效）：

| 模式 | 行为 |
|---|---|
| **桌面区域**（默认，显示器图标） | Harness 窗口收起，整个桌面变暗，可跨屏幕任意框选。 |
| **Harness 窗口**（窗口图标） | Harness 窗口保持可见，暗色遮罩只覆盖该窗口，可以截取应用界面本身的一部分。 |

切换按钮的 tooltip 会显示当前范围和点击后会切到什么。

## 指针与选区

浮层遮罩为 50% 黑。系统指针被隐藏，替换为在指针位置绘制的十字准星：黑色描边、亮红核心、中心点加四段短臂——深浅背景和杂乱画面上都看得清，又不会用辅助线糊满屏幕。

选区画成白色下划线加蓝色边框，并带 `宽 x 高` 标签。Esc 或右键取消，长时间无操作也会取消。

## 截图里不留 Harness 残影

用 `ShowWindow(SW_HIDE)` 隐藏窗口时，Windows 的 DWM 过渡会让它在大约 150–250 ms 内淡出；此时立刻抓屏会拍到半透明的窗口，在截图里表现为淡淡的 Harness 界面。所以 helper 改用 **cloak** 方式（`DWMWA_CLOAK`）：合成器立即丢弃该窗口且无动画，而位置、任务栏存在感和窗口状态都不变，抓屏拿到的是干净桌面，解除 cloak 后窗口原位恢复。对于不支持 cloak 的系统，仍保留普通隐藏作为兜底，只是等待时间更长。

## 为什么点起来很快

原生 C# helper（`helper.cs`）用系统自带的 .NET Framework 编译器**只编译一次**，按源码哈希缓存在 `%LOCALAPPDATA%\dsh-quick-shot\quick-shot-<hash>.exe`。每次点击就启动这个可执行文件——隐藏窗口、抓屏、显示浮层、退出，因此没有常驻进程、没有闲置内存。

| 路径 | 点击 → 浮层可见 |
|---|---|
| 稳定状态（命中缓存的可执行文件） | 约 0.3 秒（进程启动 50–90 ms + 隐藏/抓屏约 180 ms + 浮层约 100 ms） |
| 重新编译后首次点击 / 文件缓存冷 | 约 0.5–0.6 秒 |
| 旧的冷启动 PowerShell 路径 | 约 3 秒 |
| 另一种常驻 PowerShell daemon 方案 | 约 0.23 秒，但常驻约 90 MB |

## 实现方式

| 组件 | 作用 |
|---|---|
| `client.js` | 注册按钮。向宿主发请求，把返回的 PNG 变成 `File`，通过 Conversation 服务（`createDrafts`）创建草稿附件，再用会话输入句柄（`input.addAttachments`）挂上去——和内置文件选择器走同一条路径。模块 id 从宿主注入的 `window.__DSH_BOOT__` 启动图里按脚本地址取，不写死包名。 |
| `index.js` | 在同源下提供 `POST /quick-shot/capture`，位于 Web 载体的信任校验之后。负责编译/复用 helper 可执行文件，每次截图拉起一个 helper，编译不可用时回退到 PowerShell（仅桌面模式）。 |
| `helper.cs` | 截图本体：按页面标题找到窗口，然后要么隐藏它并抓整个桌面，要么保持可见只抓它的矩形区域（`--mode desktop|window`）；显示带十字准星的暗色橡皮筋浮层，必要时恢复窗口，裁剪并以 base64 JSON 返回 PNG。 |
| `capture.ps1` | 慢路径兜底，用 PowerShell 实现同一套截图流程（`csc.exe` 缺失或编译失败时使用）。 |

仅支持 Windows。helper 的编译依赖 Windows 自带的 .NET Framework 4.x 编译器（`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`）。图像不出本机：页面 → 宿主 → 页面，除了缓存的可执行文件不写磁盘，也不碰系统剪贴板。

## 脱离页面单独使用

```
powershell -STA -NoProfile -File capture.ps1 -DryRun -TitleB64 <base64 标题>
powershell -STA -NoProfile -File capture.ps1 -SelfTest -TitleB64 <base64 标题>
```

helper 本身接受 `--title-b64 <b64> [--mode desktop|window] [--timeout <秒>] [--selftest] [--auto-drag]`，输出一行 `started` 和一行结果。

## 安装

```
dsh plugin add github:serein772/dsh-quick-shot
```

也可以直接在插件市场里找。本地开发时，把 profile 依赖用 `link:` 指向这个目录即可。

两个 JavaScript 半边都不需要构建步骤；C# helper 由宿主在激活时编译。
