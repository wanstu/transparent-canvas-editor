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
	window.Width = 1440
	window.Height = 900
	window.MinWidth = 1024
	window.MinHeight = 680
	window.HidePolicy = desktopkit.HideNever
	window.StartHiddenOnAutoStart = false

	return desktopkit.Run(desktopkit.Config{
		ID:                   appID,
		Title:                appTitle,
		Assets:               kitui.Mount(assets),
		Bind:                 []interface{}{app},
		Launch:               launch,
		Window:               window,
		SingleInstance:       true,
		SecondInstancePolicy: desktopkit.SecondInstanceWakeAlways,
	})
}
