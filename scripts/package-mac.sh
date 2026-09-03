#!/bin/bash
# macOS 双架构打包：electron-builder 出裸应用 → 手动 ad-hoc 签名 → hdiutil 出 dmg
# 说明：无开发者证书，ad-hoc 签名让 Apple Silicon 不报"已损坏"；
#       首次打开仍需右键 → 打开（未经过 Apple 公证）。
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
NAME="项目启动器"

echo "== 1/4 构建 =="
npx electron-vite build

echo "== 2/4 打包裸应用（x64 + arm64，跳过安装器）=="
npx electron-builder --mac dir --x64 --arm64

echo "== 3/4 ad-hoc 签名并校验 =="
for dir in mac mac-arm64; do
  APP="release/$dir/$NAME.app"
  codesign --force --deep --sign - "$APP"
  codesign --verify --deep "$APP"
  echo "  ✓ $dir 签名校验通过"
done

echo "== 4/4 生成 dmg / zip =="
hdiutil create -volname "$NAME" -srcfolder "release/mac/$NAME.app" -ov -format UDZO "release/$NAME-$VERSION.dmg" >/dev/null
hdiutil create -volname "$NAME" -srcfolder "release/mac-arm64/$NAME.app" -ov -format UDZO "release/$NAME-$VERSION-arm64.dmg" >/dev/null
ditto -c -k --keepParent "release/mac/$NAME.app" "release/$NAME-$VERSION-mac.zip"
ditto -c -k --keepParent "release/mac-arm64/$NAME.app" "release/$NAME-$VERSION-arm64-mac.zip"
rm -f release/*.blockmap release/latest-mac.yml

echo "打包完成："
ls -lh release/*.dmg release/*.zip
