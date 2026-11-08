import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const lastUser = body => JSON.stringify(body.messages.findLast(message => message.role === 'user'))
const effectivePrompt = body => JSON.stringify(body.messages.findLast(message => message.role === 'system' && message.content?.some(block => block.type === 'text'))?.content ?? body.system)

export function createNativeUiProbe({ panel = false, mode = false, model = false } = {}) {
  const plugin = mkdtempSync(join(tmpdir(), 'nodo-native-ui-plugin-'))
  const workspace = mkdtempSync(join(tmpdir(), 'nodo-native-ui-workspace-'))
  const ordinaryWorkspace = mode ? mkdtempSync(join(tmpdir(), 'nodo-ordinary-workspace-')) : undefined
  writeFileSync(join(workspace, 'native-proof.md'), '# Native UI proof\n\nNODO_NATIVE_FILE_PREVIEW_OK\n')
  if (ordinaryWorkspace) writeFileSync(join(ordinaryWorkspace, 'ordinary-proof.md'), '# Ordinary space\n\nORDINARY_SPACE_FILE_OK\n')
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({
    name: 'nodo-native-ui-probe', version: '0.0.0', type: 'module', main: 'index.js',
    exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' },
    dsh: { client: { inject: ['@deepseek-ai/dsh-client-ui-sidebar'], platform: 'web' } },
  }))
  writeFileSync(join(plugin, 'index.js'), 'export function apply() {}\n')
  writeFileSync(join(plugin, 'client.js'), `window.__ModuleLoader__.load({
    id: 'nodo-native-ui-probe',
    factory: require => {
      const { createElement: h, useState } = require('react')
      const { Button } = require('@deepseek-ai/dsh-client-ui-primitives')
      return { inject: ['slots', 'uiWorkspace'], apply(ctx) {
        function Roles() {
          const [error, setError] = useState('')
          const open = async name => {
            try {
              const response = await fetch('/api/nodo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'state' }) })
              const state = await response.json()
              if (!state.ok) throw new Error('Cannot read probe roles')
              const role = state.value.profiles.find(role => role.name === name)
              const session = role?.sessions.find(session => session.driverSessionId)
              if (!session) throw new Error('Native session unavailable')
              ctx.uiWorkspace.openSession(session.driverSessionId)
            } catch (error) { setError(error.message) }
          }
          return h('div', null,
            h(Button, { size: 'sm', onClick: () => void open('Native integration') }, '验证 coder'),
            h(Button, { size: 'sm', onClick: () => void open('Native reviewer') }, '验证 reviewer'),
            error && h('span', { role: 'alert' }, error))
        }
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'nodo-native-ui-probe' }, Roles))
      } }
    }
  })\n`)
  if (panel || mode) {
    const source = readFileSync(new URL(mode ? './native-mode-client.cjs' : './native-panel-client.cjs', import.meta.url), 'utf8')
    writeFileSync(join(plugin, 'client.js'), `window.__ModuleLoader__.load({ id: 'nodo-native-ui-probe', factory: require => { const module = { exports: {} };\n${source}\nreturn module.exports; } })\n`)
  }
  // The model-seat probe answers two questions product code depends on: which
  // priority shadows the native picker (single slots render their lowest
  // live entry) and what prop table an occupant actually receives. The
  // browser drives window.__NODO_MODEL_PROBE.register(priority) both ways.
  if (model) {
    writeFileSync(join(plugin, 'client.js'), `window.__ModuleLoader__.load({
    id: 'nodo-native-ui-probe',
    factory: require => {
      const { createElement: h } = require('react')
      return { inject: ['slots'], apply(ctx) {
        const state = window.__NODO_MODEL_PROBE = { mounts: 0, propKeys: null, faces: [], lastPriority: null, registerError: '' }
        let unregister
        function Probe(props) {
          state.mounts += 1
          state.propKeys = Object.keys(props)
          return h('button', { type: 'button', 'data-nodo-model-probe': 'true' }, 'NODO_MODEL_SLOT_OK')
        }
        const register = priority => {
          try {
            unregister?.()
            unregister = ctx.slots.register({ name: 'conversation.input.model', priority,
              inject: sessionId => { state.faces.push(String(sessionId)); return { probeFace: true } } }, Probe)
            state.lastPriority = priority
            state.registerError = ''
          } catch (error) { state.registerError = String(error?.message ?? error) }
        }
        state.register = register
        ctx.slots.inject('conversation.input.model', () => register(-100))
      } }
    }
  })\n`)
    return {
      workspace,
      patch: [{ insert: [{ id: 'nodo-native-ui-probe', name: join(plugin, 'index.js') }] }],
      handle: () => false,
      verify() {},
      dispose() {
        rmSync(plugin, { recursive: true, force: true })
        rmSync(workspace, { recursive: true, force: true })
      },
    }
  }
  const evidence = requests => {
    const turns = marker => requests.filter(body => lastUser(body).includes(marker))
    const coder = turns('NATIVE_UI_CODER')
    const reviewer = turns('NATIVE_UI_REVIEWER')
    const prompt = effectivePrompt
    return {
      coderTurns: coder.length,
      reviewerTurns: reviewer.length,
      coderIdentity: coder.length > 0 && coder.every(body => prompt(body).includes('Keep the same conversation')),
      reviewerIdentity: reviewer.length > 0 && reviewer.every(body => prompt(body).includes('NATIVE_REVIEWER_IDENTITY')),
      roleIsolation: coder.every(body => !prompt(body).includes('NATIVE_REVIEWER_IDENTITY')) && reviewer.every(body => !prompt(body).includes('Keep the same conversation')),
      coderHistory: coder.some(body => body.messages.filter(message => message.role === 'assistant').length >= 4),
    }
  }
  return {
    workspace,
    ordinaryWorkspace,
    patch: [
      { id: 'ui-sidebar-browser', disabled: false },
      { insert: [{ id: 'nodo-native-ui-probe', name: join(plugin, 'index.js') }] },
    ],
    handle(request, response, requests) {
      if (request.url === '/bench/evidence') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(evidence(requests)))
      } else if (request.url === '/bench/page') {
        response.writeHead(200, { 'Content-Type': 'text/html' })
        response.end('<!doctype html><title>Native Browser Proof</title><h1>NODO_NATIVE_BROWSER_OK</h1>')
      } else return false
      return true
    },
    verify(requests) {
      const result = evidence(requests)
      assert.ok(result.coderTurns >= 2, 'send twice from the native coder composer')
      assert.ok(result.reviewerTurns >= 1, 'send from the native reviewer composer')
      for (const key of ['coderIdentity', 'reviewerIdentity', 'roleIsolation', 'coderHistory']) assert.equal(result[key], true, key)
      console.log('Native UI composer: role identity, isolation, continuity and direct host sends passed')
    },
    verifyCold(requests) {
      const body = requests.find(body => lastUser(body).includes('NATIVE_UI_COLD'))
      assert.ok(body, 'send from the native composer after the cold restart')
      const prompt = effectivePrompt(body)
      const result = {
        historyRestored: body.messages.some(message => /NATIVE_UI_CODER_SECOND|AFTER_RESTART/.test(JSON.stringify(message.content))),
        roleIdentityRestored: prompt.includes('Keep the same conversation'),
      }
      console.log(`Cold native UI result: ${JSON.stringify(result)}`)
      assert.equal(result.historyRestored, true)
      assert.equal(result.roleIdentityRestored, true, 'native navigation must restore the role before the first prompt')
    },
    verifyPanel(requests) {
      const coder = requests.find(body => lastUser(body).includes('NATIVE_PANEL_CODER'))
      const reviewer = requests.find(body => lastUser(body).includes('NATIVE_PANEL_REVIEWER'))
      assert.ok(coder, 'send from the embedded coder composer')
      assert.ok(reviewer, 'send from the embedded reviewer composer')
      assert.ok(effectivePrompt(coder).includes('Keep the same conversation'))
      assert.ok(effectivePrompt(reviewer).includes('NATIVE_REVIEWER_IDENTITY'))
      assert.ok(!JSON.stringify(coder.messages).includes('PLAIN_NATIVE_ONLY'))
      assert.ok(!JSON.stringify(reviewer.messages).includes('NATIVE_PANEL_CODER'))
      console.log('Independent panel: embedded native composer, role identities and separate conversation histories passed')
    },
    verifyMode(requests) {
      const coder = requests.find(body => lastUser(body).includes('NATIVE_MODE_CODER'))
      const reviewer = requests.find(body => lastUser(body).includes('NATIVE_MODE_REVIEWER'))
      const ordinary = requests.find(body => lastUser(body).includes('NATIVE_MODE_ORDINARY'))
      assert.ok(coder && reviewer && ordinary, 'send from both spaces and both Nodo roles')
      assert.ok(effectivePrompt(coder).includes('Keep the same conversation'))
      assert.ok(effectivePrompt(reviewer).includes('NATIVE_REVIEWER_IDENTITY'))
      assert.ok(!effectivePrompt(ordinary).includes('Keep the same conversation'))
      assert.ok(!effectivePrompt(ordinary).includes('NATIVE_REVIEWER_IDENTITY'))
      assert.ok(!JSON.stringify(coder.messages).includes('PLAIN_NATIVE_ONLY'))
      assert.ok(!JSON.stringify(reviewer.messages).includes('NATIVE_MODE_CODER'))
      assert.ok(!JSON.stringify(ordinary.messages).includes('NATIVE_MODE_CODER'))
      console.log('Native mode: both spaces send through the native composer, with role and history isolation passed')
    },
    dispose() {
      rmSync(plugin, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
      if (ordinaryWorkspace) rmSync(ordinaryWorkspace, { recursive: true, force: true })
    },
  }
}
