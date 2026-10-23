import { readFileSync } from 'node:fs'
import { PANEL_SOURCES } from '../../scripts/client-sources.mjs'

export const readPanelSource = () => PANEL_SOURCES.map(name =>
  readFileSync(new URL(`../../src/client/${name}.js`, import.meta.url), 'utf8').trimEnd()).join('\n\n')
