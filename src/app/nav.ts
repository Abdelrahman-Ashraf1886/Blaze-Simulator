import {
  Activity,
  Box,
  Cable,
  Cpu,
  FolderKanban,
  Gauge,
  LayoutDashboard,
  Plane,
  Settings,
  type LucideIcon,
} from 'lucide-react'

export type NavGroup = 'overview' | 'engineering' | 'flight' | 'workspace'

export interface NavItem {
  path: string
  label: string
  icon: LucideIcon
  group: NavGroup
  /** Roadmap phase that delivers this section. Items above the current phase are disabled. */
  phase: number
  /** For sections of the phase in progress: true once the section is built. */
  ready?: boolean
}

/** Phase in progress in this build; its sections are enabled as they are built. */
export const CURRENT_PHASE = 3

/** Spec order (1–9). Groups only add visual separation; they never reorder. */
export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard, group: 'overview', phase: 1 },
  { path: '/workshop', label: 'Drone Workshop', icon: Box, group: 'engineering', phase: 2 },
  { path: '/components', label: 'Components', icon: Cpu, group: 'engineering', phase: 3, ready: true },
  { path: '/electrical', label: 'Electrical Designer', icon: Cable, group: 'engineering', phase: 3 },
  { path: '/analysis', label: 'Engineering Analysis', icon: Gauge, group: 'engineering', phase: 4 },
  { path: '/simulator', label: 'Flight Simulator', icon: Plane, group: 'flight', phase: 6 },
  { path: '/telemetry', label: 'Telemetry', icon: Activity, group: 'flight', phase: 7 },
  { path: '/projects', label: 'Projects', icon: FolderKanban, group: 'workspace', phase: 1 },
  { path: '/settings', label: 'Settings', icon: Settings, group: 'workspace', phase: 8 },
]

export const GROUP_LABELS: Partial<Record<NavGroup, string>> = {
  engineering: 'Engineering',
  flight: 'Flight',
}

export const isAvailable = (item: NavItem) =>
  item.phase < CURRENT_PHASE || (item.phase === CURRENT_PHASE && item.ready === true)
