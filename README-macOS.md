# Local Post Studio · macOS 成品版 (Apple Silicon)

本文件夹是由 `scM-j/local-post-studio`（原 Windows x64 0.2.1 源码快照）深度 Mac 化改造后的完整成品目录，包含可直接双击运行的原生 `.app` 应用包、全新 macOS 专业后期风格界面、完整改造源码与一键重建脚本。

## 快速开始

1. **直接运行桌面应用**：双击本目录下的 **`Local Post Studio.app`**（也可以将其直接拖入 `/Applications` 应用程序文件夹，内部已打包源码、可重定位 Python 依赖与原生 arm64 FFmpeg，移动位置不失效）。
2. **离线语音转字幕（可选）**：原仓库不含 Whisper 模型权重。如需离线生成字幕，双击 **`下载Whisper模型.command`** 下载 `Base` / `Medium.en` / `Large-v3-turbo` 模型到应用数据目录即可。
3. **浏览器模式（备选）**：也可以双击 **`启动-浏览器模式.command`**，在默认浏览器中打开完整工作台。

## Mac 化与前端升级亮点

- **原生 macOS 桌面应用 (`Local Post Studio.app`)**
  - 使用原生 Swift + AppKit + WKWebView 构建，启动迅速、内存占用低，支持原生 macOS 红黄绿交通灯融入顶栏、原生文件夹选择与保存面板、系统菜单栏（`⌘C`/`⌘V`/`⌘A`/`⌘Z`/`⌘Q`）以及视频硬件加速播放（原生支持 ProRes / HEVC）。
  - 同时保留并改造了跨平台 Electron 启动壳（`app/resources/app/main.cjs`）。
- **Apple Silicon 硬件加速与系统原生能力**
  - **Apple VideoToolbox 硬件编码**：自动探测并支持 `H.264 8-bit 4:2:0`、`H.265 8-bit 4:2:0`、`H.265 10-bit 4:2:0`、`H.265 10-bit 4:2:2`，并沿用原版色彩标记与采样格式实测校验机制。
  - **VideoToolbox 硬件解码色彩预览**：Log / HDR 实时预览支持硬件解码并自动回退 CPU。
  - **H.266 / VVC 支持**：内置的 arm64 FFmpeg 9.0 已包含 `libvvenc`、`libass`、`zscale`、`lut3d`、`prores_ks`、`libaom-av1`、`libvpx-vp9`。
  - **原生系统监控与字体列表**：基于 macOS Mach API 实时读取 CPU 与内存占用，基于 CoreText 读取全部系统字体，烧录字幕默认使用 `PingFang SC`。
  - **exFAT 外置硬盘导出兼容**：输出提交阶段自动兼容不支持硬链接的移动硬盘/SD 卡。
- **macOS 原生专业后期风前端**
  - 参照 Final Cut Pro / DaVinci Resolve 与 Apple HIG 重制界面：毛玻璃顶栏与弹窗、精致微边框、分段式工作区切换、中性暗房预览区。
  - **默认跟随 macOS 系统外观**自动切换深色/浅色，同时可在顶栏一键切换（自动 / 深色 / 浅色）。
  - 沉浸式 52px 顶栏整合导航分段控件，默认隐藏背景装饰线（可在设置中重新开启），把更多屏幕留给画面与时间轴。
  - 快捷键与提示全面适配 `⌘` / `⌥`。

## 目录结构

- `Local Post Studio.app` — 可直接双击运行的原生 macOS 应用程序
- `app/` — 改造后的 Python 后端、FFmpeg 工具链、Electron 启动壳与前端界面
- `native/` — Swift 原生壳源码、图标生成脚本与 `build_app.sh` 打包脚本
- `.venv/` — 本机已配置好的 Python 3.14 虚拟环境（`av`、`faster-whisper`、`numpy`、`fonttools`）
- `启动-浏览器模式.command` — 浏览器模式一键启动脚本
- `下载Whisper模型.command` — 离线 Whisper 模型一键下载脚本

## 用户数据目录

项目文件、导入的媒体副本、厂商 `.cube` LUT、导出队列日志与 Whisper 模型均保存在标准 macOS 位置（也可在应用菜单「Local Post Studio → 打开数据目录」一键在访达中打开）：

```text
~/Library/Application Support/Local Post Studio/
```

## 修改源码后重新打包 `.app`

如果你后续修改了 `app/` 里的前端或 Python 代码，在终端运行以下命令即可重新构建 `Local Post Studio.app`：

```bash
./native/build_app.sh
```
