export const compareUtf16CodeUnits = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') {
    throw new TypeError('CODE_UNIT_ORDER_INVALID')
  }
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}
