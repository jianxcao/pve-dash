package version

import (
	"runtime"
	"testing"
)

func TestInfoDefaultsAndGoVersion(t *testing.T) {
	info := Info()
	if info.Version == "" || info.Commit == "" || info.BuildTime == "" {
		t.Fatalf("expected non-empty default BuildInfo fields, got %+v", info)
	}
	if info.GoVersion != runtime.Version() {
		t.Fatalf("expected GoVersion=%q, got %q", runtime.Version(), info.GoVersion)
	}
}
