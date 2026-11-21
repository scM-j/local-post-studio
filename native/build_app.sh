#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_BUNDLE="$ROOT_DIR/Local Post Studio.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RES_DIR="$CONTENTS/Resources"

echo "==> 1. 准备 .app 目录结构..."
rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS_DIR" "$RES_DIR/app"

echo "==> 2. 编译原生 macOS Swift 启动器..."
swiftc -O \
  -framework AppKit \
  -framework WebKit \
  -framework Foundation \
  "$ROOT_DIR/native/LocalPostStudioApp.swift" \
  -o "$MACOS_DIR/LocalPostStudio"

echo "==> 3. 生成 macOS 应用图标 (.icns)..."
ICONSET="$(mktemp -d)/AppIcon.iconset"
swift "$ROOT_DIR/native/generate_icon.swift" "$ICONSET"
iconutil -c icns "$ICONSET" -o "$RES_DIR/AppIcon.icns"
rm -rf "$(dirname "$ICONSET")"

echo "==> 4. 复制应用源码与前端界面..."
cp "$ROOT_DIR"/*.py "$RES_DIR/app/"
rsync -a "$ROOT_DIR/界面/" "$RES_DIR/app/界面/"
rsync -a "$ROOT_DIR/resources/" "$RES_DIR/app/resources/"
mkdir -p "$RES_DIR/app/tools/ffmpeg"
cp "$ROOT_DIR/tools/Freeman-DCTL-LICENSE.txt" "$RES_DIR/app/tools/"

echo "==> 5. 检查并内置 FFmpeg..."
FFMPEG_SRC=""
if [ -x "$ROOT_DIR/tools/ffmpeg/ffmpeg" ]; then
  FFMPEG_SRC="$ROOT_DIR/tools/ffmpeg/ffmpeg"
elif command -v ffmpeg >/dev/null 2>&1; then
  FFMPEG_SRC="$(command -v ffmpeg)"
elif [ -x "$ROOT_DIR/.venv/bin/python" ]; then
  FFMPEG_SRC="$("$ROOT_DIR/.venv/bin/python" -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())' 2>/dev/null || true)"
fi
if [ -n "$FFMPEG_SRC" ] && [ -f "$FFMPEG_SRC" ]; then
  cp "$FFMPEG_SRC" "$RES_DIR/app/tools/ffmpeg/ffmpeg"
  chmod +x "$RES_DIR/app/tools/ffmpeg/ffmpeg"
else
  echo "提示：未找到本机 ffmpeg，运行前请通过 Homebrew (brew install ffmpeg) 或 imageio-ffmpeg 安装。"
fi

echo "==> 6. 打包可重定位 Python 依赖 (如存在 .venv)..."
SITE_PACKAGES="$(find "$ROOT_DIR/.venv/lib" -maxdepth 2 -type d -name site-packages 2>/dev/null | head -n 1 || true)"
if [ -n "$SITE_PACKAGES" ] && [ -d "$SITE_PACKAGES" ]; then
  mkdir -p "$RES_DIR/pydeps"
  rsync -a --exclude='pip*' --exclude='__pycache__' --exclude='*.pyc' \
    "$SITE_PACKAGES/" "$RES_DIR/pydeps/"
fi

echo "==> 7. 写入 Info.plist 并签名..."
cat > "$CONTENTS/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Local Post Studio</string>
  <key>CFBundleDisplayName</key>
  <string>Local Post Studio</string>
  <key>CFBundleIdentifier</key>
  <string>io.localpoststudio.macos</string>
  <key>CFBundleVersion</key>
  <string>0.2.1</string>
  <key>CFBundleShortVersionString</key>
  <string>0.2.1</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>LocalPostStudio</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
EOF

codesign --force --deep --sign - "$APP_BUNDLE" >/dev/null 2>&1 || true
echo "==> 完成：$APP_BUNDLE"
