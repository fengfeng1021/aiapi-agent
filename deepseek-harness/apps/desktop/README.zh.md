# DeepSeek Harness 桌面端

[English](README.md) | 中文

本应用是现有 `dsh web` 产品的 Tauri 桌面载体，不会分叉 Web 客户端或 Agent 运行时。桌面宿主会在操作系统分配的回环端口启动打包后的 CLI，等待 CLI 输出就绪 URL，再让单个 WebView 导航至该来源。

> 这是社区维护的桌面发行版，并非 DeepSeek AI 官方签名安装器。DeepSeek Harness 核心遵循上游 MIT 许可证，桌面封装与安装器由本仓库维护。

## 开发

前置条件包括仓库规定的 Node 与 pnpm 版本、Rust，以及对应平台的 [Tauri 前置依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
pnpm install
pnpm desktop:dev
```

开发模式通过仓库已安装的 `tsx` 运行时启动源码 CLI。关闭桌面应用会停止其拥有的 CLI 进程树。

## 分发构建

```sh
# Windows (default: MSI)
pnpm desktop:build -- --target x86_64-pc-windows-msvc --bundles msi

# macOS (default: DMG)
pnpm desktop:build -- --target aarch64-apple-darwin --bundles dmg

# Linux (default: DEB and AppImage)
pnpm desktop:build -- --target x86_64-unknown-linux-gnu --bundles deb,appimage
```

在 Windows 上，如果检出路径包含 `&` 等 WiX XML 不安全字符，构建会自动把 Cargo 输出暂存到稳定的系统临时目录，并在完成后把安装包复制回标准的 `apps/desktop/src-tauri/target/<target>/release/bundle` 目录。

构建会编译现有 Harness 库和 Web UI，检查 `apps/desktop/package.json` 记录的扁平工作区闭包，部署该生产闭包，下载目标平台的 Node.js 官方压缩包，并依据 Node.js `SHASUMS256.txt` 验证文件。随后，构建会生成可还原包链接的 gzip 压缩包，作为唯一的 Tauri 运行时资源。安装后的应用不要求系统预装 Node.js，也不需要联网安装 dsh 依赖。归档还携带仓库锁定版本的 pnpm JavaScript CLI；`dsh plugin` 会使用内置 Node 直接执行它，不依赖 `cmd.exe` 或机器 `PATH`，第三方包仍以普通 profile 本地依赖的形式保存在 `$DSH_HOME` 下。

当 pnpm 的旧版部署把某个直接依赖留在源部署根旁边时，运行时准备会复制这个已经安装的包，并省略其包内 `node_modules`。它不会重新打包该包，因此干净的 CI 检出不依赖可能被部署步骤裁掉的工作区链接。

Windows MSI 还会嵌入 Microsoft Edge WebView2 离线安装程序。因此，接收方无需预装 Node.js、pnpm、Rust 或 Git，也无需联网下载 WebView2，即可安装并启动应用。这样会让每个 Windows 安装包增加约 127 MB。若使用在线 DeepSeek 服务，仍需网络和该接收方自己的服务凭据；“离线安装”只是不再依赖机器环境的联网下载。

首次成功启动会显示环境检测、内置运行时安装/修复、系统适配和服务验证进度，同时把运行时解压到应用本地数据目录，并原子发布运行时就绪标记与用户级初始化完成标记。后续启动和版本化运行时更新会保持该页面隐藏，在本地服务就绪后直接显示工作台；只有启动失败时才显示恢复选项。Windows 生产归档使用无符号链接、无 junction 的实体依赖树，避免路径信任策略和安全软件拒绝遍历用户创建的装入点。当前 Windows x64 验收机在 Defender 与第三方安全软件同时运行时，首次发布约需两分钟；这是一次性成本。运行 `pnpm desktop:manifest` 可检查已提交的部署根是否仍覆盖 CLI 的完整传递工作区依赖图。

| 操作系统 | 目标架构 | 安装包输出 |
|---|---|---|
| Windows 10 / Server 2016+ | x64 | MSI |
| Windows 10+ | ARM64（预览） | MSI |
| macOS 13.5+ | Intel、Apple 芯片 | DMG |
| Linux | x64、ARM64 | DEB、AppImage |

可手动或通过标签触发的[桌面发布工作流](../../.github/workflows/desktop-release.yml)会在各操作系统的原生 GitHub runner 上构建，并保留可下载的安装包。`desktop-v*` 标签触发的运行还会把安装包附加到 GitHub Release。

标准 Windows 安装器包含安装目录选择页和原生安装进度。应用打开后，如果当前 profile 尚未登记任何工作区，会显示简短的首次使用教程；入口会打开现有目录浏览器，用户可新建文件夹或选择已有工程，并在该工作区中自动开始第一个会话。

桌面回环页面还会显示“打开 CLI 模式”按钮。它会使用内置 Node 运行时，在 Windows Terminal（Windows 备用方案为 PowerShell）、macOS Terminal 或受支持的 Linux 终端中打开，不会向 Web 内容暴露 Tauri IPC。DeepSeek 品牌的交互式 CLI 会要求选择已有或新建工程文件夹，在多次输入间保持同一会话，并提供 `/new`、`/clear`、`/cwd`、`/help` 和 `/exit`。CLI 与桌面 profile 共用已托管的 DeepSeek API 凭据。它的子进程会启动标准 `tui` profile（`dsh-base` 加薄终端传输 bundle），因此用户的 profile/home patch、插件、会话、skills、工具与子代理仍由同一个 Harness Loader 组合，而不是读取桌面端专用的固定插件清单。桌面后台服务始终隐藏窗口，只有用户明确打开 CLI 模式时才会显示终端。

## 内嵌社区 Bundle

桌面端 0.1.12 在实体运行时中携带 8 个锁定版本的社区 Bundle。它们属于安装自身拥有的 Web profile 层：不会改写现有用户 profile；相同包名只组合一次；profile 本地插件仍位于随包核心层之上。

| 能力 | 内嵌包 | 版本或来源 |
|---|---|---|
| Web 插件市场 | `dshmarket` | `1.17.1` |
| 技能市场与技能管理 | `dsh-skill-hub` | `0.2.5` |
| 项目长期记忆 | `@vectorize-io/hindsight-coding-agents` | `0.4.1` |
| 自适应视觉识别 | `dsh-vision-recognizer` | `0.2.0` |
| 右侧工作台 | `dsh-better-sidebar` | `0.14.0` |
| 生成式交互 UI | `@omdsh-dev/dsh-genui` | 锁定 Git 提交 `c75ca7c` |
| 输入框文件引用 | `dsh-at-file` | `0.6.3` |
| Web UI 全家桶 | `@linxin666/dsh-web-ui-all` | `0.2.7` |

启动后，设置侧栏只提供一个“插件市场”入口，并另有“技能”入口。插件市场支持搜索社区插件并一键安装、更新、卸载；在线注册表加载成功后，仍未进入上游目录的 12 条来源已验证记录也会合并到同一市场中，旧“社区插件”页面不再挂载。技能中心支持浏览技能目录、从 GitHub 导入技能，以及启用、禁用和更新。两者都通过现有 profile 包管理器接入，用户安装的内容仍保存在自己的 profile 中，不会改写安装包内置层。

促成这组内嵌项的帖子使用了已经失效的 `github:nicepkg/*` 地址；上表锁定的是当前公开包或仓库身份。已经缺失的 `modlens` 改由 `dsh-vision-recognizer` 对应：所选模型原生支持多模态时，图片会保持原样直通；纯文本 DeepSeek 路由则由已配置的视觉服务转译图片。请在**设置 → 插件 → 识图**中配置，安装包不会内置任何服务密钥。

Hindsight 需要用户在 `~/.hindsight/coding-agent.json` 中选择 Hindsight Cloud、自托管服务或本地 daemon。构建烟测会禁用 Hindsight，确保验证过程不会上传仓库内容。Web UI 全家桶还包含可选的 Cloudflare 隧道支持，但其 npm 包装器会在 postinstall 阶段下载没有校验和的 `latest` 可执行文件，因此可复现构建会拒绝该生命周期脚本；需要隧道的用户应通过 `CLOUDFLARED_BIN` 提供另行验证的可执行文件。SSH 无需被拒绝的可选原生加速模块，仍可通过纯 JavaScript 路径工作。

## 桌面桌宠与阅读舒适度

桌面 profile 会把桌宠放在独立的透明、无边框、始终置顶窗口中，因此角色可以移出 Harness 工作台。主窗口只保留精简召唤入口，以及简洁的“宠物”设置：总开关、显示或隐藏、角色、大小和回复气泡。Assistant 已提交的回复会转成安全纯文本显示在桌宠气泡中；推理内容、工具参数、链接与富 Markdown 不会复制到该表面。

“皮肤中心”把四个兼容背景字段整理成一张阅读舒适度卡片。日常使用可直接选择“清晰”“均衡”“沉浸”；拖动“背景明暗”和“内容清晰度”会即时预览，空白页、对话页和输入卡片的独立控制收进展开项。“清晰”会把所有遮挡与模糊字段写为 0，因此关闭状态语义明确，现有 `settings.yaml` 也无需迁移。

## 进程与导航策略

桌面宿主只允许一个应用实例运行；再次打开应用会唤醒已有工作台窗口，不会另起一套本地服务。宿主使用 `--no-open` 启动内置 Web profile，因此本地工作台只会显示在桌面 WebView 中，启动过程不会再把回环 URL 交给系统浏览器。工作台与桌宠 WebView 都只能访问生成的 `http://127.0.0.1:<port>` 来源；用户主动访问的站外 HTTP 和 HTTPS 链接仍会在系统浏览器打开，其他普通导航协议全部拒绝。Web 内容不会获得通用 Tauri 命令或 Shell 权限；桌宠只能使用上文由宿主验证的显示、拖动、移动、缩放和指针穿透动作。

宿主同时读取运行时的标准输出与标准错误来接收就绪 URL，并在超时、输出提前关闭或进程退出时停止其拥有的 Node 树，再显示可重试的诊断界面。在宿主环境允许时，Windows 会把 Node 进程树放入“宿主关闭即终止”的 Job Object；否则使用显式进程树终止。Linux 使用父进程死亡信号和独立进程组，macOS 在正常退出时使用同样的进程组清理。桌面进程会等待运行时停止后再完成退出。

## 分发限制

本地安装包是未签名的开发产物，可以复制到兼容电脑安装，但 Windows SmartScreen 可能显示“未知发布者”提示。正式分发需要组织持有的 Windows 代码签名以及 Apple 签名与公证凭据；仓库不保存这些秘密。每个操作系统和 CPU 架构都必须使用相匹配的安装包；Windows x64 MSI 不能代替 Windows ARM64、macOS 或 Linux 产物。Linux 安装包在 Ubuntu 22.04 构建，因此该 runner 的 WebKit 与 glibc 版本构成兼容性下限。

Node.js 24 是本发行版较严格的 Windows 兼容边界：x64 需要 Windows 10 / Windows Server 2016 或更高版本，ARM64 需要 Windows 10 或更高版本。0.1.12 内置官方 Harness 0.1.1-rc.1 运行时，包括支持图片输入的 `DeepSeek-V4-Flash-Vision-Exp` 模型与上述 8 个社区 Bundle。在 Web 会话中选择该模型，把图片粘贴进输入区或拖到页面上，再发送问题即可。Windows x64 MSI 构建及其归档运行时 Web/插件图冒烟已在当前 Windows 11 x64 构建机通过；0.1.12 的干净电脑安装和启动验收，以及 Windows 10 x64 与 Windows ARM64 验收仍待完成。

内置 pnpm 取消的是包管理器前置条件，不代表任意第三方插件都无需环境。纯 JavaScript 包和架构匹配的预编译包可通过随包工具链安装；带原生编译步骤或 Git 依赖的插件仍可能需要匹配的原生制品、Git、Python 或编译工具链。安装插件会执行第三方包的生命周期代码，应只使用可信来源。
