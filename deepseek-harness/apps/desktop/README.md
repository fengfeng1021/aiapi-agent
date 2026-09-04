# DeepSeek Harness Desktop

English | [中文](README.zh.md)

This application is the Tauri desktop carrier for the existing `dsh web` product. It does not fork the Web client or agent runtime: the desktop host starts the packaged CLI on an OS-assigned loopback port, waits for the CLI's readiness URL, and navigates one WebView to that origin.

> This is a community-maintained desktop distribution, not an official DeepSeek AI signed installer. DeepSeek Harness core remains under the upstream MIT license; this repository maintains the carrier and installers.

## Development

Prerequisites are the repository's Node and pnpm versions, Rust, and the platform-specific [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
pnpm install
pnpm desktop:dev
```

Development mode starts the source CLI through the repository's installed `tsx` runtime. Closing the desktop application stops the owned CLI process tree.

## Distribution builds

```sh
# Windows (default: MSI)
pnpm desktop:build -- --target x86_64-pc-windows-msvc --bundles msi

# macOS (default: DMG)
pnpm desktop:build -- --target aarch64-apple-darwin --bundles dmg

# Linux (default: DEB and AppImage)
pnpm desktop:build -- --target x86_64-unknown-linux-gnu --bundles deb,appimage
```

On Windows, the build automatically stages Cargo output under a stable system
temporary directory when the checkout path contains WiX-unsafe XML characters
such as `&`, then copies the completed bundles back to the standard
`apps/desktop/src-tauri/target/<target>/release/bundle` directory.

The build compiles the existing Harness libraries and Web UI, verifies the flat
workspace closure recorded in `apps/desktop/package.json`, deploys that
production closure, downloads the target's official Node.js archive, and
verifies it against Node.js `SHASUMS256.txt`. It then creates a link-aware gzip
archive as the single Tauri runtime resource. Installed applications do not
require a system Node.js installation or a network install step for dsh
dependencies. The archive also carries the repository-pinned pnpm JavaScript
CLI. `dsh plugin` runs it with the bundled Node process, without `cmd.exe` or a
machine `PATH` dependency, while third-party packages remain ordinary
profile-local dependencies under `$DSH_HOME`.

When pnpm's legacy deploy leaves a direct dependency beside the source deploy
root, runtime preparation copies that already-installed package while omitting
its package-local `node_modules`. It does not repack the package, so a clean CI
checkout remains independent of workspace links that the deploy step may prune.

Windows MSI bundles also embed the Microsoft Edge WebView2 offline installer.
Recipients can therefore install and launch the application without first
installing Node.js, pnpm, Rust, Git, or downloading WebView2. This adds roughly
127 MB to each Windows installer. Using an online DeepSeek provider still
requires network access and that recipient's provider credentials; the offline
installer only removes machine setup downloads.

The first successful launch shows environment-check, bundled-runtime installation or repair, system-adaptation, and service-validation progress while it extracts the runtime into application-local data and atomically publishes both the runtime readiness marker and a user-level initialization marker. Later launches and versioned runtime updates keep that page hidden and show the workspace as soon as the local service is ready; only a startup failure reveals recovery actions. The Windows production archive uses a physical dependency tree with no symlinks or junctions, avoiding path-trust policies and security products that reject traversal of user-created mount points. On the current Windows x64 acceptance machine, with Defender and another security product active, first publication takes about two minutes; this is a one-time cost. Run `pnpm desktop:manifest` to check that the committed deploy root still covers the CLI's complete transitive workspace graph.

| Operating system | Targets | Installer output |
|---|---|---|
| Windows 10 / Server 2016+ | x64 | MSI |
| Windows 10+ | ARM64 (preview) | MSI |
| macOS 13.5+ | Intel, Apple Silicon | DMG |
| Linux | x64, ARM64 | DEB, AppImage |

The manual/tagged [desktop release workflow](../../.github/workflows/desktop-release.yml) builds each operating system on its native GitHub runner and retains downloadable installers. Tagged `desktop-v*` runs also attach the installers to a GitHub Release.

The standard Windows installer includes an install-directory page and native
installation progress. After the application opens, a profile with no
registered workspace shows a short first-use guide whose action opens the
existing directory browser; users can create a new folder or select an existing
project, and the first conversation starts in that workspace.

Desktop loopback pages also expose an **Open CLI mode** button. It opens the
bundled Node runtime in Windows Terminal (PowerShell is the Windows fallback),
macOS Terminal, or a supported Linux terminal without exposing Tauri IPC to Web
content. The DeepSeek-branded interactive CLI asks for an existing or new
project folder, keeps one conversation across prompts, and provides `/new`,
`/clear`, `/cwd`, `/help`, and `/exit`. It uses the same managed DeepSeek API
credential as the desktop profile. Its subprocess boots the standard `tui`
profile (`dsh-base` plus the thin terminal transport bundle), so user profile
and home patches, plugins, sessions, skills, tools, and subagents are composed
by the same Harness loader instead of a fixed desktop-only plugin list. The
desktop background service remains windowless; a terminal is shown only when
the user explicitly opens CLI mode.

## Embedded community bundles

Desktop 0.1.12 carries eight version-pinned community bundles in its physical
runtime. They are installation-owned Web profile layers: an existing user
profile is not rewritten, duplicate package names are composed only once, and
profile-local plugins remain above the shipped core layers.

| Capability | Embedded package | Version or source |
|---|---|---|
| Web plugin market | `dshmarket` | `1.17.1` |
| Skills market and manager | `dsh-skill-hub` | `0.2.5` |
| Long-term project memory | `@vectorize-io/hindsight-coding-agents` | `0.4.1` |
| Adaptive image recognition | `dsh-vision-recognizer` | `0.2.0` |
| Right-side workbench | `dsh-better-sidebar` | `0.14.0` |
| Generative interactive UI | `@omdsh-dev/dsh-genui` | pinned Git commit `c75ca7c` |
| Composer file references | `dsh-at-file` | `0.6.3` |
| Web UI aggregate | `@linxin666/dsh-web-ui-all` | `0.2.7` |

After launch, Settings exposes one **Plugin Market** entry plus **Skills**. The
plugin market supports searching community plugins and one-click install,
update, uninstall, and toggle operations. Twelve source-validated records that
are still absent upstream are merged into the same catalog after its online
registry loads; the older Community Plugins page does not mount. The skills hub
provides a catalog, GitHub skill import, and enable, disable, and update
operations. Both use the existing profile package manager, so user-installed
content remains in the user's profile instead of modifying the
installation-owned layers.

The post that motivated this bundle used retired `github:nicepkg/*` locations;
the current public package or repository identity is pinned above. The missing
`modlens` package is represented by `dsh-vision-recognizer`: images pass through
unchanged when the selected model is natively multimodal, while a configured
vision provider transcribes them for text-only DeepSeek routes. Configure it in
**Settings → Plugins → Image recognition**. No provider key is embedded.

Hindsight requires the user to choose Hindsight Cloud, a self-hosted server, or
its local daemon in `~/.hindsight/coding-agent.json`; it is disabled during
build smoke tests so repository content is never uploaded by verification. The
Web UI aggregate also contains optional Cloudflare tunnel support. Its npm
wrapper downloads an unchecksummed `latest` executable during postinstall, so
that lifecycle script is denied in reproducible builds; tunnel users must
supply a separately verified executable through `CLOUDFLARED_BIN`. SSH remains
functional through its pure-JavaScript path without the denied optional native
accelerators.

## Desktop pet and reading comfort

The desktop profile hosts its pet in an independent transparent, frameless,
always-on-top window, so the character can move outside the Harness workspace.
The main window keeps only a compact summon control and the concise **Pet**
settings: master enable, show or hide, character, size, and reply bubbles. A
committed assistant reply is reduced to safe plain text and shown in the pet
bubble; reasoning, tool arguments, links, and rich Markdown are not copied into
that surface.

**Skin Center** presents the four compatible background fields as one reading-
comfort card. Clear, Balanced, and Immersive presets cover ordinary use;
background brightness and content clarity preview live while dragging, while
the separate empty-page, conversation, and input-card controls remain under an
advanced disclosure. Clear writes zero to every occlusion and blur field, so
the off state remains explicit and existing `settings.yaml` values require no
migration.

## Process and navigation policy

The desktop host allows one application instance. Opening the application again focuses the existing workspace window instead of starting another local service. It starts the bundled Web profile with `--no-open`, so the local workspace appears only in the desktop WebView and startup never hands the loopback URL to the system browser. The workspace and pet WebViews accept only the generated `http://127.0.0.1:<port>` origin. HTTP and HTTPS links that the user follows outside that origin still open in the system browser; all other ordinary navigation schemes are denied. No general Tauri commands or shell permissions are exposed to Web content; the pet receives only the host-validated display, drag, move, resize, and input-passthrough actions described above.

The host reads both runtime output streams for the readiness URL and stops its owned Node tree before showing retryable diagnostics when startup times out, output closes early, or the process exits. Windows assigns that tree to a kill-on-close Job Object when the host permits it and otherwise uses explicit tree termination. Linux applies a parent-death signal and an isolated process group; macOS uses the same process-group teardown on ordinary exit. Shutdown waits for the runtime to stop before the desktop process returns.

## Distribution limits

Local installers are unsigned development artifacts. They can be copied to and installed on compatible computers, but Windows SmartScreen can show an unknown-publisher warning. Production distribution needs organization-owned Windows code signing and Apple signing/notarization credentials; the repository does not contain those secrets. Each operating system and CPU architecture requires its matching installer; a Windows x64 MSI does not replace the Windows ARM64, macOS, or Linux artifacts. Linux bundles built on Ubuntu 22.04 establish that runner's WebKit and glibc compatibility floor.

Node.js 24 is the strict Windows compatibility boundary carried by this distribution: x64 requires Windows 10 / Windows Server 2016 or newer, while ARM64 requires Windows 10 or newer. The 0.1.12 release carries the official Harness 0.1.1-rc.1 runtime, including the `DeepSeek-V4-Flash-Vision-Exp` image-input model and the eight community bundles above. In a Web conversation, select that model and paste an image or drag an image onto the page before sending the prompt. The Windows x64 MSI build and its archived-runtime Web/plugin-graph smoke test pass on the current Windows 11 x64 build machine. Clean-machine installation and launch acceptance for 0.1.12, Windows 10 x64, and Windows ARM64 remain pending.

The bundled pnpm removes the package-manager prerequisite; it does not make
every third-party plugin environment-free. Pure JavaScript and compatible
prebuilt packages can install through the carried toolchain, while plugins
with native build steps or git dependencies can still require matching native
artifacts, Git, Python, or a compiler toolchain. Installing a plugin executes
third-party package lifecycle code and should be limited to trusted sources.
