export const isNewer = (base, candidate) => {
  const parse = value => typeof value === 'string' && /^v?\d+\.\d+\.\d+$/i.test(value) ? value.replace(/^v/i, '').split('.').map(Number) : null
  const a = parse(typeof base === 'string' ? base.split(/[-+]/)[0] : base ?? '0.0.0'), b = parse(candidate ?? '')
  if (!a || !b) return false
  for (let index = 0; index < 3; index++) if (b[index] !== a[index]) return b[index] > a[index]
  return false
}
