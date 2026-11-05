package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/wanstu/wails-desktop-kit/atomicfile"
	kitpaths "github.com/wanstu/wails-desktop-kit/paths"
)

const maxWorkspaceBytes = 64 << 20

var imageRefPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

type App struct {
	mu            sync.Mutex
	configDir     string
	workspacePath string
	imageDir      string
}

type imageAssetFile struct {
	DataURL string `json:"data_url"`
}

func NewApp() (*App, error) {
	dir, err := kitpaths.EnsureConfigDir(appID)
	if err != nil {
		return nil, err
	}
	imageDir := filepath.Join(dir, "assets", "images")
	if err := os.MkdirAll(imageDir, 0o700); err != nil {
		return nil, fmt.Errorf("create image asset dir: %w", err)
	}
	return &App{
		configDir:     dir,
		workspacePath: filepath.Join(dir, "workspace.json"),
		imageDir:      imageDir,
	}, nil
}

func (a *App) ConfigDir() string {
	return a.configDir
}

func (a *App) SaveWorkspace(raw string) error {
	if len(raw) > maxWorkspaceBytes {
		return fmt.Errorf("workspace is too large: %d bytes", len(raw))
	}
	var probe struct {
		Format string `json:"format"`
	}
	if err := json.Unmarshal([]byte(raw), &probe); err != nil {
		return fmt.Errorf("invalid workspace JSON: %w", err)
	}
	if probe.Format != "" && probe.Format != "transparent-canvas-editor" {
		return fmt.Errorf("unsupported workspace format %q", probe.Format)
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	return atomicfile.Write(a.workspacePath, []byte(raw), 0o600)
}

func (a *App) LoadWorkspace() (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	data, err := os.ReadFile(a.workspacePath)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read workspace: %w", err)
	}
	return string(data), nil
}

func (a *App) ClearWorkspace() error {
	a.mu.Lock()
	defer a.mu.Unlock()

	err := os.Remove(a.workspacePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (a *App) SaveImageAsset(ref, dataURL string) error {
	if err := validateImageRef(ref); err != nil {
		return err
	}
	if !strings.HasPrefix(dataURL, "data:image/") {
		return errors.New("image asset must be an image data URL")
	}
	payload, err := json.Marshal(imageAssetFile{DataURL: dataURL})
	if err != nil {
		return err
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	return atomicfile.Write(a.imagePath(ref), append(payload, '\n'), 0o600)
}

func (a *App) LoadImageAssets(refs []string) (map[string]string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	result := make(map[string]string, len(refs))
	seen := make(map[string]struct{}, len(refs))
	for _, ref := range refs {
		if _, ok := seen[ref]; ok {
			continue
		}
		seen[ref] = struct{}{}
		if err := validateImageRef(ref); err != nil {
			return nil, err
		}
		data, err := os.ReadFile(a.imagePath(ref))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("read image asset %s: %w", ref, err)
		}
		var asset imageAssetFile
		if err := json.Unmarshal(data, &asset); err != nil {
			return nil, fmt.Errorf("decode image asset %s: %w", ref, err)
		}
		if asset.DataURL != "" {
			result[ref] = asset.DataURL
		}
	}
	return result, nil
}

func (a *App) CleanupImageAssets(usedRefs []string) (int, error) {
	used := make(map[string]struct{}, len(usedRefs))
	for _, ref := range usedRefs {
		if err := validateImageRef(ref); err != nil {
			return 0, err
		}
		used[ref] = struct{}{}
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	entries, err := os.ReadDir(a.imageDir)
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		ref := strings.TrimSuffix(entry.Name(), ".json")
		if _, ok := used[ref]; ok {
			continue
		}
		if err := os.Remove(filepath.Join(a.imageDir, entry.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			return removed, err
		}
		removed++
	}
	return removed, nil
}

func (a *App) imagePath(ref string) string {
	return filepath.Join(a.imageDir, ref+".json")
}

func validateImageRef(ref string) error {
	if !imageRefPattern.MatchString(ref) || strings.Contains(ref, "..") {
		return fmt.Errorf("invalid image ref %q", ref)
	}
	return nil
}
