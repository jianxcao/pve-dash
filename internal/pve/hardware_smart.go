package pve

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

type smartctlJSON struct {
	RawText      string `json:"-"`
	SerialNumber string `json:"serial_number"`
	PowerMode    *struct {
		Name string `json:"name"`
	} `json:"power_mode,omitempty"`
	SmartStatus *struct {
		Passed *bool `json:"passed"`
	} `json:"smart_status,omitempty"`
	Temperature struct {
		Current float64 `json:"current"`
	} `json:"temperature"`
	PowerOnTime struct {
		Hours int64 `json:"hours"`
	} `json:"power_on_time"`
	PowerCycleCount int64 `json:"power_cycle_count"`
	SpareAvailable  *struct {
		CurrentPercent   *int `json:"current_percent"`
		ThresholdPercent *int `json:"threshold_percent"`
	} `json:"spare_available"`
	EnduranceUsed *struct {
		CurrentPercent *int `json:"current_percent"`
	} `json:"endurance_used"`
	NVMeLog struct {
		CriticalWarning         int     `json:"critical_warning"`
		Temperature             float64 `json:"temperature"`
		AvailableSpare          *int    `json:"available_spare"`
		AvailableSpareThreshold *int    `json:"available_spare_threshold"`
		PercentageUsed          *int    `json:"percentage_used"`
		DataUnitsRead           int64   `json:"data_units_read"`
		DataUnitsWritten        int64   `json:"data_units_written"`
		MediaErrors             int64   `json:"media_errors"`
		UnsafeShutdowns         int64   `json:"unsafe_shutdowns"`
		PowerOnHours            int64   `json:"power_on_hours"`
		PowerCycles             int64   `json:"power_cycles"`
	} `json:"nvme_smart_health_information_log"`
	ATASmartAttributes *struct {
		Table []struct {
			ID     int    `json:"id"`
			Name   string `json:"name"`
			Value  int    `json:"value"`
			Worst  int    `json:"worst"`
			Thresh int    `json:"thresh"`
			Raw    struct {
				Value  int64  `json:"value"`
				String string `json:"string"`
			} `json:"raw"`
		} `json:"table"`
	} `json:"ata_smart_attributes"`
}

func isStandbyHealthLabel(h string) bool {
	u := strings.ToUpper(strings.TrimSpace(h))
	return u == "STANDBY" || u == "SLEEP"
}

func isStandbySmartOutput(raw string) bool {
	upper := strings.ToUpper(raw)
	return strings.Contains(upper, "IN STANDBY MODE") ||
		strings.Contains(upper, "IN SLEEP MODE") ||
		strings.Contains(upper, `"NAME": "STANDBY"`) ||
		strings.Contains(upper, `"NAME":"STANDBY"`)
}

func parseEmbeddedSmartFromStatus(raw map[string]any) map[string]*smartctlJSON {
	out := map[string]*smartctlJSON{}
	for k, v := range raw {
		if !strings.HasPrefix(k, "nvme") && !strings.HasPrefix(k, "sd") {
			continue
		}
		s, ok := v.(string)
		if !ok || !strings.HasPrefix(strings.TrimSpace(s), "{") {
			continue
		}
		var doc smartctlJSON
		if json.Unmarshal([]byte(s), &doc) == nil && doc.SerialNumber != "" {
			doc.RawText = strings.TrimSpace(s)
			cp := doc
			out[strings.TrimSpace(doc.SerialNumber)] = &cp
		}
	}
	return out
}

func formatNVMeDataUnits(units int64) string {
	b := float64(units) * 512000.0
	if b >= 1e12 {
		return fmt.Sprintf("%.2f TB", b/1e12)
	}
	return fmt.Sprintf("%.1f GB", b/1e9)
}

func applyDiskSMARTResp(item *DiskHardwareItem, sm *DiskSMARTResp) {
	if sm == nil {
		return
	}
	if sm.Health != "" {
		item.Health = sm.Health
	}
	item.SMARTText = sm.Text
	parseSmartText(item, sm.Text)
	for _, attr := range sm.Attributes {
		lower := strings.ToLower(attr.Name)
		if (strings.Contains(lower, "temperature") || attr.ID == 194 || attr.ID == 190) && item.TempC == nil {
			if v, ok := extractFirstFloat(attr.Raw); ok && v > 0 && v < 120 {
				item.TempC = &v
			}
		} else if (attr.ID == 9 || strings.Contains(lower, "power_on_hours")) && item.PowerOnHours == nil {
			if v, ok := extractFirstInt64(attr.Raw); ok {
				item.PowerOnHours = &v
			}
		} else if (attr.ID == 12 || strings.Contains(lower, "power_cycle")) && item.PowerCycles == nil {
			if v, ok := extractFirstInt64(attr.Raw); ok {
				item.PowerCycles = &v
			}
		} else if (attr.ID == 5 || strings.Contains(lower, "reallocated_sector")) && item.ReallocatedSectors == nil {
			if v, ok := extractFirstInt64(attr.Raw); ok {
				item.ReallocatedSectors = &v
			}
		} else if (attr.ID == 197 || strings.Contains(lower, "current_pending_sector")) && item.PendingSectors == nil {
			if v, ok := extractFirstInt64(attr.Raw); ok {
				item.PendingSectors = &v
			}
		} else if (attr.ID == 198 || strings.Contains(lower, "offline_uncorrectable")) && item.MediaErrors == nil {
			if v, ok := extractFirstInt64(attr.Raw); ok {
				item.MediaErrors = &v
			}
		} else if (attr.ID == 231 || attr.ID == 233 || strings.Contains(lower, "ssd_life_left") || strings.Contains(lower, "media_wearout")) && item.WearoutPct == nil {
			val := int(attr.Value)
			if val >= 0 && val <= 100 {
				item.WearoutPct = &val
				u := 100 - val
				item.UsedLifePct = &u
			}
		} else if (attr.ID == 232 || strings.Contains(lower, "available_reservd_space")) && item.AvailableSparePct == nil {
			val := int(attr.Value)
			if val >= 0 && val <= 100 {
				item.AvailableSparePct = &val
			}
		}
	}
}

func applySmartJSON(item *DiskHardwareItem, doc *smartctlJSON) {
	if doc == nil {
		return
	}
	if doc.RawText != "" && item.SMARTText == "" {
		item.SMARTText = doc.RawText
	}
	if doc.SmartStatus != nil && doc.SmartStatus.Passed != nil {
		if *doc.SmartStatus.Passed && item.Health == "" {
			item.Health = "PASSED"
		} else if !*doc.SmartStatus.Passed && item.Health == "" {
			item.Health = "FAILED"
		}
	}
	temp := doc.Temperature.Current
	if temp == 0 {
		temp = doc.NVMeLog.Temperature
	}
	if temp > 0 && temp < 120 {
		item.TempC = &temp
	}
	poh := doc.PowerOnTime.Hours
	if poh == 0 {
		poh = doc.NVMeLog.PowerOnHours
	}
	if poh > 0 {
		item.PowerOnHours = &poh
	}
	pc := doc.PowerCycleCount
	if pc == 0 {
		pc = doc.NVMeLog.PowerCycles
	}
	if pc > 0 {
		item.PowerCycles = &pc
	}
	if doc.SpareAvailable != nil {
		if doc.SpareAvailable.CurrentPercent != nil {
			v := *doc.SpareAvailable.CurrentPercent
			item.AvailableSparePct = &v
		}
		if doc.SpareAvailable.ThresholdPercent != nil {
			v := *doc.SpareAvailable.ThresholdPercent
			item.AvailableSpareThresholdPct = &v
		}
	}
	if doc.EnduranceUsed != nil && doc.EnduranceUsed.CurrentPercent != nil {
		used := *doc.EnduranceUsed.CurrentPercent
		if used >= 0 && used <= 100 {
			item.UsedLifePct = &used
			if item.WearoutPct == nil {
				rem := 100 - used
				item.WearoutPct = &rem
			}
		}
	}
	if doc.NVMeLog.DataUnitsRead > 0 {
		item.DataRead = formatNVMeDataUnits(doc.NVMeLog.DataUnitsRead)
	}
	if doc.NVMeLog.DataUnitsWritten > 0 {
		item.DataWritten = formatNVMeDataUnits(doc.NVMeLog.DataUnitsWritten)
	}
	if item.Type == "nvme" {
		cw := doc.NVMeLog.CriticalWarning
		item.CriticalWarning = &cw
		me := doc.NVMeLog.MediaErrors
		item.MediaErrors = &me
		if doc.NVMeLog.UnsafeShutdowns > 0 {
			us := doc.NVMeLog.UnsafeShutdowns
			item.UnsafeShutdowns = &us
		}
		if doc.NVMeLog.AvailableSpare != nil && item.AvailableSparePct == nil {
			v := *doc.NVMeLog.AvailableSpare
			item.AvailableSparePct = &v
		}
		if doc.NVMeLog.AvailableSpareThreshold != nil && item.AvailableSpareThresholdPct == nil {
			v := *doc.NVMeLog.AvailableSpareThreshold
			item.AvailableSpareThresholdPct = &v
		}
		if doc.NVMeLog.PercentageUsed != nil {
			used := *doc.NVMeLog.PercentageUsed
			if used >= 0 && used <= 255 {
				item.UsedLifePct = &used
				if item.WearoutPct == nil {
					rem := 100 - used
					if rem < 0 {
						rem = 0
					}
					item.WearoutPct = &rem
				}
			}
		}
	}
	if doc.ATASmartAttributes != nil {
		for _, attr := range doc.ATASmartAttributes.Table {
			lower := strings.ToLower(attr.Name)
			switch {
			case attr.ID == 5 || strings.Contains(lower, "reallocated_sector"):
				v := attr.Raw.Value
				item.ReallocatedSectors = &v
			case attr.ID == 197 || strings.Contains(lower, "current_pending_sector"):
				v := attr.Raw.Value
				item.PendingSectors = &v
			case attr.ID == 198 || strings.Contains(lower, "offline_uncorrectable"):
				v := attr.Raw.Value
				item.MediaErrors = &v
			case (attr.ID == 231 || attr.ID == 233 || strings.Contains(lower, "ssd_life_left") || strings.Contains(lower, "media_wearout")) && item.WearoutPct == nil:
				if attr.Value >= 0 && attr.Value <= 100 {
					v := attr.Value
					item.WearoutPct = &v
					u := 100 - v
					item.UsedLifePct = &u
				}
			case (attr.ID == 232 || strings.Contains(lower, "available_reservd_space")) && item.AvailableSparePct == nil:
				if attr.Value >= 0 && attr.Value <= 100 {
					v := attr.Value
					item.AvailableSparePct = &v
				}
			case (attr.ID == 194 || attr.ID == 190 || strings.Contains(lower, "temperature")) && item.TempC == nil:
				if attr.Raw.Value > 0 && attr.Raw.Value < 120 {
					t := float64(attr.Raw.Value)
					item.TempC = &t
				} else if v, ok := extractFirstFloat(attr.Raw.String); ok && v > 0 && v < 120 {
					item.TempC = &v
				}
			}
		}
	}
}

func computeDiskHealth(item *DiskHardwareItem, smartPkgMissing bool) {
	healthUpper := strings.ToUpper(strings.TrimSpace(item.Health))
	if isStandbyHealthLabel(healthUpper) {
		item.TelemetryStatus = "partial"
		item.HealthGrade = "unknown"
		item.TelemetryNote = "硬盘处于休眠待机 (STANDBY) 状态，已跳过唤醒检测"
		return
	}
	hasSmartData := item.SMARTText != "" || item.WearoutPct != nil || item.TempC != nil || item.PowerOnHours != nil ||
		healthUpper == "PASSED" || healthUpper == "OK" || healthUpper == "FAILED"

	if smartPkgMissing && !hasSmartData {
		item.TelemetryStatus = "missing_pkg"
		item.HealthGrade = "unknown"
		item.TelemetryNote = "宿主机未安装 smartmontools，无法采集硬盘健康度百分比、温度与 SMART 属性"
		return
	}
	if !hasSmartData {
		item.TelemetryStatus = "partial"
		item.HealthGrade = "unknown"
		item.TelemetryNote = "此设备未返回 SMART 数据（可能为虚拟盘、RAID 控制器屏蔽或设备休眠）"
		return
	}

	if item.SMARTText != "" && (item.TempC != nil || item.WearoutPct != nil || item.PowerOnHours != nil) {
		item.TelemetryStatus = "full"
	} else {
		item.TelemetryStatus = "partial"
	}

	score := 100
	var reasons []string

	if item.WearoutPct != nil {
		score = *item.WearoutPct
		if item.UsedLifePct != nil {
			reasons = append(reasons, fmt.Sprintf("剩余寿命 %d%%（已损耗 %d%%）", *item.WearoutPct, *item.UsedLifePct))
		} else {
			reasons = append(reasons, fmt.Sprintf("剩余寿命 %d%%", *item.WearoutPct))
		}
	} else if healthUpper == "PASSED" || healthUpper == "OK" {
		reasons = append(reasons, "SMART 自检通过 (PASSED)")
	}

	if healthUpper == "FAILED" {
		if score > 15 {
			score = 15
		}
		reasons = append(reasons, "SMART 总体状态 FAILED（严重风险）")
	}

	if item.CriticalWarning != nil && *item.CriticalWarning != 0 {
		if score > 30 {
			score = 30
		}
		reasons = append(reasons, fmt.Sprintf("NVMe 触发关键告警标志 (0x%x)", *item.CriticalWarning))
	}

	if item.AvailableSparePct != nil {
		thresh := 10
		if item.AvailableSpareThresholdPct != nil && *item.AvailableSpareThresholdPct > 0 {
			thresh = *item.AvailableSpareThresholdPct
		}
		if *item.AvailableSparePct <= thresh {
			score -= 35
			reasons = append(reasons, fmt.Sprintf("可用备用块 %d%% 低于安全阈值 (%d%%)", *item.AvailableSparePct, thresh))
		} else if *item.AvailableSparePct < 50 {
			score -= 10
			reasons = append(reasons, fmt.Sprintf("可用备用块降至 %d%%", *item.AvailableSparePct))
		} else {
			reasons = append(reasons, fmt.Sprintf("可用备用块 %d%%", *item.AvailableSparePct))
		}
	}

	if item.MediaErrors != nil && *item.MediaErrors > 0 {
		pen := int(*item.MediaErrors) * 5
		if pen > 40 {
			pen = 40
		}
		score -= pen
		reasons = append(reasons, fmt.Sprintf("检测到 %d 个介质/不可纠正错误", *item.MediaErrors))
	}
	if item.ReallocatedSectors != nil && *item.ReallocatedSectors > 0 {
		pen := int(*item.ReallocatedSectors) * 2
		if pen > 30 {
			pen = 30
		}
		score -= pen
		reasons = append(reasons, fmt.Sprintf("重映射扇区 %d 个", *item.ReallocatedSectors))
	}
	if item.PendingSectors != nil && *item.PendingSectors > 0 {
		pen := int(*item.PendingSectors) * 4
		if pen > 35 {
			pen = 35
		}
		score -= pen
		reasons = append(reasons, fmt.Sprintf("待映射不稳定扇区 %d 个", *item.PendingSectors))
	}
	if item.TempC != nil {
		if *item.TempC >= 72 {
			score -= 10
			reasons = append(reasons, fmt.Sprintf("温度偏高 (%.0f°C)", *item.TempC))
		} else if *item.TempC >= 62 {
			score -= 4
			reasons = append(reasons, fmt.Sprintf("温度略高 (%.0f°C)", *item.TempC))
		}
	}

	if score < 0 {
		score = 0
	}
	if score > 100 {
		score = 100
	}
	item.HealthPct = &score
	item.HealthReasons = reasons

	switch {
	case score >= 90 && healthUpper != "FAILED":
		item.HealthGrade = "excellent"
	case score >= 75 && healthUpper != "FAILED":
		item.HealthGrade = "good"
	case score >= 45 && healthUpper != "FAILED":
		item.HealthGrade = "warning"
	default:
		item.HealthGrade = "critical"
	}
}

var (
	reTemp        = regexp.MustCompile(`(?i)Temperature:\s+(\d+(?:\.\d+)?)\s*Celsius`)
	rePOH         = regexp.MustCompile(`(?i)Power On Hours:\s+([\d,]+)`)
	rePC          = regexp.MustCompile(`(?i)Power Cycles:\s+([\d,]+)`)
	reUnsafe      = regexp.MustCompile(`(?i)Unsafe Shutdowns:\s+([\d,]+)`)
	reRead        = regexp.MustCompile(`(?i)Data Units Read:.*\[([^\]]+)\]`)
	reWritten     = regexp.MustCompile(`(?i)Data Units Written:.*\[([^\]]+)\]`)
	reMediaE      = regexp.MustCompile(`(?i)Media and Data Integrity Errors:\s+([\d,]+)`)
	rePctUsed     = regexp.MustCompile(`(?i)Percentage Used:\s+(\d+)%`)
	reAvailSpare  = regexp.MustCompile(`(?i)Available Spare:\s+(\d+)%`)
	reSpareThresh = regexp.MustCompile(`(?i)Available Spare Threshold:\s+(\d+)%`)
	reCritWarn    = regexp.MustCompile(`(?i)Critical Warning:\s+0x([0-9a-fA-F]+)`)
)

func parseSmartText(item *DiskHardwareItem, text string) {
	if text == "" {
		return
	}
	if m := reTemp.FindStringSubmatch(text); len(m) == 2 && item.TempC == nil {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil {
			item.TempC = &v
		}
	}
	if m := rePOH.FindStringSubmatch(text); len(m) == 2 && item.PowerOnHours == nil {
		if v, err := strconv.ParseInt(strings.ReplaceAll(m[1], ",", ""), 10, 64); err == nil {
			item.PowerOnHours = &v
		}
	}
	if m := rePC.FindStringSubmatch(text); len(m) == 2 && item.PowerCycles == nil {
		if v, err := strconv.ParseInt(strings.ReplaceAll(m[1], ",", ""), 10, 64); err == nil {
			item.PowerCycles = &v
		}
	}
	if m := reUnsafe.FindStringSubmatch(text); len(m) == 2 && item.UnsafeShutdowns == nil {
		if v, err := strconv.ParseInt(strings.ReplaceAll(m[1], ",", ""), 10, 64); err == nil {
			item.UnsafeShutdowns = &v
		}
	}
	if m := reRead.FindStringSubmatch(text); len(m) == 2 && item.DataRead == "" {
		item.DataRead = strings.TrimSpace(m[1])
	}
	if m := reWritten.FindStringSubmatch(text); len(m) == 2 && item.DataWritten == "" {
		item.DataWritten = strings.TrimSpace(m[1])
	}
	if m := reMediaE.FindStringSubmatch(text); len(m) == 2 && item.MediaErrors == nil {
		if v, err := strconv.ParseInt(strings.ReplaceAll(m[1], ",", ""), 10, 64); err == nil {
			item.MediaErrors = &v
		}
	}
	if m := rePctUsed.FindStringSubmatch(text); len(m) == 2 {
		if used, err := strconv.Atoi(m[1]); err == nil && used >= 0 && used <= 255 {
			item.UsedLifePct = &used
			if item.WearoutPct == nil {
				rem := 100 - used
				if rem < 0 {
					rem = 0
				}
				item.WearoutPct = &rem
			}
		}
	}
	if m := reAvailSpare.FindStringSubmatch(text); len(m) == 2 && item.AvailableSparePct == nil {
		if v, err := strconv.Atoi(m[1]); err == nil && v >= 0 && v <= 100 {
			item.AvailableSparePct = &v
		}
	}
	if m := reSpareThresh.FindStringSubmatch(text); len(m) == 2 && item.AvailableSpareThresholdPct == nil {
		if v, err := strconv.Atoi(m[1]); err == nil && v >= 0 && v <= 100 {
			item.AvailableSpareThresholdPct = &v
		}
	}
	if m := reCritWarn.FindStringSubmatch(text); len(m) == 2 && item.CriticalWarning == nil {
		if v, err := strconv.ParseInt(m[1], 16, 32); err == nil {
			iv := int(v)
			item.CriticalWarning = &iv
		}
	}
}

func parseIntAny(v any) (int, bool) {
	switch x := v.(type) {
	case float64:
		return int(x), true
	case int:
		return x, true
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(x))
		return n, err == nil
	default:
		return 0, false
	}
}

var reFirstNum = regexp.MustCompile(`-?\d+(?:\.\d+)?`)

func extractFirstFloat(s string) (float64, bool) {
	m := reFirstNum.FindString(s)
	if m == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(m, 64)
	return v, err == nil
}

func extractFirstInt64(s string) (int64, bool) {
	m := reFirstNum.FindString(s)
	if m == "" {
		return 0, false
	}
	v, err := strconv.ParseInt(strings.Split(m, ".")[0], 10, 64)
	return v, err == nil
}
