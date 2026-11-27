# Overview Page Overrides

> **PROJECT:** PVE Dash
> **Generated:** 2026-11-26 21:54:59
> **Page Type:** Dashboard / Data View

> ⚠️ **IMPORTANT:** Rules in this file **override** the Master file (`design-system/MASTER.md`).
> Only deviations from the Master are documented here. For all other rules, refer to the Master.

---

## Page-Specific Rules

### Layout Overrides

- **Max Width:** 1200px (standard)
- **Layout:** Full-width sections, centered content
- **Sections:** Hero (product + live preview or status) > Key metrics/indicators > How it works > CTA (Start trial / Contact)

### Spacing Overrides

- No overrides — use Master spacing

### Typography Overrides

- No overrides — use Master typography

### Color Overrides

- **Strategy:** Dark or neutral. Status colors (green/amber/red). Data-dense but scannable.

### Component Overrides

- Avoid: No indication of progress
- Avoid: Draw tens of thousands of individual or DOM markers at every zoom level
- Avoid: Promise an exact final line or insert blanket nonbreaking spaces or hardcoded br tags

---

## Page-Specific Components

- No unique components for this page

---

## Recommendations

- Effects: Minimal glow (text-shadow: 0 0 10px), dark-to-light transitions, low white emission, high readability, visible focus
- Feedback: Step indicators or progress bar
- Maps: Cluster points at low zoom with a count label, set clusterMaxZoom, and zoom into a cluster on click or Enter
- Typography: Bound the measure and test natural-wrap fallback across widths fonts and locales
- CTA Placement: Primary CTA in nav + After metrics
