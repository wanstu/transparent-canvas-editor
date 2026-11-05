package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	kiticon "github.com/wanstu/wails-desktop-kit/icon"
)

func main() {
	root, err := findRepoRoot()
	if err != nil {
		fatal(err)
	}

	source := filepath.Join(root, "assets", "icons", "transparent-canvas-editor-app.png")
	target := filepath.Join(root, "build", "appicon.png")

	if info, err := os.Stat(source); err == nil && info.Mode().IsRegular() {
		options := kiticon.DefaultOptions()
		options.CanvasSize = 1024
		options.Fill = 0.94
		options.TrimAlpha = true
		options.AlphaThreshold = 8
		if err := kiticon.NormalizeFile(source, target, options); err != nil {
			fatal(fmt.Errorf("normalize custom app icon: %w", err))
		}
		fmt.Println("prepared custom application icon")
	} else if err != nil && !os.IsNotExist(err) {
		fatal(fmt.Errorf("stat custom app icon: %w", err))
	} else {
		options := kiticon.DefaultBadgeOptions()
		options.Size = 1024
		options.Symbol = "monogram"
		options.Text = "T"
		if err := kiticon.GenerateBadgeFile(target, options); err != nil {
			fatal(fmt.Errorf("generate fallback app icon: %w", err))
		}
		fmt.Println("generated desktop-kit fallback application icon")
	}

	if runtime.GOOS == "windows" {
		// Match ADM's Kit integration: Wails regenerates icon.ico from the
		// freshly prepared build/appicon.png when the stale generated ICO is absent.
		windowsIcon := filepath.Join(root, "build", "windows", "icon.ico")
		if err := os.Remove(windowsIcon); err != nil && !os.IsNotExist(err) {
			fatal(fmt.Errorf("remove generated Windows icon: %w", err))
		}
	}

	fmt.Println("prepared desktop assets for", runtime.GOOS)
}

func findRepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("repository root not found from %s", dir)
		}
		dir = parent
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "prepare desktop assets:", err)
	os.Exit(1)
}
