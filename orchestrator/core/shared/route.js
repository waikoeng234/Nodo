// The routing decision for one delegation, pure so it can be tested directly:
// a user assignee overrides everything, otherwise the roster order decides.
export const route = ({ type, hard }, roster, assignee) => {
  if (assignee) return { profile: assignee, choices: hard && assignee.hard ? assignee.hard : {}, by: 'assignee' }
  const accepting = roster.filter(profile => profile.taskTypes?.includes(type))
  if (hard) {
    const profile = accepting.find(profile => profile.hard !== undefined)
    return profile ? { profile, choices: profile.hard, by: 'route' } : { miss: true }
  }
  const profile = accepting.find(profile => profile.hard === undefined) ?? accepting[0]
  return profile ? { profile, choices: {}, by: 'route' } : { miss: true }
}
