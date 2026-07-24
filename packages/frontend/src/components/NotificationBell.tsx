import { useState, useEffect, useRef } from 'react'
import { Bell } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { Link } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'

interface Notification {
  id: string
  title: string
  message: string
  type: string
  entity_type?: string
  entity_id?: string
  is_read: boolean
  created_at: string
}

export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const user = useAuthStore(state => state.user)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const { data: unreadData } = useQuery({
    queryKey: ['notifications-unread'],
    queryFn: async () => (await axios.get('/api/notifications/unread-count')).data,
    enabled: !!user && (user.role === 'admin' || user.role === 'owner'),
    refetchInterval: 15000,
    refetchIntervalInBackground: false
  })

  const { data: recentData } = useQuery({
    queryKey: ['notifications-recent'],
    queryFn: async () => (await axios.get('/api/notifications?page_size=5')).data,
    enabled: !!user && (user.role === 'admin' || user.role === 'owner'),
    refetchInterval: 15000,
    refetchIntervalInBackground: false
  })

  const queryClient = useQueryClient()
  const markRead = useMutation({
    mutationFn: async (id: string) => (await axios.post(`/api/notifications/${id}/read`)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications-unread'] })
      queryClient.invalidateQueries({ queryKey: ['notifications-recent'] })
    }
  })

  const markAllRead = useMutation({
    mutationFn: async () => (await axios.post('/api/notifications/read-all')).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications-unread'] })
      queryClient.invalidateQueries({ queryKey: ['notifications-recent'] })
    }
  })

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  if (!user || (user.role !== 'admin' && user.role !== 'owner')) return null

  const unreadCount = unreadData?.count || 0
  const notifications: Notification[] = recentData?.data || []

  const accentForType = (type: string) => {
    if (type === 'low_stock') return 'border-l-red-500'
    if (type === 'inventory_adjustment') return 'border-l-amber-500'
    if (type === 'order_status') return 'border-l-blue-500'
    return 'border-l-slate-400'
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-destructive px-1 text-[11px] font-bold text-destructive-foreground ring-2 ring-background">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-[60] mt-2 w-[calc(100vw-2rem)] max-w-[360px] origin-top-left rounded-xl border bg-card shadow-xl">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
            <p className="text-sm font-semibold whitespace-nowrap">Notifications</p>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => markAllRead.mutate()}
                className="text-xs text-primary hover:underline whitespace-nowrap"
              >
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">No notifications yet</p>
            )}
            {notifications.map(notification => (
              <div
                key={notification.id}
                className={`border-b border-l-[3px] px-4 py-3 last:border-b-0 ${!notification.is_read ? 'bg-muted/50' : 'bg-card'} ${accentForType(notification.type)}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">{notification.title}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground break-words">{notification.message}</p>
                    <p className="mt-1.5 text-[10px] text-muted-foreground/80">
                      {new Date(notification.created_at).toLocaleString()}
                    </p>
                  </div>
                  {!notification.is_read && (
                    <button
                      type="button"
                      onClick={() => markRead.mutate(notification.id)}
                      className="shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium text-primary hover:bg-muted"
                    >
                      Read
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="border-t px-4 py-2.5">
            <Link
              to="/notifications"
              onClick={() => setOpen(false)}
              className="flex items-center justify-center text-xs font-medium text-primary hover:underline"
            >
              View all notifications
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
