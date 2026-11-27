package pve

import (
	"regexp"
	"strconv"
)

var semverRe = regexp.MustCompile(`(\d+)\.(\d+)(?:[.\-](\d+))?`)

// BuildCapabilities parses Proxmox VE version string (e.g. "9.2.21", "8.4.1", "7.4-16")
// and returns deterministic version-gated feature flags.
func BuildCapabilities(v *VersionInfo, isCluster bool) Capabilities {
	caps := Capabilities{
		IsCluster: isCluster,
	}
	if v == nil {
		return caps
	}
	caps.PVEVersion = v.Version
	caps.Release = v.Release

	m := semverRe.FindStringSubmatch(v.Version)
	if len(m) >= 3 {
		caps.Major, _ = strconv.Atoi(m[1])
		caps.Minor, _ = strconv.Atoi(m[2])
		if len(m) >= 4 && m[3] != "" {
			caps.Patch, _ = strconv.Atoi(m[3])
		}
	}

	atLeast := func(maj, min int) bool {
		if caps.Major != maj {
			return caps.Major > maj
		}
		return caps.Minor >= min
	}

	caps.Features = FeatureFlags{
		ResourceMappingPciUsb: atLeast(8, 0),
		ResourceMappingDir:    atLeast(8, 2),
		SDNCore:               atLeast(8, 1),
		SDNFabrics:            atLeast(9, 0),
		NotificationsV2:       atLeast(8, 1),
		ImportEsxiOva:         atLeast(8, 2),
		HAGroups:              !atLeast(9, 0),
		HARules:               atLeast(9, 0),
		LXCOciImages:          atLeast(9, 1),
		APTDeb822:             atLeast(9, 0),
		ACLStrictPVE9:         atLeast(9, 0),
		QemuMonitorDeprecated: atLeast(9, 0),
		RemoteMigrate:         atLeast(8, 0),
	}
	return caps
}
