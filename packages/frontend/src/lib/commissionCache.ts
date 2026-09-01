import type { QueryClient } from '@tanstack/react-query'

const commissionDataQueryKeys = [
  ['commission-own-summary'],
  ['commission-own-daily'],
  ['commission-own-potential'],
  ['commission-own-transactions'],
  ['commission-own-history'],
  ['commission-management-transactions'],
  ['commission-settlements'],
  ['management-commission'],
  ['commission-by-salesperson'],
  ['dashboard-drilldown']
]

/**
 * Marks every commission result that can change after an order workflow event
 * as stale. Prefix matching also covers paginated and date-filtered queries.
 */
export function invalidateCommissionData(queryClient: QueryClient) {
  return Promise.all(
    commissionDataQueryKeys.map(queryKey => queryClient.invalidateQueries({ queryKey }))
  )
}
