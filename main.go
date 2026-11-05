package main

import (
	"embed"
	"fmt"
	"io/fs"
	"os"

	desktopkit "github.com/wanstu/wails-desktop-kit"
	kitui "github.com/wanstu/wails-desktop-kit/ui"
)

const (
	appID    = "com.wanstu.transparent-canvas-editor"
	appTitle = "Transparent Canvas Editor"
)

//go:embed all:frontend
var frontend embed.FS

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	launch, err := desktopkit.ParseLaunchOptions(os.Args[1:])
	if err != nil {
		return err
	}
	assets, err := fs.Sub(frontend, "frontend")
	if err != nil {
		return err
	}
	app, err := NewApp()
	if err != nil {
		return err
	}

	window := desktopkit.DefaultWindowConfig()
	// Keep the initial client area safely inside common desktop work areas.
	// Wails adds the native title bar outside the client area on Windows;
	// an initial 1440x900 client area can push the title bar off-screen on
	// 1600x900-class displays and make the window appear borderless.
	window.Width = 1200
	window.Height = 720
	window.MinWidth = 900
	window.MinHeight = 600
	window.HidePolicy = desktopkit.HideNever
	window.StartHiddenOnAutoStart = false

	return desktopkit.Run(desktopkit.Config{
		ID:     appID,
		Title:  appTitle,
		Assets: kitui.Mount(assets),
		Bind:   []interface{}{app},
		Launch: launch,
		Window: window,
		Hooks: desktopkit.Hooks{
			Startup: app.startup,
		},
		SingleInstance:       true,
		SecondInstancePolicy: desktopkit.SecondInstanceWakeAlways,
	})
}
