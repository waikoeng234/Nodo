// The routing decision for one delegation, pure so it can be tested directly:
// roster order decides among roles accepting the task's type and difficulty.
export const route = ({ type, hard }, roster) => {
  const accepting = roster.filter(profile => profile.taskTypes?.includes(type))
  if (hard) {
    const profile = accepting.find(profile => profile.hard !== undefined)
    return profile ? { profile, choices: profile.hard } : { miss: true }
  }
  const profile = accepting.find(profile => profile.hard === undefined) ?? accepting[0]
  return profile ? { profile, choices: {} } : { miss: true }
}
