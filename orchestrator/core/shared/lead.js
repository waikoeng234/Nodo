// Engines whose driver is wired to the nodo_lead MCP service may lead; every
// other engine only executes. Extend as more drivers pass acceptance.
export const LEAD_ENGINES = ['claude']

// A lead card's session runs with lead capabilities (MCP, lead rules) unless it
// was opened as a plain 1:1 chat from the session view; sessions saved before
// the flag exist default to lead mode. Where only the conversation object is at
// hand — prepareConversation's profile+session spread — pass it as both args.
export const leadModeOf = (profile, session) => profile?.lead === true && session?.leadMode !== false

