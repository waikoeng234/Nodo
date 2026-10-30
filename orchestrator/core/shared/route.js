// The routing decision for one delegation, pure so it can be tested directly:
// a team's assignment table names the role for a task type; a type with a hard
// pick sends hard work there, everything else goes to the normal pick.
export const route = (assign, type, hard) => {
  const entry = assign?.[type]
  const pick = hard && entry?.hard ? entry.hard : entry?.normal
  if (!pick?.profile) return { miss: true }
  return { profile: pick.profile, choices: Object.fromEntries(['model', 'thinking'].filter(key => pick[key]).map(key => [key, pick[key]])) }
}
