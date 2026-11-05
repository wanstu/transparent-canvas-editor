#!/usr/bin/env bash
set -euo pipefail

version="${1:?usage: package-linux-deb.sh <version> <output.deb>}"
output="${2:?usage: package-linux-deb.sh <version> <output.deb>}"

root="$(pwd)"
stage="${root}/dist/deb-root"
binary="${root}/build/bin/transparent-canvas-editor"

if [[ ! -x "${binary}" ]]; then
  echo "missing Linux binary: ${binary}" >&2
  exit 1
fi

rm -rf "${stage}"
mkdir -p   "${stage}/DEBIAN"   "${stage}/usr/bin"   "${stage}/usr/share/applications"   "${stage}/usr/share/icons/hicolor/512x512/apps"

install -m 0755 "${binary}" "${stage}/usr/bin/transparent-canvas-editor"
install -m 0644 "${root}/build/appicon.png" "${stage}/usr/share/icons/hicolor/512x512/apps/transparent-canvas-editor.png"

cat > "${stage}/usr/share/applications/transparent-canvas-editor.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Transparent Canvas Editor
Comment=Transparent canvas, box and text layout editor
Exec=transparent-canvas-editor
Icon=transparent-canvas-editor
Terminal=false
Categories=Graphics;Utility;
StartupNotify=true
DESKTOP

cat > "${stage}/DEBIAN/control" <<CONTROL
Package: transparent-canvas-editor
Version: ${version}
Section: graphics
Priority: optional
Architecture: amd64
Maintainer: wanstu
Depends: libgtk-3-0, libwebkit2gtk-4.1-0
Description: Transparent canvas editor
 A lightweight transparent canvas, box and text layout editor built with Go, Wails and wails-desktop-kit.
CONTROL

mkdir -p "$(dirname "${output}")"
dpkg-deb --build --root-owner-group "${stage}" "${output}"
rm -rf "${stage}"
echo "built ${output}"
