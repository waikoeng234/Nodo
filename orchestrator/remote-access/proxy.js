import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { command } from './command.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const running = async pid => (await command('/bin/ps', ['-p', String(pid)])).code === 0

// Only an orphaned httpd (reparented to launchd) running this module's own config is a leftover of a crashed host.
async function reapOrphans() {
  for (const name of readdirSync(tmpdir()).filter(name => name.startsWith('nodo-mobile-'))) {
    const directory = join(tmpdir(), name)
    const pid = Number(await readFile(join(directory, 'httpd.pid'), 'utf8').catch(() => ''))
    if (!pid) continue
    const ps = await command('/bin/ps', ['-ww', '-o', 'ppid=,command=', '-p', String(pid)])
    const owned = /^1\s+(.+)$/.exec(String(ps.stdout).trim())?.[1] === `/usr/sbin/httpd -f ${join(directory, 'httpd.conf')} -DFOREGROUND`
    if (!owned) continue
    try { process.kill(pid, 'SIGTERM') } catch {}
    for (let attempt = 0; attempt < 60 && await running(pid); attempt++) await wait(50)
    try { rmSync(directory, { recursive: true, force: true }) } catch {}
  }
}

export async function startMobileProxy(upstream, mobileOrigin, port) {
  const external = new URL(mobileOrigin)
  if (external.protocol !== 'https:' || !external.hostname.endsWith('.ts.net')
    || external.port || external.username || external.password || external.pathname !== '/' || external.search || external.hash) {
    throw new Error('手机入口必须是 Tailscale 的 HTTPS 根地址')
  }
  await reapOrphans()
  if (!port) {
    const probe = createServer().listen(0, '127.0.0.1')
    await once(probe, 'listening')
    port = probe.address().port
    await new Promise(resolve => probe.close(resolve))
  }
  const directory = mkdtempSync(join(tmpdir(), 'nodo-mobile-'))
  const instance = randomUUID()
  const file = join(directory, 'httpd.conf')
  writeFileSync(file, `ServerRoot "${directory}"
DefaultRuntimeDir "${directory}"
PidFile "${join(directory, 'httpd.pid')}"
ServerName ${external.hostname}
Listen 127.0.0.1:${port}
LoadModule mpm_event_module /usr/libexec/apache2/mod_mpm_event.so
LoadModule unixd_module /usr/libexec/apache2/mod_unixd.so
LoadModule authz_core_module /usr/libexec/apache2/mod_authz_core.so
LoadModule proxy_module /usr/libexec/apache2/mod_proxy.so
LoadModule proxy_http_module /usr/libexec/apache2/mod_proxy_http.so
LoadModule headers_module /usr/libexec/apache2/mod_headers.so
ErrorLog /dev/null
LogLevel crit
ServerTokens Prod
ServerSignature Off
ProxyRequests Off
ProxyPreserveHost Off
ProxyTimeout 3600
<Location "/">
  Require expr "(%{HTTP_HOST} == '${external.host}' || %{HTTP_HOST} == '${external.host}:443') && (%{HTTP:Origin} == '' || %{HTTP:Origin} == '${external.origin}' || %{HTTP:Origin} == '${external.origin}:443') && (%{HTTP:Sec-Fetch-Site} != 'cross-site' || (%{REQUEST_METHOD} == 'GET' && %{REQUEST_URI} == '/' && %{HTTP:Sec-Fetch-Mode} == 'navigate' && %{HTTP:Sec-Fetch-Dest} == 'document'))"
</Location>
RequestHeader set Origin "${upstream}"
Header edit Set-Cookie "$" "; Secure"
Header always edit Set-Cookie "$" "; Secure"
Header always set Referrer-Policy "no-referrer"
Header always set X-Nodo-Remote-Instance "${instance}"
ProxyPass "/" "${upstream}/" upgrade=websocket
ProxyPassReverse "/" "${upstream}/"
`)
  const child = spawn('/usr/sbin/httpd', ['-f', file, '-DFOREGROUND'], { stdio: 'ignore' })
  let failed = false
  child.on('error', () => { failed = true })
  const exited = once(child, 'exit').catch(() => {})
  const stop = async () => {
    if (!failed && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited
    }
    rmSync(directory, { recursive: true, force: true })
  }
  for (let attempt = 0; attempt < 30 && !failed && child.exitCode === null && child.signalCode === null; attempt++) {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { host: external.host }, redirect: 'manual', signal: AbortSignal.timeout(300),
    }).catch(() => null)
    const ready = response?.headers.get('x-nodo-remote-instance') === instance
    await response?.body?.cancel()
    if (ready) return { port, stop }
    await wait(50)
  }
  await stop()
  throw new Error('本机转发启动失败，请重新启用手机远程。')
}
