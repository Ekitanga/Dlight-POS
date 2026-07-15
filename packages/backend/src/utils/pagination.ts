export interface Pagination {
  page: number
  pageSize: number
  offset: number
}

export function paginationFromQuery(query: Record<string, unknown>): Pagination | null {
  if (query.page === undefined && query.page_size === undefined) return null
  const page = Math.max(1, Math.trunc(Number(query.page) || 1))
  const pageSize = Math.min(100, Math.max(10, Math.trunc(Number(query.page_size) || 25)))
  return { page, pageSize, offset: (page - 1) * pageSize }
}

export function paginatedResponse<T>(rows: T[], total: number, pagination: Pagination) {
  return {
    data: rows,
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pagination.pageSize))
    }
  }
}
