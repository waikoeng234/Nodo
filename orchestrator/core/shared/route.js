// The routing decision for one delegation, pure so it can be tested directly:
// roster order decides among takers; unclaimed types go to the fallback card.
export const route = ({ type, hard }, roster, fallback) => {
  const accepting = roster.filter(profile => profile.taskTypes?.includes(type))
  if (!accepting.length) return fallback
    ? { profile: fallback, choices: hard && fallback.hard ? fallback.hard : {}, by: 'fallback' } : { miss: true }
  if (hard) {
    const profile = accepting.find(profile => profile.hard !== undefined)
    return profile ? { profile, choices: profile.hard, by: 'route' } : { miss: true }
  }
  const profile = accepting.find(profile => profile.hard === undefined) ?? accepting[0]
  return profile ? { profile, choices: {}, by: 'route' } : { miss: true }
}
