// Thrown-on-purpose errors carry an orch/ code: channel.js logs anything else
// with its stack, and the client maps the code to its own wording.
export const failure = (message, code) => Object.assign(new Error(message), { code })
export const invalid = message => failure(message, 'orch/invalid')
