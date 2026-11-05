# Transparent Canvas Editor

一个面向透明画布、UI 方框和文字排版的轻量编辑器，同时提供单文件 HTML 便携版与基于 Wails 的桌面版。

## 功能

- 透明画布、纯色 / 多色渐变背景与背景图片
- 方框圆角、透明度、渐变蒙层、边框、阴影、背景图片
- 文字图层、系统字体与自定义字体
- 图层显示 / 隐藏、锁定、重命名、拖拽排序
- 方框与文字混合多选、框选、对齐、等间距
- 对象旋转、方框锁定纵横比、Shift 临时等比缩放
- 水平 / 垂直刻度、参考线、对象边缘 / 中心智能吸附
- 吸附辅助线与等间距智能吸附反馈
- Ctrl+A 全选、Esc 清除选择、Home 居中定位、F 缩放到选中对象
- 100 步历史记录、撤回 / 反撤回
- 图片资源引用与去重、大图轻量预览
- 图层节点复用、对象节点缓存与每帧合并更新
- PNG 导出、项目 JSON 导入 / 导出
- 上下文智能快捷键提示、完整快捷键面板与无感资源清理

## 单文件便携版

直接打开：

`transparent_canvas_editor.html`

无需安装，也没有外部 CSS / JS 依赖。

## 桌面版

桌面版基于：

- Go 1.26+
- Wails v2.15.0
- [wanstu/wails-desktop-kit](https://github.com/wanstu/wails-desktop-kit) v0.12.1

桌面版增加：

- 单实例运行
- 工作区自动保存与启动恢复
- 图片资产独立持久化与引用
- Kit 统一配置目录与原子写入

### 构建

```powershell
go mod tidy
go test ./...
wails build -clean
```

Windows 构建产物：

```text
build/bin/transparent-canvas-editor.exe
```

### 应用图标

构建前会执行 `tools/prepare-desktop-assets`：

- 如果存在 `assets/icons/transparent-canvas-editor-app.png`，使用 Desktop Kit 规范化为 `build/appicon.png`
- 如果没有自定义图标，使用 Desktop Kit `icon.GenerateBadgeFile` 自动生成 `T` 徽标作为 fallback
- Windows 构建前删除旧的 `build/windows/icon.ico`，让 Wails 从最新 `build/appicon.png` 重新生成 EXE 图标
- Windows Setup 使用同一份生成后的 `build/windows/icon.ico`

这样 EXE、开始菜单快捷方式和安装器使用同一套应用图标。

## 项目结构

```text
app.js
index.html
style.css
transparent_canvas_editor.html
main.go
desktop_app.go
frontend/
wails.json
```

根目录的 HTML / CSS / JS 是编辑器源码；`sync-frontend.js` 会在 Wails 构建时同步到 `frontend/`。

## CI/CD

GitHub Actions 配置位于：

```text
.github/workflows/ci.yml
```

触发规则：

- Pull Request 到 `master`：运行质量检查并构建各平台产物
- Push 到 `master`：运行完整 CI，并保留构建 artifacts
- Push `v*` tag：在 CI 全绿后自动创建 / 更新 GitHub Release

自动构建产物：

- 单文件 HTML 便携版
- Windows amd64 EXE
- Windows amd64 Setup 安装包（NSIS，默认当前用户安装，无需 UAC）
- Windows amd64 ZIP（EXE + HTML + README）
- Linux amd64 tar.gz
- Linux amd64 `.deb`

普通分支构建的 artifact 名包含分支名和 commit SHA；tag 构建的 artifact / Release 文件名包含 tag。

### 发布版本

例如发布 `v0.1.0`：

```powershell
git tag v0.1.0
git push origin v0.1.0
```

CI 会自动测试、构建 Windows / Linux / 便携版，并在全部成功后发布 GitHub Release。
