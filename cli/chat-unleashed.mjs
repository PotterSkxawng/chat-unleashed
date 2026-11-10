#!/usr/bin/env node
//
// chat-unleashed: setup and health for the local MCP server and its OpenAI tunnel.
//
// Everything here reads the machine as it is: launchd jobs, the tunnel profile,
// the env file, and both HTTP surfaces. No step reports success it did not see.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = (() => {
  try {
    return JSON.parse(readText(join(PKG_ROOT, 'package.json')) || '{}').version || '0.1.0'
  } catch {
    return '0.1.0'
  }
})()
const HOME = process.env.HOME || homedir()
const UID = typeof process.getuid === 'function' ? process.getuid() : 501

const SHARE = join(HOME, '.local/share/local-agent-mcp')
const ENV_FILE = join(SHARE, '.env.tunnel')
const LOG_DIR = join(SHARE, 'logs')
const CLIENT_CONFIG = join(HOME, '.config/tunnel-client')
const AGENTS_DIR = join(HOME, 'Library/LaunchAgents')
const CODEX_PLUGIN = join(HOME, '.codex/plugins/cache/debug/tunnel-mcp/local')

const DEFAULT_PROFILE = 'local-mac'
const MCP_URL_FALLBACK = 'http://127.0.0.1:3344/mcp'
const HEALTH_URL_FALLBACK = 'http://127.0.0.1:8080'
const TUNNELS_URL = 'https://platform.openai.com/settings/organization/tunnels'
const KEYS_URL = 'https://platform.openai.com/settings/organization/api-keys'
const CONNECTORS_URL = 'https://chatgpt.com/#settings/Connectors'
const TUNNEL_ID_RE = /^tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}$/

const argv = process.argv.slice(2)
const named = new Map()
const flags = new Set()
for (let i = 0; i < argv.length; i++) {
  const token = argv[i]
  if (!token.startsWith('-')) continue
  const [key, inline] = token.split('=')
  if (inline !== undefined) named.set(key, inline)
  else if (['--profile'].includes(key)) named.set(key, argv[++i])
  else flags.add(key)
}
const command = argv.find((token) => !token.startsWith('-'))
  ?? (flags.has('--version') ? 'version' : flags.has('--help') || flags.has('-h') ? 'help' : 'home')

const PROFILE = named.get('--profile') || DEFAULT_PROFILE
const NO_COLOR = flags.has('--no-color') || Boolean(process.env.NO_COLOR)
const WANTS_JSON = flags.has('--json')
const COLOR = !NO_COLOR && !WANTS_JSON && (process.stdout.isTTY || process.env.FORCE_COLOR === '1')

const esc = (code) => (text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : String(text))
const bold = esc('1')
const dim = esc('2')
const rgb = (r, g, b) => (text) => (COLOR ? `\u001b[38;2;${r};${g};${b}m${text}\u001b[0m` : String(text))
const ink = rgb(234, 234, 240)
const sub = rgb(146, 146, 158)
const faint = rgb(98, 98, 110)
const action = rgb(120, 176, 255)
const good = rgb(96, 208, 140)
const warn = rgb(236, 180, 88)
const bad = rgb(255, 124, 124)
const accent = rgb(255, 196, 120)

const stateGlyph = { ok: good('✓'), warn: warn('!'), bad: bad('✗'), idle: faint('·') }
function glyphFor(status) {
  return stateGlyph[status] ?? stateGlyph.idle
}

function columns() {
  return Math.max(52, Math.min(process.stdout.columns || 80, 78))
}
function vlen(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, '').length
}
function padEnd(text, width) {
  return text + ' '.repeat(Math.max(0, width - vlen(text)))
}
function trimTo(text, width) {
  if (vlen(text) <= width) return text
  let plain = String(text).slice(0, Math.max(0, width - 1))
  return plain + '…'
}
function line(text = '') {
  process.stdout.write(text + '\n')
}
function gap() {
  line()
}
function section(title) {
  gap()
  line(`  ${bold(title)}`)
}
function row(label, value, status) {
  const left = `  ${sub(padEnd(label, 16))}${value}`
  if (!status) {
    line(left)
    return
  }
  const glyph = glyphFor(status)
  const space = Math.max(2, columns() - vlen(left) - 1)
  line(left + ' '.repeat(space) + glyph)
}
function hint(text) {
  line(`  ${faint(text)}`)
}
function remedy(text) {
  line(`  ${' '.repeat(16)}${faint(text)}`)
}
function note(text) {
  line(`  ${sub(text)}`)
}

async function withSpinner(label, work) {
  const run = typeof work === 'function' ? work : () => work
  if (!process.stdout.isTTY || NO_COLOR) return run()
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let frame = 0
  const paint = () => process.stdout.write(`\r\u001b[K  ${action(frames[frame++ % frames.length])} ${sub(label)}`)
  paint()
  const timer = setInterval(paint, 80)
  try {
    return await run()
  } finally {
    clearInterval(timer)
    process.stdout.write('\r\u001b[K')
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function which(binary) {
  const found = spawnSync('/usr/bin/which', [binary], { encoding: 'utf8', timeout: 3000 })
  const path = (found.stdout || '').trim().split('\n')[0]
  return found.status === 0 && path ? path : null
}

function macOSVersion() {
  const v = spawnSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 2000 })
  return (v.stdout || '').trim() || null
}

function launchJob(label) {
  const result = spawnSync('launchctl', ['print', `gui/${UID}/${label}`], { encoding: 'utf8', timeout: 3000 })
  if (result.status !== 0) return { loaded: false, running: false, pid: null }
  const out = result.stdout || ''
  const pid = (out.match(/\bpid = (\d+)/) || [])[1]
  return { loaded: true, running: /state = running/.test(out), pid: pid ? Number(pid) : null }
}

function findJobs() {
  const jobs = { server: null, tunnel: null }
  if (!existsSync(AGENTS_DIR)) return jobs
  for (const file of readdirSync(AGENTS_DIR)) {
    if (!file.endsWith('.plist')) continue
    const path = join(AGENTS_DIR, file)
    const text = readText(path) || ''
    const label = (text.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/) || [])[1]
    if (!label) continue
    if (text.includes('tunnel-client') && text.includes(' run ')) jobs.tunnel = { label, path }
    if (text.includes('local-agent-mcp') && text.includes('--http')) jobs.server = { label, path }
  }
  return jobs
}

function parseProfile(text) {
  const pick = (key) => {
    const match = text.match(new RegExp(`^\\s*${key}:\\s*"?([^"#\\n]+?)"?\\s*$`, 'm'))
    return match ? match[1].trim() : null
  }
  return {
    tunnelId: pick('tunnel_id'),
    apiKey: pick('api_key'),
    listenAddr: pick('listen_addr'),
    serverUrl: pick('url')
  }
}

function keyState(profile) {
  if (process.env.CONTROL_PLANE_API_KEY) return { present: true, source: 'the environment' }
  const envText = readText(ENV_FILE) || ''
  const match = envText.match(/^\s*(?:export\s+)?CONTROL_PLANE_API_KEY\s*=\s*(.+)$/m)
  if (match && match[1].trim().length > 1) return { present: true, source: '.env.tunnel' }
  if (profile?.apiKey && !profile.apiKey.startsWith('env:')) return { present: true, source: 'the profile' }
  if (profile?.apiKey?.startsWith('env:')) {
    return { present: false, source: null, waiting: profile.apiKey.slice(4) }
  }
  return { present: false, source: null }
}

async function getText(url, timeout = 5000) {
  const started = Date.now()
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
    const text = (await response.text()).trim()
    return { ok: response.ok, status: response.status, text, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, status: 0, text: '', ms: Date.now() - started, error: error?.name || 'failed' }
  }
}

function parseMessages(body) {
  if (!body) return []
  if (body.trimStart().startsWith('{')) {
    try {
      return [JSON.parse(body)]
    } catch {
      return []
    }
  }
  const messages = []
  for (const raw of body.split('\n')) {
    const text = raw.trim()
    if (!text.startsWith('data:')) continue
    const payload = text.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      messages.push(JSON.parse(payload))
    } catch {
      // A single malformed frame should not hide the rest of the stream.
    }
  }
  return messages
}

async function probeMcp(url) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const started = Date.now()
  try {
    const init = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'chat-unleashed', version: VERSION }
        }
      }),
      signal: AbortSignal.timeout(9000)
    })
    const session = init.headers.get('mcp-session-id')
    const initMessages = parseMessages(await init.text())
    const reply = initMessages.find((message) => message.id === 1)
    if (!init.ok || !reply?.result) {
      return { ok: false, status: init.status, tools: null, server: null, ms: Date.now() - started }
    }

    const callHeaders = { ...headers }
    if (session) callHeaders['mcp-session-id'] = session
    await fetch(url, {
      method: 'POST',
      headers: callHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(3000)
    }).catch(() => {})
    const list = await fetch(url, {
      method: 'POST',
      headers: callHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(9000)
    })
    const messages = parseMessages(await list.text())
    const tools = messages.find((message) => message.id === 2)?.result?.tools
    return {
      ok: true,
      status: init.status,
      tools: Array.isArray(tools) ? tools.length : null,
      server: reply.result.serverInfo?.name || 'local-agent-mcp',
      version: reply.result.serverInfo?.version || null,
      ms: Date.now() - started
    }
  } catch (error) {
    return { ok: false, status: 0, tools: null, server: null, ms: Date.now() - started, error: error?.name || 'failed' }
  }
}

async function collectState() {
  const started = Date.now()
  const clientPath = which('tunnel-client')
  const clientVersion = clientPath
    ? ((spawnSync(clientPath, ['--version'], { encoding: 'utf8', timeout: 5000 }).stdout || '').trim().split(/\s+/)[0] || '').split('+')[0] || null
    : null

  const profilePath = join(CLIENT_CONFIG, `${PROFILE}.yaml`)
  const profileText = readText(profilePath)
  const profile = profileText ? parseProfile(profileText) : null

  const jobs = findJobs()
  const serverJob = jobs.server ? { ...jobs.server, ...launchJob(jobs.server.label) } : null
  const tunnelJob = jobs.tunnel ? { ...jobs.tunnel, ...launchJob(jobs.tunnel.label) } : null

  const mcpUrl = profile?.serverUrl || MCP_URL_FALLBACK
  const healthBase = profile?.listenAddr ? `http://${profile.listenAddr}` : HEALTH_URL_FALLBACK

  const [health, ready, firstTry] = await Promise.all([
    getText(mcpUrl.replace(/\/mcp$/, '/health')),
    getText(`${healthBase}/readyz`),
    probeMcp(mcpUrl)
  ])
  // A loaded Mac can push one handshake past the timeout, so a second try separates slow from down.
  const mcp = firstTry.ok ? firstTry : await probeMcp(mcpUrl)

  return {
    ms: Date.now() - started,
    platform: { macOS: macOSVersion(), arch: process.arch, node: process.version },
    client: { installed: Boolean(clientPath), path: clientPath, version: clientVersion },
    profile: {
      name: PROFILE,
      path: profilePath,
      exists: Boolean(profileText),
      tunnelId: profile?.tunnelId ?? null,
      mcpUrl,
      healthBase
    },
    key: keyState(profile),
    jobs: { server: serverJob, tunnel: tunnelJob },
    server: { url: mcpUrl, healthy: mcp.ok, healthOk: health.ok, tools: mcp.tools, info: mcp },
    tunnel: { url: healthBase, ready: ready.ok && ready.text === 'ready', body: ready.text || 'no answer', status: ready.status },
    agent: { installed: existsSync(CODEX_PLUGIN) },
    dist: { path: join(SHARE, 'dist/index.js'), exists: existsSync(join(SHARE, 'dist/index.js')) }
  }
}

function maskId(id) {
  if (!id) return 'not set'
  if (id.length <= 16) return id
  return `${id.slice(0, 11)}…${id.slice(-4)}`
}

function nextStep(state) {
  const { client, key, profile, server, tunnel, agent } = state
  if (!client.installed) {
    return {
      command: 'brew install openai/tools/tunnel-client',
      note: 'Installs the client that carries the tunnel.'
    }
  }
  if (!profile.exists) {
    return { command: 'chat-unleashed setup', note: 'Creates a tunnel profile pointed at this server.' }
  }
  if (!key.present) {
    return { command: 'chat-unleashed setup', note: `The profile asks for ${key.waiting || 'CONTROL_PLANE_API_KEY'}, and it is not set.` }
  }
  if (!profile.tunnelId) {
    return { command: 'chat-unleashed setup', note: 'The profile has no tunnel ID yet.' }
  }
  if (!server.healthy) {
    return { command: 'chat-unleashed restart', note: `Nothing is answering at ${server.url}.` }
  }
  if (!tunnel.ready) {
    return { command: 'chat-unleashed restart', note: `The tunnel answers "${trimTo(tunnel.body, 40)}" instead of ready.` }
  }
  return {
    command: 'chat-unleashed connect',
    note: 'Both services answer. Add Chat Unleashed in ChatGPT, then ask it to do something local.'
  }
}

function renderDashboard(state) {
  const width = columns()
  const product = `${bold('chat')}${dim('-')}${bold('unleashed')}`
  const meta = `${sub('v' + VERSION)} ${faint('·')} ${sub('setup and health')}`
  const space = Math.max(2, width - vlen(product) - vlen(meta) - 2)
  line(`  ${product}${' '.repeat(space)}${meta}`)
  line(`  ${sub('A local MCP server, carried to your agent through an OpenAI tunnel.')}`)

  section('This Mac')
  row('macOS', `${state.platform.macOS || 'unknown'} ${faint('·')} ${state.platform.arch}`)
  row('Node', state.platform.node)
  row('Client', state.client.installed ? `tunnel-client ${state.client.version || ''}`.trim() : 'not installed',
    state.client.installed ? 'ok' : 'bad')

  section('The tunnel')
  row('Profile', state.profile.exists ? `${state.profile.name} ${faint('·')} ${displayPath(state.profile.path)}` : 'not created',
    state.profile.exists ? 'ok' : 'bad')
  row('Tunnel ID', maskId(state.profile.tunnelId), state.profile.tunnelId ? 'ok' : 'bad')
  row('Runtime key', state.key.present ? `from ${state.key.source}` : 'not set', state.key.present ? 'ok' : 'bad')

  section('Services')
  row('MCP server', state.server.healthy
      ? `${state.server.tools ?? '?'} tools ${faint('·')} ${hostOf(state.server.url)}`
      : `${state.server.healthOk ? 'health only' : 'no answer'} ${faint('·')} ${hostOf(state.server.url)}`,
    state.server.healthy ? 'ok' : 'bad')
  row('Tunnel', state.tunnel.ready
      ? `ready ${faint('·')} ${hostOf(state.tunnel.url)}`
      : `${trimTo(state.tunnel.body, 24)} ${faint('·')} ${hostOf(state.tunnel.url)}`,
    state.tunnel.ready ? 'ok' : 'bad')
  row('Codex', state.agent.installed ? 'plugin installed' : 'plugin not installed, optional',
    state.agent.installed ? 'ok' : 'idle')

  const next = nextStep(state)
  section('Next')
  if (next.command) {
    line(`  ${accent('›')} ${action(next.command)}`)
    note(next.note)
  } else {
    note(next.note)
    hint('Run chat-unleashed doctor for the full list, or chat-unleashed logs to watch the tunnel.')
  }

  if (flags.has('--verbose')) {
    gap()
    hint(`probed in ${state.ms} ms`)
  }
}

function displayPath(path) {
  return path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path
}

function hostOf(url) {
  try {
    const parsed = new URL(url)
    return parsed.host
  } catch {
    return url
  }
}

function checkList(state) {
  const checks = []
  const add = (title, status, detail, remedy) => checks.push({ title, status, detail, remedy })

  add('macOS', 'ok', `${state.platform.macOS || 'unknown'} ${state.platform.arch}`, null)
  add('Node', 'ok', state.platform.node, null)

  add('tunnel-client', state.client.installed ? 'ok' : 'bad',
    state.client.installed ? `${state.client.version || 'unknown'} at ${displayPath(state.client.path)}` : 'Not on PATH.',
    state.client.installed ? null : 'brew install openai/tools/tunnel-client')

  add('Profile', state.profile.exists ? 'ok' : 'bad',
    state.profile.exists ? displayPath(state.profile.path) : `${PROFILE}.yaml does not exist.`,
    state.profile.exists ? null : 'chat-unleashed setup')

  add('Runtime key', state.key.present ? 'ok' : 'bad',
    state.key.present ? `Loaded from ${state.key.source}.` : 'The profile references a variable that is not set.',
    state.key.present ? null : 'chat-unleashed setup')

  add('Tunnel ID', state.profile.tunnelId ? 'ok' : 'bad',
    state.profile.tunnelId ? maskId(state.profile.tunnelId) : 'No tunnel_id in the profile.',
    state.profile.tunnelId ? null : 'chat-unleashed setup')

  const serverJob = state.jobs.server
  add('MCP server job', serverJob?.loaded ? 'ok' : 'warn',
    serverJob?.loaded ? `${serverJob.label} ${serverJob.running ? `running as ${serverJob.pid}` : 'loaded, not running'}` : 'No launchd job found.',
    serverJob?.loaded ? null : 'chat-unleashed setup')

  const tunnelJob = state.jobs.tunnel
  add('Tunnel job', tunnelJob?.loaded ? 'ok' : 'warn',
    tunnelJob?.loaded ? `${tunnelJob.label} ${tunnelJob.running ? `running as ${tunnelJob.pid}` : 'loaded, not running'}` : 'No launchd job found.',
    tunnelJob?.loaded ? null : 'chat-unleashed setup')

  add('MCP server', state.server.healthy ? 'ok' : 'bad',
    state.server.healthy
      ? `${state.server.tools ?? '?'} tools at ${state.server.url}`
      : `${state.server.healthOk ? 'Answers /health, but the MCP handshake times out' : 'No answer'} at ${state.server.url}.`,
    state.server.healthy ? null : 'chat-unleashed restart')

  add('Tunnel ready', state.tunnel.ready ? 'ok' : 'bad',
    state.tunnel.ready ? `ready at ${state.tunnel.url}/readyz` : `Answers "${trimTo(state.tunnel.body, 40)}" at ${state.tunnel.url}/readyz.`,
    state.tunnel.ready ? null : 'chat-unleashed restart')

  add('Codex', state.agent.installed ? 'ok' : 'warn',
    state.agent.installed ? 'The Codex plugin is present.' : 'The Codex plugin is optional and not installed.',
    state.agent.installed ? null : 'tunnel-client codex plugin install')

  return checks
}

async function doctor() {
  const state = await withSpinner('Running every check', collectState)
  if (WANTS_JSON) {
    const checks = checkList(state)
    process.stdout.write(JSON.stringify({ ok: checks.every((c) => c.status !== 'bad'), checks }, null, 2) + '\n')
    return checks.some((check) => check.status === 'bad') ? 1 : 0
  }

  const checks = checkList(state)
  const groups = [
    ['This Mac', ['macOS', 'Node', 'tunnel-client']],
    ['Configuration', ['Profile', 'Runtime key', 'Tunnel ID']],
    ['Services',    ['MCP server job', 'Tunnel job', 'MCP server', 'Tunnel ready']],
    ['Agent', ['Agent']]
  ]

  line(`  ${bold('chat')}${dim('-')}${bold('unleashed')}  ${sub('every check')}`)
  for (const [title, names] of groups) {
    section(title)
    for (const name of names) {
      const check = checks.find((entry) => entry.title === name)
      if (!check) continue
      row(name, trimTo(check.detail, columns() - 22), check.status)
      if (check.remedy) remedy(check.remedy)
    }
  }

  const passed = checks.filter((check) => check.status === 'ok').length
  const warned = checks.filter((check) => check.status === 'warn').length
  const failed = checks.filter((check) => check.status === 'bad').length

  section('Result')
  if (failed === 0) {
    note(`${passed} checks passed${warned ? `, ${warned} optional step${warned > 1 ? 's' : ''} left` : ''}.`)
    if (warned === 0) hint('Everything is talking to everything.')
  } else {
    note(`${passed} passed, ${failed} need${failed === 1 ? 's' : ''} attention${warned ? `, ${warned} optional` : ''}.`)
    const first = checks.find((check) => check.status === 'bad')
    if (first?.remedy) hint(`Start with: ${first.remedy}`)
  }
  gap()
  return failed > 0 ? 1 : 0
}

async function statusLine() {
  const state = await collectState()
  if (WANTS_JSON) {
    const next = nextStep(state)
    process.stdout.write(JSON.stringify({
      ok: state.server.healthy && state.tunnel.ready,
      client: state.client.version,
      profile: state.profile.name,
      tunnelId: state.profile.tunnelId,
      server: { url: state.server.url, healthy: state.server.healthy, tools: state.server.tools },
      tunnel: { url: state.tunnel.url, ready: state.tunnel.ready, body: state.tunnel.body },
      agent: state.agent.installed,
      next: next.command
    }, null, 2) + '\n')
    return state.server.healthy && state.tunnel.ready ? 0 : 1
  }
  const mark = state.server.healthy && state.tunnel.ready ? good('✓') : bad('✗')
  const parts = [
    `server ${state.server.healthy ? `${state.server.tools ?? '?'} tools` : 'down'}`,
    `tunnel ${state.tunnel.ready ? 'ready' : 'down'}`
  ]
  line(`${mark} ${ink(parts.join(` ${faint('·')} `))}`)
  return state.server.healthy && state.tunnel.ready ? 0 : 1
}

function plistServer(nodePath, entry) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.local-agent-mcp.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${entry}</string>
    <string>--http</string>
    <string>--port</string>
    <string>3344</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>WorkingDirectory</key><string>${SHARE}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${join(LOG_DIR, 'server-http.log')}</string>
  <key>StandardErrorPath</key><string>${join(LOG_DIR, 'server-http.log')}</string>
</dict>
</plist>
`
}

function plistTunnel(clientPath) {
  const script = `set -a; f=${ENV_FILE}; [ -s "$f" ] || cp "$f.bak" "$f" 2>/dev/null; . "$f"; set +a; exec ${clientPath} run --profile ${PROFILE} >> ${join(LOG_DIR, 'tunnel-daemon.log')} 2>&1`
  const escaped = script.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.local-agent-mcp.tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>${escaped}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>WorkingDirectory</key><string>${SHARE}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${join(LOG_DIR, 'tunnel-launchd.log')}</string>
  <key>StandardErrorPath</key><string>${join(LOG_DIR, 'tunnel-launchd.log')}</string>
</dict>
</plist>
`
}

function ensureJobs(state) {
  mkdirSync(AGENTS_DIR, { recursive: true })
  mkdirSync(LOG_DIR, { recursive: true })
  const created = []

  if (!state.jobs.server) {
    const nodePath = which('node') || '/opt/homebrew/bin/node'
    const entry = state.dist.exists ? state.dist.path : null
    if (!entry) return { created, error: 'The MCP server is not built, so its job was not written.' }
    const path = join(AGENTS_DIR, 'com.local-agent-mcp.server.plist')
    writeFileSync(path, plistServer(nodePath, entry), { mode: 0o644 })
    created.push(path)
  }
  if (!state.jobs.tunnel) {
    if (!state.client.installed) return { created, error: 'tunnel-client is missing, so its job was not written.' }
    const path = join(AGENTS_DIR, 'com.local-agent-mcp.tunnel.plist')
    writeFileSync(path, plistTunnel(state.client.path), { mode: 0o644 })
    created.push(path)
  }
  return { created, error: null }
}

function bootstrap(path, label) {
  spawnSync('launchctl', ['bootout', `gui/${UID}/${label}`], { encoding: 'utf8', timeout: 4000 })
  return spawnSync('launchctl', ['bootstrap', `gui/${UID}`, path], { encoding: 'utf8', timeout: 6000 })
}

function kickJob(job) {
  if (!job) return false
  if (!launchJob(job.label).loaded) bootstrap(job.path, job.label)
  spawnSync('launchctl', ['kickstart', '-k', `gui/${UID}/${job.label}`], { encoding: 'utf8', timeout: 5000 })
  return true
}

// The tunnel gives up for good if its 30s startup probe fails, so it starts
// only after the MCP server answers, and gets one more kick if it still fails.
async function bringUp(jobs, profile, onStep) {
  if (jobs.server) {
    kickJob(jobs.server)
    await onStep('Waiting for the MCP server', () =>
      waitUntil(async () => (await probeMcp(profile.mcpUrl)).ok, 60000))
  }
  if (!jobs.tunnel) return
  const ready = () => waitUntil(async () => {
    const probe = await getText(`${profile.healthBase}/readyz`, 4000)
    return probe.ok && probe.text === 'ready'
  }, 45000)
  kickJob(jobs.tunnel)
  if (await onStep('Waiting for the tunnel', ready)) return
  kickJob(jobs.tunnel)
  await onStep('Waiting for the tunnel, second try', ready)
}

async function waitUntil(check, timeoutMs = 45000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  return false
}

function writeKeyToEnvFile(key) {
  mkdirSync(SHARE, { recursive: true })
  const existing = readText(ENV_FILE) || ''
  const entry = `export CONTROL_PLANE_API_KEY="${key}"`
  const next = existing.match(/^\s*(?:export\s+)?CONTROL_PLANE_API_KEY\s*=.*$/m)
    ? existing.replace(/^\s*(?:export\s+)?CONTROL_PLANE_API_KEY\s*=.*$/m, entry)
    : `${existing.trimEnd()}\n${entry}\n`.trimStart()
  writeFileSync(ENV_FILE, next, { mode: 0o600 })
  chmodSync(ENV_FILE, 0o600)
}

function writeTunnelIdToProfile(path, id) {
  const text = readText(path)
  if (!text) return false
  const next = text.match(/^\s*tunnel_id:.*$/m)
    ? text.replace(/^(\s*tunnel_id:\s*).*$/m, `$1"${id}"`)
    : text.replace(/^control_plane:\s*$/m, `control_plane:\n  tunnel_id: "${id}"`)
  writeFileSync(path, next, { mode: 0o600 })
  return true
}

function tunnelIdProblem(value) {
  return TUNNEL_ID_RE.test(value)
    ? null
    : 'tunnel-client expects tunnel_ then 32 lowercase letters or digits, optionally with a 4 character namespace.'
}

function sanitizeKey(value) {
  const key = String(value || '').trim()
  if (!key) return { key: '', problem: 'No key entered. Run chat-unleashed setup when you have it.' }
  if (!/^[A-Za-z0-9._-]+$/.test(key)) {
    return { key: '', problem: 'That does not look like a key. Paste it without quotes, spaces or line breaks.' }
  }
  return { key, problem: null }
}

// The tunnel carries a loopback HTTP target, never a stdio child, so the
// profile always names this server's MCP endpoint and keeps the key by reference.
function ensureProfile(tunnelId) {
  const clientPath = which('tunnel-client')
  if (!clientPath) return { ok: false, output: 'tunnel-client is not installed.' }
  const result = spawnSync(clientPath, [
    'init',
    '--sample', 'sample_mcp_with_dcr',
    '--profile', PROFILE,
    '--tunnel-id', tunnelId,
    '--mcp-server-url', MCP_URL_FALLBACK,
    '--health-listen-addr', HEALTH_URL_FALLBACK.replace('http://', ''),
    '--control-plane-api-key-ref', 'env:CONTROL_PLANE_API_KEY',
    '--force'
  ], { encoding: 'utf8', timeout: 30000 })
  return { ok: result.status === 0, output: `${result.stdout || ''}${result.stderr || ''}`.trim() }
}

function ask(question, { fallback = '', validate } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const label = `${question}${fallback ? ` ${faint(`(${fallback})`)}` : ''} `
    rl.question(`  ${label}`, (answer) => {
      rl.close()
      const value = answer.trim() || fallback
      if (validate) {
        const problem = validate(value)
        if (problem) {
          note(problem)
          ask(question, { fallback, validate }).then(resolve)
          return
        }
      }
      resolve(value)
    })
  })
}

function askSecret(question) {
  if (!process.stdin.isTTY) return Promise.resolve('')
  return new Promise((resolve) => {
    process.stdout.write(`  ${question} `)
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const finish = () => {
      stdin.removeListener('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stdout.write('\n')
    }
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          finish()
          resolve(value)
          return
        }
        if (char === '\u0003') {
          finish()
          process.exit(130)
        }
        if (char === '\u007f' || char === '\b') {
          if (value) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        if (char >= ' ') {
          value += char
          process.stdout.write('•')
        }
      }
    }
    stdin.on('data', onData)
  })
}

async function setup() {
  const dryRun = flags.has('--check')
  const assumeYes = flags.has('--yes')
  line(`  ${bold('chat')}${dim('-')}${bold('unleashed')}  ${sub('setup')}`)
  note('From nothing to a connector ChatGPT can call. Every step is skipped when it is already true.')
  if (dryRun) hint('Dry run. Nothing will be written.')

  const state = await withSpinner('Looking around', collectState)
  const steps = []

  const step = (title, ok, detail) => {
    steps.push({ title, ok })
    row(title, trimTo(detail, columns() - 24), ok ? 'ok' : 'bad')
  }

  step('Client', state.client.installed,
    state.client.installed ? `tunnel-client ${state.client.version || ''}`.trim() : 'needs Homebrew install')
  step('Profile', state.profile.exists,
    state.profile.exists ? displayPath(state.profile.path) : 'will be created for this server')
  step('Tunnel ID', Boolean(state.profile.tunnelId),
    state.profile.tunnelId ? maskId(state.profile.tunnelId) : 'from the Tunnels page')
  step('Runtime key', state.key.present,
    state.key.present ? `loaded from ${state.key.source}` : 'from the API keys page')
  step('MCP server', state.dist.exists,
    state.dist.exists ? displayPath(state.dist.path) : 'will be built')
  step('Services', Boolean(state.server.healthy && state.tunnel.ready),
    state.server.healthy && state.tunnel.ready ? 'both answering' : 'will be started and checked')

  const needed = steps.filter((entry) => !entry.ok).length
  if (needed === 0) {
    section('Ready')
    note('Nothing to change. The server and the tunnel are both answering.')
    connectorGuide(state)
    gap()
    return 0
  }
  if (dryRun) {
    section('Plan')
    note(`${needed} step${needed > 1 ? 's' : ''} would change this Mac.`)
    note('Then you add the tunnel in ChatGPT once; chat-unleashed connect prints that part.')
    hint('Run chat-unleashed setup to apply the changes.')
    gap()
    return 0
  }

  if (!state.client.installed) {
    section('Client')
    const consent = assumeYes || await ask('Install tunnel-client with Homebrew? (y/n)', {
      fallback: 'y',
      validate: (value) => (/^[yn]/i.test(value) ? null : 'Answer y or n.')
    })
    if (!/^y/i.test(consent)) {
      note('Skipped. Install it with: brew install openai/tools/tunnel-client')
      return 1
    }
    note('brew install openai/tools/tunnel-client')
    const result = spawnSync('brew', ['install', 'openai/tools/tunnel-client'], {
      stdio: 'inherit',
      timeout: 300000
    })
    if (result.status !== 0) {
      note('Homebrew did not finish. Run the command above yourself, then run chat-unleashed setup again.')
      return 1
    }
  }

  let tunnelId = state.profile.tunnelId
  if (!tunnelId) {
    section('Tunnel')
    note('ChatGPT cannot reach a loopback server, so it goes through an OpenAI tunnel.')
    note('Create one, then copy the ID it shows.')
    hint(TUNNELS_URL)
    if (!process.stdin.isTTY) {
      note('No terminal to ask in. Create the tunnel, then run chat-unleashed setup in a terminal.')
      return 1
    }
    tunnelId = await ask('Tunnel ID', {
      validate: (value) => (TUNNEL_ID_RE.test(value) ? null : tunnelIdProblem(value))
    })
  }

  if (!state.key.present) {
    section('Runtime key')
    note('Create a runtime API key with Tunnels Read and Use, then paste it here once.')
    hint(KEYS_URL)
    if (!process.stdin.isTTY) {
      note('No terminal to ask in. Export CONTROL_PLANE_API_KEY, then run chat-unleashed setup again.')
      return 1
    }
    note('Input is hidden. It is stored in .env.tunnel with mode 600 and never printed.')
    const entered = sanitizeKey(await askSecret('Runtime API key'))
    if (entered.problem) {
      note(entered.problem)
      return 1
    }
    writeKeyToEnvFile(entered.key)
    note('Stored. The profile keeps the variable name, not the value.')
  } else if (state.key.source === 'the environment' && !existsSync(ENV_FILE)) {
    writeKeyToEnvFile(process.env.CONTROL_PLANE_API_KEY)
    note('Copied the key from the environment into .env.tunnel so the launchd job can read it.')
  }

  section('Profile')
  const profilePath = join(CLIENT_CONFIG, `${PROFILE}.yaml`)
  const wrongTarget = state.profile.exists && state.profile.serverUrl !== MCP_URL_FALLBACK
  if (!state.profile.exists || wrongTarget) {
    const result = ensureProfile(tunnelId)
    if (!result.ok) {
      note('tunnel-client could not write the profile.')
      hint((result.output.split('\n')[0] || 'Run tunnel-client init by hand, then chat-unleashed setup again.').trim())
      return 1
    }
    note(`Wrote ${displayPath(profilePath)} for ${MCP_URL_FALLBACK}.`)
  } else if (!state.profile.tunnelId && tunnelId) {
    writeTunnelIdToProfile(profilePath, tunnelId)
    note('Added the tunnel ID to the existing profile.')
  }

  section('Credentials')
  const check = spawnSync(which('tunnel-client') || 'tunnel-client', ['doctor', '--profile', PROFILE], {
    encoding: 'utf8',
    timeout: 30000
  })
  if (check.status === 0) {
    note('tunnel-client accepts the profile and the key.')
  } else {
    note('tunnel-client did not validate the key yet.')
    hint('The services will still start. If the tunnel never becomes ready, recheck the key and its Tunnels permissions.')
  }

  if (!state.dist.exists) {
    section('MCP server')
    const repo = PKG_ROOT
    if (!existsSync(join(repo, 'package.json'))) {
      note('No built server and no source checkout to build from.')
      note('Install it with: npm install -g local-agent-mcp, then run chat-unleashed setup again.')
      return 1
    }
    note('Building the server with npm run build.')
    const build = spawnSync('npm', ['run', 'build'], { cwd: repo, stdio: 'inherit', timeout: 300000 })
    if (build.status !== 0) {
      note('The build failed. Fix the first error above, then run chat-unleashed setup again.')
      return 1
    }
    spawnSync('node', [join(repo, 'scripts/deploy-local.mjs')], { cwd: repo, stdio: 'inherit', timeout: 120000 })
  }

  section('Services')
  const current = await collectState()
  const jobs = ensureJobs(current)
  for (const path of jobs.created) note(`Wrote ${displayPath(path)}.`)
  if (jobs.error) {
    note(jobs.error)
    return 1
  }

  const fresh = await collectState()
  await bringUp(fresh.jobs, fresh.profile, withSpinner)

  const final = await collectState()
  gap()
  if (!final.server.healthy || !final.tunnel.ready) {
    note(`The server is ${final.server.healthy ? 'answering' : 'not answering'} and the tunnel is ${final.tunnel.ready ? 'ready' : trimTo(final.tunnel.body, 40)}.`)
    hint('chat-unleashed doctor names the failing check.')
    return 1
  }
  row('Ready', `${final.server.tools ?? '?'} tools ${faint('·')} ${hostOf(final.server.url)} ${faint('·')} tunnel ready`, 'ok')
  connectorGuide(final)
  gap()
  return 0
}

function connectorGuide(state) {
  section('ChatGPT')
  note('Chat is the chat surface. Work and Codex act and share the agentic allowance; this connector gives Chat the same local reach.')
  gap()
  if (state?.profile?.tunnelId) {
    line(`  ${sub(padEnd('Tunnel ID', 16))}${bold(state.profile.tunnelId)}`)
    hint('Paste this ID into the connector screen.')
  }
  note('1. Open chatgpt.com on the web and sign in.')
  note('2. Settings, Security and login, turn on Developer mode.')
  note('3. Settings, Connectors (or Plugins), Add custom MCP server.')
  note('4. Name it Chat Unleashed, choose Tunnel, paste the ID above, save.')
  note('5. Start a new chat, select the app from the composer, and ask for something local.')
  hint('The first write asks for approval. Remember applies to that conversation only.')
  gap()
  note(`Tunnels  ${TUNNELS_URL}`)
  note(`Keys     ${KEYS_URL}`)
  note(`ChatGPT  ${CONNECTORS_URL}`)
}

async function connectCommand() {
  const state = await withSpinner('Checking the tunnel', collectState)
  if (!state.profile.exists || !state.profile.tunnelId || !state.key.present) {
    note('The tunnel is not configured yet.')
    hint('Run chat-unleashed setup first.')
    gap()
    return 1
  }
  if (flags.has('--open')) {
    for (const url of [TUNNELS_URL, KEYS_URL, CONNECTORS_URL]) {
      spawnSync('open', [url], { timeout: 5000 })
    }
    note('Opened the tunnel, key and connector pages in your browser.')
  }
  row('Tunnel', state.tunnel.ready ? 'ready' : trimTo(state.tunnel.body, 30), state.tunnel.ready ? 'ok' : 'bad')
  connectorGuide(state)
  gap()
  return state.tunnel.ready ? 0 : 1
}

function stopServices(state) {
  for (const job of [state.jobs.server, state.jobs.tunnel]) {
    if (!job) continue
    spawnSync('launchctl', ['bootout', `gui/${UID}/${job.label}`], { encoding: 'utf8', timeout: 5000 })
    note(`Stopped ${job.label}.`)
  }
}

async function startCommand(restart) {
  let state = await collectState()
  if (restart) {
    stopServices(state)
    await new Promise((resolve) => setTimeout(resolve, 900))
    state = await collectState()
  }
  const jobs = ensureJobs(state)
  for (const path of jobs.created) note(`Wrote ${displayPath(path)}.`)
  if (jobs.error) {
    note(jobs.error)
    return 1
  }
  state = await collectState()
  await bringUp(state.jobs, state.profile, withSpinner)
  const final = await collectState()
  if (!final.server.healthy || !final.tunnel.ready) {
    row('MCP server', final.server.healthy ? `${final.server.tools ?? '?'} tools` : `no answer at ${hostOf(final.server.url)}`,
      final.server.healthy ? 'ok' : 'bad')
    row('Tunnel', final.tunnel.ready ? 'ready' : trimTo(final.tunnel.body, 30), final.tunnel.ready ? 'ok' : 'bad')
    hint('chat-unleashed logs tunnel shows why the tunnel stopped.')
    return 1
  }
  row('MCP server', `${final.server.tools ?? '?'} tools ${faint('·')} ${hostOf(final.server.url)}`, 'ok')
  row('Tunnel', `ready ${faint('·')} ${hostOf(final.tunnel.url)}`, 'ok')
  return 0
}

function showLogs(which) {
  const logs = {
    server: join(LOG_DIR, 'server-http.log'),
    tunnel: join(LOG_DIR, 'tunnel-daemon.log'),
    launchd: join(LOG_DIR, 'tunnel-launchd.log')
  }
  const path = logs[which] || logs.server
  if (!existsSync(path)) {
    note(`No log at ${displayPath(path)} yet.`)
    return 1
  }
  note(`${displayPath(path)} ${faint('·')} Control-C to stop`)
  const tail = spawn('tail', ['-n', '40', '-f', path], { stdio: 'inherit' })
  tail.on('exit', (code) => process.exit(code ?? 0))
  return null
}

function help() {
  line(`  ${bold('chat')}${dim('-')}${bold('unleashed')} ${sub(VERSION)}`)
  line(`  ${sub('Setup and health for the local MCP server and its OpenAI tunnel.')}`)

  section('Naming')
  line(`  ${padEnd('Connector', 20)}${sub('Chat Unleashed')}`)
  line(`  ${padEnd('Alias', 20)}${sub('local mac')}`)

  section('Usage')
  line(`  chat-unleashed ${dim('[command] [options]')}`)

  section('Commands')
  const commands = [
    ['(none)', 'Check this Mac and name the next step'],
    ['setup', 'Guided setup, safe to run again at any time'],
    ['connect', 'Walk through adding the tunnel in ChatGPT'],
    ['doctor', 'Every check, with the fix for each failure'],
    ['status', 'One line for scripts, JSON with --json'],
    ['start', 'Load and start the server and the tunnel'],
    ['stop', 'Stop both'],
    ['restart', 'Stop and start both'],
    ['logs [name]', 'Follow server, tunnel or launchd'],
    ['help', 'This screen']
  ]
  for (const [name, description] of commands) {
    line(`  ${action(padEnd(name, 16))}${sub(description)}`)
  }

  section('Options')
  const options = [
    ['--profile <name>', 'Tunnel profile to read and start (local-mac)'],
    ['--json', 'Machine readable output for status and doctor'],
    ['--check', 'With setup: show the plan, write nothing'],
    ['--yes', 'With setup: accept the install prompt'],
    ['--no-color', 'Plain text'],
    ['--verbose', 'Show how long the probe took']
  ]
  for (const [name, description] of options) {
    line(`  ${padEnd(name, 20)}${sub(description)}`)
  }

  section('First run')
  line(`  ${faint('npm link')} ${sub('inside the local-agent-mcp checkout, then run chat-unleashed.')}`)
  gap()
}

async function main() {
  switch (command) {
    case 'home': {
      const state = await withSpinner('Checking your Mac', collectState)
      renderDashboard(state)
      return 0
    }
    case 'setup':
      return setup()
    case 'connect':
      return connectCommand()
    case 'doctor':
      return doctor()
    case 'status':
      return statusLine()
    case 'start':
      return startCommand(false)
    case 'restart':
      return startCommand(true)
    case 'stop': {
      const state = await collectState()
      stopServices(state)
      return 0
    }
    case 'logs':
      return showLogs(argv.find((token, index) => index > 0 && !token.startsWith('-') && token !== 'logs')) ?? 0
    case 'version':
    case '--version':
      line(VERSION)
      return 0
    case 'help':
    case '--help':
    case '-h':
      help()
      return 0
    default:
      gap()
      note(`Unknown command "${command}".`)
      hint('chat-unleashed help lists every command.')
      gap()
      return 2
  }
}

process.on('SIGINT', () => {
  process.stdout.write('\n')
  process.exit(130)
})

const code = await main()
process.exitCode = code
