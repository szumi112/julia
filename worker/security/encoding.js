const invalid = () => {
  throw new TypeError('INVALID_BASE64URL')
}

export function encodeBase64Url(bytes) {
  let view
  if (bytes instanceof ArrayBuffer) view = new Uint8Array(bytes)
  else if (ArrayBuffer.isView(bytes)) view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  else invalid()
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < view.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, view.length)
    let chunk = ''
    for (let index = offset; index < end; index += 1) chunk += String.fromCharCode(view[index])
    binary += chunk
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) invalid()
  const standard = value.replaceAll('-', '+').replaceAll('_', '/')
  let binary
  try {
    binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='))
  } catch {
    invalid()
  }
  const decoded = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) decoded[index] = binary.charCodeAt(index)
  if (encodeBase64Url(decoded) !== value) {
    decoded.fill(0)
    invalid()
  }
  return decoded
}
