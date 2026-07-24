import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { useState } from 'react'
import { Check, CheckCheck } from 'lucide-react'
import { PaginatedResponse, Pagination } from '../../components/Pagination'

interface NotificationRow {
  id: string
  title: string
  message: string
  type: string
  entity_type?: string
  entity_id?: string
  is_read: boolean
  created_at: string
}

export function Notifications() {
  const [type, setType] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const params = new URLSearchParams()
  if (type) params.set('type', type)
  params.set('page', String(page))
  params.set('page_size', String(pageSize))

  const { data, isLoading, refetch } = useQuery<PaginatedResponse<NotificationRow>>({
    queryKey: ['notifications', type, page, pageSize],
    queryFn: async () => (await axios.get(`/api/notifications?${params.toString()}`)).data
  })

  const markRead = async (id: string) => {
    await axios.post(`/api/notifications/${id}/read`)
    refetch()
  }

  const markAllRead = async () => {
    await axios.post('/api/notifications/read-all')
    refetch()
  }

  const notifications = data?.data || []
  const unreadCount = notifications.filter((n: NotificationRow) => !n.is_read).length

  const typeTone = (type: string) => {
    if (type === 'low_stock') return 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-200'
    if (type === 'inventory_adjustment') return 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200'
    if (type === 'order_status') return 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-200'
    return 'bg-slate-100 text-slate-700 dark:bg-slate-950/50 dark:text-slate-200'
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Notifications</h1>
          <p className="text-muted-foreground">
            {unreadCount > 0 ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}` : 'All caught up'}
          </p>
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={markAllRead}
            className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted"
          >
            <CheckCheck className="h-4 w-4" /> Mark all read
          </button>
        )}
      </div>

      <div className="rounded-xl border bg-card p-3 shadow-sm">
        <div className="grid gap-2 md:grid-cols-3">
          <select
            value={type}
            onChange={event => { setType(event.target.value); setPage(1) }}
            className="w-full rounded-lg border bg-background px-3 py-2"
          >
            <option value="">All types</option>
            <option value="low_stock">Low stock</option>
            <option value="inventory_adjustment">Inventory adjustment</option>
            <option value="order_status">Order status</option>
            <option value="system">System</option>
          </select>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground">Loading notifications...</div>
        ) : notifications.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">No notifications match these filters.</div>
        ) : (
          <div className="mobile-scroll-table overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/80">
                <tr>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">Title</th>
                  <th className="px-4 py-3 text-left">Message</th>
                  <th className="px-4 py-3 text-left">When</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {notifications.map((row: NotificationRow) => (
                  <tr key={row.id} className={`border-t align-top hover:bg-muted/30 ${!row.is_read ? 'bg-muted/30' : ''}`}>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${typeTone(row.type)}`}>
                        {row.type.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{row.title}</div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{row.message}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {new Date(row.created_at).toLocaleString()}
                    </td>
                    <td className="text-right">
                      {!row.is_read && (
                        <button
                          type="button"
                          title="Mark as read"
                          onClick={() => markRead(row.id)}
                          className="rounded-lg border p-2 hover:bg-muted"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <Pagination meta={data.pagination} onPageChange={setPage} onPageSizeChange={(size: number) => { setPageSize(size); setPage(1) }} />
        )}
      </div>
    </div>
  )
}
