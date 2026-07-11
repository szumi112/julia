// Pure page math for the shared pagination fallback (see ui.jsx: usePagination/Pager).
export const pageCount = (total, pageSize) => Math.max(1, Math.ceil(total / pageSize))
export const pageSlice = (items, page, pageSize) => items.slice((page - 1) * pageSize, page * pageSize)
