package main

import (
	"os"
	"path/filepath"
	"testing"
)

func newTestApp(t *testing.T) *App {
	t.Helper()
	dir := t.TempDir()
	imageDir := filepath.Join(dir, "assets", "images")
	if err := os.MkdirAll(imageDir, 0o700); err != nil {
		t.Fatal(err)
	}
	return &App{
		configDir:     dir,
		workspacePath: filepath.Join(dir, "workspace.json"),
		imageDir:      imageDir,
	}
}

func TestWorkspaceRoundTrip(t *testing.T) {
	app := newTestApp(t)
	const raw = `{"format":"transparent-canvas-editor","version":5,"objects":[]}`
	if err := app.SaveWorkspace(raw); err != nil {
		t.Fatal(err)
	}
	got, err := app.LoadWorkspace()
	if err != nil {
		t.Fatal(err)
	}
	if got != raw {
		t.Fatalf("workspace mismatch: %q", got)
	}
}

func TestWorkspaceRejectsInvalidJSON(t *testing.T) {
	app := newTestApp(t)
	if err := app.SaveWorkspace("{"); err == nil {
		t.Fatal("expected invalid JSON error")
	}
}

func TestImageAssetRoundTripAndCleanup(t *testing.T) {
	app := newTestApp(t)
	const ref = "img-1"
	const dataURL = "data:image/png;base64,iVBORw0KGgo="
	if err := app.SaveImageAsset(ref, dataURL); err != nil {
		t.Fatal(err)
	}
	assets, err := app.LoadImageAssets([]string{ref})
	if err != nil {
		t.Fatal(err)
	}
	if assets[ref] != dataURL {
		t.Fatalf("asset mismatch: %q", assets[ref])
	}
	removed, err := app.CleanupImageAssets(nil)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed=%d, want 1", removed)
	}
}

func TestSanitizeProjectFilename(t *testing.T) {
	tests := map[string]string{
		"":          "canvas-project.json",
		"demo":      "demo.json",
		"demo.json": "demo.json",
	}
	for in, want := range tests {
		if got := sanitizeProjectFilename(in); got != want {
			t.Fatalf("sanitizeProjectFilename(%q)=%q, want %q", in, got, want)
		}
	}
}

func TestWorkspacePath(t *testing.T) {
	app := newTestApp(t)
	if got, want := app.WorkspacePath(), filepath.Join(app.configDir, "workspace.json"); got != want {
		t.Fatalf("WorkspacePath()=%q, want %q", got, want)
	}
}
