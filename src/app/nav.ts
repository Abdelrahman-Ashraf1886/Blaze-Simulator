import {
  Activity,
  Box,
  Cable,
  Cpu,
  FolderKanban,
  Gamepad2,
  Gauge,
  LayoutDashboard,
  ListChecks,
  Plane,
  Settings,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react'

export type NavGroup = 'overview' | 'engineering' | 'flight' | 'workspace'

export interface NavItem {
  path: string
  label: string
  icon: LucideIcon
  group: NavGroup
  /** Roadmap phase that delivers this section. Later sections are disabled unless marked ready. */
  phase: number
  /** True once a section is available, including previews ahead of the phase in progress. */
  ready?: boolean
}

/** Phase in progress in this build; its sections are enabled as they are built. */
export const CURRENT_PHASE = 7

/** Sidebar order. Groups only add visual separation. */
export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard, group: 'overview', phase: 1 },
  { path: '/workshop', label: 'Drone Workshop', icon: Box, group: 'engineering', phase: 2 },
  { path: '/components', label: 'Components', icon: Cpu, group: 'engineering', phase: 3, ready: true },
  { path: '/electrical', label: 'Electrical Designer', icon: Cable, group: 'engineering', phase: 3, ready: true },
  { path: '/analysis', label: 'Engineering Analysis', icon: Gauge, group: 'engineering', phase: 4, ready: true },
  { path: '/flight', label: 'Flight Simulator', icon: Plane, group: 'flight', phase: 4, ready: true },
  { path: '/scenarios', label: 'Scenarios', icon: ListChecks, group: 'flight', phase: 4, ready: true },
  { path: '/tuning', label: 'Tuning', icon: SlidersHorizontal, group: 'flight', phase: 5, ready: true },
  { path: '/input', label: 'Input devices', icon: Gamepad2, group: 'flight', phase: 6, ready: true },
  { path: '/telemetry', label: 'Telemetry', icon: Activity, group: 'flight', phase: 7 },
  { path: '/projects', label: 'Projects', icon: FolderKanban, group: 'workspace', phase: 1 },
  { path: '/settings', label: 'Settings', icon: Settings, group: 'workspace', phase: 8 },
]

export const GROUP_LABELS: Partial<Record<NavGroup, string>> = {
  engineering: 'Engineering',
  flight: 'Flight',
}

export const isAvailable = (item: NavItem) =>
  item.phase < CURRENT_PHASE || item.ready === true
