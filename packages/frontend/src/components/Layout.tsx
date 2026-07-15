import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { 
  LayoutDashboard, 
  Package, 
  Users, 
  Truck, 
  CreditCard, 
  Settings, 
  LogOut,
  Store,
  PackageCheck,
  UserRound,
  Menu,
  X,
  ClipboardList,
  Warehouse,
  UserCog,
  Receipt,
  BarChart3,
  History
} from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { ThemeToggle } from './ThemeToggle'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { useEffect } from 'react'
import { applyAppearance, AppearanceSettings } from '../lib/appearance'

const mobilePrimaryPaths = ['/dashboard', '/orders', '/products', '/inventory']

const navItems = [
  { path: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', permission: 'dashboard.view' },
  { path: '/orders', icon: Package, label: 'Orders', permission: 'orders.view' },
  { path: '/products', icon: Store, label: 'Products', permission: 'products.view' },
  { path: '/customers', icon: Users, label: 'Customers', permission: 'customers.view' },
  { path: '/suppliers', icon: PackageCheck, label: 'Suppliers', permission: 'suppliers.view' },
  { path: '/riders', icon: Truck, label: 'Riders', permission: 'riders.view' },
  { path: '/couriers', icon: Truck, label: 'Couriers', permission: 'couriers.view' },
  { path: '/deliveries', icon: ClipboardList, label: 'Deliveries', permission: 'deliveries.view' },
  { path: '/inventory', icon: Warehouse, label: 'Inventory', permission: 'inventory.view' },
  { path: '/receipts', icon: Receipt, label: 'Receipts', permission: 'receipts.view' },
  { path: '/expenses', icon: CreditCard, label: 'Expenses', permission: 'expenses.view' },
  { path: '/reports', icon: BarChart3, label: 'Reports', permission: 'reports.view' },
  { path: '/audit', icon: History, label: 'Audit Logs', permission: 'audit.view' },
  { path: '/users', icon: UserCog, label: 'Users', permission: 'users.view' },
  { path: '/settings', icon: Settings, label: 'Settings', permission: 'settings.view' },
]

export function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const { user, logout, hasPermission } = useAuthStore()
  const [mobileOpen, setMobileOpen] = useState(false)
  const { data: branding } = useQuery<{ company_name: string; logo_url?: string } & AppearanceSettings>({
    queryKey: ['branding'],
    queryFn: async () => (await axios.get('/api/auth/branding')).data
  })

  useEffect(() => {
    if (branding) applyAppearance(branding)
  }, [branding])

  return (
    <div className="app-shell flex h-screen bg-background">
      <aside className={`
        app-sidebar fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r transform transition-transform duration-200 ease-in-out
        ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
        lg:relative lg:translate-x-0 lg:w-64
      `}>
        <div className="brand-lockup flex h-16 items-center justify-between border-b px-4">
          <div className="flex min-w-0 items-center gap-2">
            {branding?.logo_url && <img src={branding.logo_url} alt="" className="h-8 w-8 shrink-0 rounded object-contain" />}
            <h1 className="truncate text-[15px] font-semibold uppercase text-primary">{branding?.company_name || 'Dlight POS'}</h1>
          </div>
          <button 
            onClick={() => setMobileOpen(false)}
            className="lg:hidden p-1 rounded-lg hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {navItems.filter(item => hasPermission(item.permission)).map((item) => {
            const Icon = item.icon
            const active = location.pathname === item.path
            return (
              <Link
                key={item.path}
                to={item.path}
                onClick={() => setMobileOpen(false)}
                className={`
                  nav-link mb-1 flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-all
                  ${active 
                    ? 'bg-primary text-primary-foreground shadow-sm' 
                    : 'hover:bg-muted text-foreground'
                  }
                `}
              >
                <Icon className="h-5 w-5" />
                <span>{item.label}</span>
              </Link>
            )
          })}
        </nav>
        
        <div className="sidebar-footer border-t p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center">
              <UserRound className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{user?.full_name}</p>
              <p className="text-xs text-muted-foreground capitalize">{user?.role}</p>
            </div>
            <ThemeToggle />
          </div>
          <button
            onClick={logout}
            className="flex items-center gap-3 px-3 py-2.5 w-full rounded-lg hover:bg-muted text-foreground transition-colors"
          >
            <LogOut className="h-5 w-5" />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      {mobileOpen && (
        <div 
          className="fixed inset-0 bg-black/20 z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <main className="app-main min-w-0 flex-1 overflow-auto overflow-x-hidden pb-20 lg:pb-0 lg:pl-0">
        <div className="mobile-topbar sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-card/95 px-3 backdrop-blur lg:hidden">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-2 rounded-lg hover:bg-muted"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex min-w-0 items-center gap-2">
            {branding?.logo_url && <img src={branding.logo_url} alt="" className="h-7 w-7 rounded object-contain" />}
            <h2 className="truncate text-sm font-semibold uppercase text-primary">{branding?.company_name || 'Dlight POS'}</h2>
          </div>
          <ThemeToggle />
        </div>
        <div className="page-container mx-auto w-full min-w-0 max-w-[1440px] p-4 sm:p-6 lg:p-8">
          {children}
        </div>
      </main>

      <nav className="mobile-bottom-nav fixed inset-x-0 bottom-0 z-40 grid h-[68px] grid-cols-5 border-t bg-card/95 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden" aria-label="Primary navigation">
        {navItems.filter(item => mobilePrimaryPaths.includes(item.path) && hasPermission(item.permission)).map(item => {
          const Icon = item.icon
          const active = location.pathname === item.path
          return (
            <Link key={item.path} to={item.path} className={`flex min-w-0 flex-col items-center justify-center gap-1 rounded-md text-[11px] font-medium ${active ? 'text-primary' : 'text-muted-foreground'}`}>
              <Icon className={`h-5 w-5 ${active ? 'stroke-[2.4]' : ''}`} />
              <span className="truncate">{item.label}</span>
            </Link>
          )
        })}
        <button type="button" onClick={() => setMobileOpen(true)} className="flex min-w-0 flex-col items-center justify-center gap-1 rounded-md text-[11px] font-medium text-muted-foreground" aria-label="Open more navigation">
          <Menu className="h-5 w-5" />
          <span>More</span>
        </button>
      </nav>
    </div>
  )
}
