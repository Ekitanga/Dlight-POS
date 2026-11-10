import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { useAuthStore } from '../stores/authStore'

export type TitheBasis = 'net_profit' | 'gross_profit' | 'revenue'

export interface TitheSettings {
  enabled: boolean
  rate_percent: number
  basis: TitheBasis
  start_date: string
  recipient_name: string | null
  updated_at: string | null
}

export const titheBasisLabels: Record<TitheBasis, { label: string; help: string }> = {
  net_profit: {
    label: 'Net profit',
    help: 'Sales minus cost of goods, supplier costs, delivery costs and approved expenses. What the business actually earned.'
  },
  gross_profit: {
    label: 'Gross profit',
    help: 'Sales minus cost of goods and supplier costs, before running expenses.'
  },
  revenue: {
    label: 'Total sales (revenue)',
    help: 'Every shilling of completed sales, before any costs are taken off.'
  }
}

export function isOwnerOrAdmin(role?: string | null) {
  return role === 'admin' || role === 'owner'
}

/** Tithe settings, fetched only for owners and administrators. */
export function useTitheSettings() {
  const role = useAuthStore(state => state.user?.role)
  return useQuery<TitheSettings>({
    queryKey: ['tithe-settings'],
    queryFn: async () => (await axios.get('/api/tithe/settings')).data,
    enabled: isOwnerOrAdmin(role),
    staleTime: 60_000
  })
}
