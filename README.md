# Transparent Canvas Editor

一个面向透明画布、UI 方框和文字排版的轻量编辑器，同时提供单文件 HTML 便携版与基于 Wails 的桌面版。

## 功能

- 透明画布、纯色 / 多色渐变背景与背景图片
- 方框圆角、透明度、渐变蒙层、边框、阴影、背景图片
- 文字图层、系统字体与自定义字体
- 图层显示 / 隐藏、锁定、重命名、拖拽排序
- 方框与文字混合多选、对齐、等间距
- 水平 / 垂直刻度、参考线、智能吸附
- 100 步历史记录、撤回 / 反撤回
- 图片资源引用与去重、大图轻量预览
- PNG 导出、项目 JSON 导入 / 导出
- 快捷键提示与无感资源清理

## 单文件便携版

直接打开：

`transparent_canvas_editor.html`

无需安装，也没有外部 CSS / JS 依赖。

## 桌面版

桌面版基于：

- Go 1.26+
- Wails v2.15.0
- [wanstu/wails-desktop-kit](https://github.com/wanstu/wails-desktop-kit) v0.11.3

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
