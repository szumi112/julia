import { addMonths, pad2 } from './format.js'

export function periodMonthOptions(year, { min, max } = {}) {
  return Array.from({ length: 12 }, (_, index) => {
    const month = `${year}-${pad2(index + 1)}`
    return {
      month,
      disabled: !!((min && month < min) || (max && month > max)),
    }
  })
}

export function periodNavState({ month, min, max, current }) {
  const previous = addMonths(month, -1)
  const next = addMonths(month, 1)
  const currentDisabled = !!(!current || current === month
    || (min && current < min) || (max && current > max))
  return {
    previous,
    next,
    previousDisabled: !!min && previous < min,
    nextDisabled: !!max && next > max,
    currentDisabled,
  }
}
