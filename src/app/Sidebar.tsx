import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { NavLink } from 'react-router'
import { BrandMark } from '@/components/brand-mark'
import { readPref, writePref } from '@/lib/prefs'
import { useMediaQuery } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import { CURRENT_PHASE, GROUP_LABELS, NAV_ITEMS, isAvailable, type NavGroup, type NavItem } from './nav'

/** Below this width (CSS px, so zoom counts) the sidebar becomes an icon rail by default. */
export const RAIL_BREAKPOINT = 1180
const PREF_KEY = 'sidebar.collapsed'

export function Sidebar() {
  const wide = useMediaQuery(`(min-width: ${RAIL_BREAKPOINT}px)`)
  // null = follow the window width; true/false = the user's explicit choice.
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(() => readPref(PREF_KEY, null))
  const collapsed = userCollapsed ?? !wide

  const toggle = () => {
    setUserCollapsed(!collapsed)
    writePref(PREF_KEY, !collapsed)
  }

  const groups: NavGroup[] = ['overview', 'engineering', 'flight']
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose

  return (
    <aside
      id="sidebar"
      data-collapsed={collapsed}
      className={cn(
        'flex shrink-0 flex-col border-r border-line bg-chrome py-2',
        collapsed ? 'w-[52px] px-1.5' : 'w-[212px] px-2',
      )}
    >
      <div className={cn('mb-2 flex h-9 items-center gap-2.5', collapsed ? 'justify-center' : 'px-2')}>
        <BrandMark className="size-5 shrink-0" />
        {!collapsed && <span className="truncate text-[13px] font-semibold">Blaze UAV</span>}
      </div>

      {/* Scrolls (without a visible bar) only when zoomed far in on a short window. */}
      <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:none]" aria-label="Main">
        {groups.map((group) => (
          <NavSection key={group} label={GROUP_LABELS[group]} collapsed={collapsed}>
            {NAV_ITEMS.filter((i) => i.group === group).map((item) => (
              <NavEntry key={item.path} item={item} collapsed={collapsed} />
            ))}
          </NavSection>
        ))}
        <div className="mt-auto pt-3">
          {NAV_ITEMS.filter((i) => i.group === 'workspace').map((item) => (
            <NavEntry key={item.path} item={item} collapsed={collapsed} />
          ))}
        </div>
      </nav>

      <button
        type="button"
        onClick={toggle}
        aria-controls="sidebar"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className={cn(
          'mt-1 flex h-8 items-center gap-2.5 rounded-[var(--radius-sm)] text-[12.5px] text-fg-subtle hover:bg-hover hover:text-fg',
          collapsed ? 'justify-center' : 'px-2.5',
        )}
      >
        <ToggleIcon className="size-4 shrink-0" strokeWidth={1.75} />
        {!collapsed && 'Collapse'}
      </button>
    </aside>
  )
}

function NavSection({
  label,
  collapsed,
  children,
}: {
  label?: string
  collapsed: boolean
  children: ReactNode
}) {
  return (
    <div className="space-y-px">
      {label &&
        (collapsed ? (
          <div className="mx-2 my-2 border-t border-line" role="presentation" />
        ) : (
          <div className="px-2.5 pb-1 pt-4 text-[11.5px] font-medium text-fg-subtle">{label}</div>
        ))}
      {children}
    </div>
  )
}

function NavEntry({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const Icon = item.icon
  const base = cn(
    'relative flex h-8 items-center gap-2.5 rounded-[var(--radius-sm)] text-[13px]',
    collapsed ? 'justify-center' : 'px-2.5',
  )

  if (!isAvailable(item)) {
    const note =
      item.phase === CURRENT_PHASE
        ? `${item.label}: being built in roadmap Phase ${item.phase}, not available in this build yet`
        : `${item.label}: planned for roadmap Phase ${item.phase}, not available in this build`
    return (
      <div
        role="link"
        aria-disabled="true"
        aria-label={note}
        title={note}
        data-testid={`nav-${item.path}`}
        className={cn(base, 'cursor-default text-fg-subtle/60')}
      >
        <Icon className="size-4 shrink-0" strokeWidth={1.75} />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            <span className="num text-[10.5px] text-fg-subtle/80">P{item.phase}</span>
          </>
        )}
      </div>
    )
  }

  return (
    <NavLink
      to={item.path}
      end={item.path === '/'}
      data-testid={`nav-${item.path}`}
      aria-label={collapsed ? item.label : undefined}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        cn(
          base,
          isActive
            ? 'bg-hover text-fg before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-accent'
            : 'text-fg-muted hover:bg-hover/70 hover:text-fg',
        )
      }
    >
      <Icon className="size-4 shrink-0" strokeWidth={1.75} />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </NavLink>
  )
}
