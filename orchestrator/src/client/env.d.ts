// The shell seeds both packages into the module table; exact component types
// arrive when a surface needs them.
declare module '@deepseek-ai/dsh-client-ui-primitives';
declare module '*.css' {
  const css: string
  export default css
}

declare module '*.png' {
  const src: string;
  export default src;
}

declare module 'nodo:engine-logos' {
  export const ENGINE_LOGO_SVGS: Record<string, string>;
}

declare module 'nodo:engine-names' {
  export const ENGINE_NAMES: Record<string, string>;
}
