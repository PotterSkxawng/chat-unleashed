#!/usr/bin/env node
//
//  chat-unleashed: Setup, health, and management for Chat Unleashed MCP Server
// Designed following conventional CLI best practices & human interface standards.
//

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

process.stdout.on('error', (error) => {
  if (error?.code === 'EPIPE') process.exit(0)
  throw error
})

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = (() => {
  try {
    return JSON.parse(readText(join(PKG_ROOT, 'package.json')) || '{}').version || '0.0.0-unknown'
  } catch {
    return '0.0.0-unknown'
  }
})()
const DISPLAY_VERSION = (() => {
  const match = VERSION.match(/public-beta\.(\d+)$/i)
  if (match) return `Preview (Public Beta ${match[1]})`
  const beta = VERSION.match(/(?:^|-)beta\.(\d+)$/i)
  if (beta) return `Preview (Beta ${beta[1]})`
  return VERSION
})()
const MIN_NODE = [20, 11, 1]
const HOME = process.env.HOME || homedir()
const UID = typeof process.getuid === 'function' ? process.getuid() : 502

const SHARE = join(HOME, '.local/share/local-agent-mcp')
const ENV_FILE = join(SHARE, '.env.tunnel')
const LOG_DIR = join(SHARE, 'logs')
const CLIENT_CONFIG = join(HOME, '.config/tunnel-client')
const AGENTS_DIR = join(HOME, 'Library/LaunchAgents')

const DEFAULT_PROFILE = 'local-mac'
const MCP_URL_FALLBACK = 'http://127.0.0.1:3344/mcp'
const HEALTH_URL_FALLBACK = 'http://127.0.0.1:8080'
const TUNNELS_URL = 'https://platform.openai.com/settings/organization/tunnels'
const KEYS_URL = 'https://platform.openai.com/settings/organization/api-keys'
const CONNECTORS_URL = 'https://chatgpt.com/'
const CONNECTOR_NAME = 'Chat Unleashed'
const CONNECTOR_DESCRIPTION =
  'Runs commands, reads and writes files, looks at the screen and drives apps on my Mac. ' +
  'Use it when a request needs work done on the local machine instead of only an answer.'
const TUNNEL_ID_RE = /^tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}$/

const argv = process.argv.slice(2)
const named = new Map()
const flags = new Set()
const positionals = []
for (let i = 0; i < argv.length; i++) {
  const token = argv[i]
  if (!token.startsWith('-')) {
    positionals.push(token)
    continue
  }
  const [key, inline] = token.split('=')
  if (inline !== undefined) named.set(key, inline)
  else if (['--profile'].includes(key)) {
    const value = argv[++i]
    if (!value || value.startsWith('-')) {
      process.stderr.write(`${key} requires a value.\n`)
      process.exit(2)
    }
    named.set(key, value)
  } else flags.add(key)
}
const command = positionals[0]
  ?? (flags.has('--version') ? 'version' : flags.has('--help') || flags.has('-h') ? 'help' : 'home')

const PROFILE = named.get('--profile') || DEFAULT_PROFILE
const PROFILE_RE = /^[A-Za-z0-9._-]{1,64}$/
if (!PROFILE_RE.test(PROFILE)) {
  process.stderr.write('Invalid --profile. Use 1-64 letters, numbers, dots, underscores, or hyphens.\n')
  process.exit(2)
}
const NO_COLOR = flags.has('--no-color') || Boolean(process.env.NO_COLOR)
const WANTS_JSON = flags.has('--json')
const VERBOSE = flags.has('--verbose')
const COLOR = !NO_COLOR && !WANTS_JSON && (process.stdout.isTTY || process.env.FORCE_COLOR === '1')

// ============================================================================
// Semantic terminal colors
// ============================================================================
const esc = (code) => (text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : String(text))
const bold = (text) => (COLOR ? `\u001b[1m${text}\u001b[22m` : String(text))
const dim = (text) => (COLOR ? `\u001b[2m${text}\u001b[22m` : String(text))
const underline = (text) => (COLOR ? `\u001b[4m${text}\u001b[24m` : String(text))

// Use the terminal's semantic ANSI palette instead of fixed RGB values. Terminal
// themes can then choose readable light/dark variants. Symbols also carry state,
// so color is never the only success/error signal.
const cBlue = esc('34;1')
const cGreen = esc('32;1')
const cRed = esc('31;1')
const cYellow = esc('33;1')
// cWhite: bold native foreground renders appropriately on light and dark themes.
const cWhite = (t) => (COLOR ? `\u001b[1m${t}\u001b[22m` : String(t))
const cGray = (t) => (COLOR ? `\u001b[2m${t}\u001b[22m` : String(t))  // Dim native foreground
const cGuide = (t) => (COLOR ? `\u001b[2m${t}\u001b[22m` : String(t)) // Structural guide lines

function vlen(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, "").length
}

function padEnd(text, width) {
  return text + " ".repeat(Math.max(0, width - vlen(text)))
}

function line(text = '') {
  process.stdout.write(text + '\n')
}

function gap() {
  line()
}

// Tree Guide Formatting
function treeHeader(title, subtitle = '') {
  gap()
  line(cGuide('┌  ') + cWhite(title) + (subtitle ? cGray(' · ' + subtitle) : ''))
  line(cGuide('│'))
}

function treeStep(stepNum, totalSteps, title) {
  line(cGuide('◇  ') + bold(cBlue(`Step ${stepNum} of ${totalSteps}: `)) + cWhite(title))
}

function treeItem(ok, label, value = '') {
  const mark = ok ? cGreen('✔ ') : cRed('✖ ')
  line(cGuide('│  ') + mark + cWhite(label) + (value ? ' ' + cGray(value) : ''))
}

function treeInfo(text) {
  line(cGuide('│  ') + cGray(text))
}

function treeLink(label, url) {
  line(cGuide('│  ') + cGray(label + ': ') + cBlue(url))
}

function treeFooter(text, ok = true) {
  line(cGuide('│'))
  line(cGuide('└  ') + (ok ? cGreen(bold('✔ ' + text)) : cRed(bold('✖ ' + text))))
  gap()
}

// ASCII art banner — single-tone blue, visible on light and dark terminals
const BANNER_LINES = [
  '   ___ _           _     _   _       _                 _              _ ',
  '  / __\\ |__   __ _| |_  | | | |_ __ | | ___  __ _  ___| |__   ___  __| |',
  ' / /  | \'_ \\ / _` | __| | | | | \'_ \\| |/ _ \\/ _` |/ __| \'_ \\ / _ \\/ _` |',
  '/ /___| | | | (_| | |_  | |_| | | | | |  __/ (_| |\\__ \\ | | |  __/ (_| |',
  '\\____/|_| |_|\\__,_|\\__|  \\___/|_| |_|_|\\___|\\__,_||___/_| |_|\\___|\\__,_|'
]

function renderBanner() {
  gap()
  const wide = process.stdout.isTTY && (process.stdout.columns ?? 80) >= 88
  if (wide) {
    for (const l of BANNER_LINES) line('  ' + cBlue(l))
  }
  line(
    '  ' + cWhite('CHAT UNLEASHED') +
    '  ' + cGray('[ ' + DISPLAY_VERSION + ' ]') +
    '  ' + cGray('ChatGPT access to your Mac')
  )
  gap()
}

function pressEnterToContinue() {
  if (!process.stdin.isTTY) return Promise.resolve()
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    process.stdout.write(cGray('  Press Enter to continue ') + cGuide('↵') + cGray(' '))
    rl.question('', () => {
      rl.close()
      resolve()
    })
  })
}

async function withSpinner(label, work) {
  const run = typeof work === 'function' ? work : () => work
  if (!process.stdout.isTTY || NO_COLOR) return run()
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let frame = 0
  const paint = () => process.stdout.write(`\r\u001b[K  ${cBlue(frames[frame++ % frames.length])} ${cGray(label)}`)
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

function nodeVersionTuple(version = process.versions.node) {
  return String(version).split('.').slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
}

function nodeSupported(version = process.versions.node) {
  const current = nodeVersionTuple(version)
  for (let i = 0; i < MIN_NODE.length; i++) {
    if (current[i] > MIN_NODE[i]) return true
    if (current[i] < MIN_NODE[i]) return false
  }
  return true
}

function supportedPlatform() {
  return process.platform === 'darwin' && process.arch === 'arm64'
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
    if (label.includes('legacy')) continue // Preserve legacy setups
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
  if (process.env.CONTROL_PLANE_API_KEY) return { present: true, source: 'environment ($CONTROL_PLANE_API_KEY)' }
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
    } catch {}
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
  const mcp = firstTry.ok ? firstTry : await probeMcp(mcpUrl)

  return {
    ms: Date.now() - started,
    platform: { macOS: macOSVersion(), arch: process.arch, node: process.version, supported: supportedPlatform(), nodeSupported: nodeSupported() },
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
    dist: { path: join(SHARE, 'dist/index.js'), exists: existsSync(join(SHARE, 'dist/index.js')) }
  }
}

function maskId(id) {
  if (!id) return 'not set'
  if (id.length <= 16) return id
  return `${id.slice(0, 11)}…${id.slice(-4)}`
}

function nextStep(state) {
  const { client, key, profile, server, tunnel, platform } = state
  if (!platform.supported) {
    return { command: 'Apple Silicon Mac required', note: `Detected ${process.platform}-${process.arch}.` }
  }
  if (!platform.nodeSupported) {
    return { command: 'Update Node.js', note: 'Chat Unleashed requires Node.js 20.11.1 or newer.' }
  }
  if (!client.installed) {
    return {
      command: 'brew install openai/tools/tunnel-client',
      note: 'Installs the client binary required for the OpenAI tunnel.'
    }
  }
  if (!profile.exists || !profile.tunnelId || !key.present) {
    return { command: 'chat-unleashed setup', note: 'Run the step-by-step setup wizard to configure the tunnel.' }
  }
  if (!server.healthy || !tunnel.ready) {
    return { command: 'chat-unleashed restart', note: 'One or more services need to be restarted to reconnect.' }
  }
  return {
    command: 'chat-unleashed connect',
    note: 'Copy the connector settings into ChatGPT.'
  }
}

function displayPath(path) {
  return path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path
}

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'"
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function hostOf(url) {
  try {
    const parsed = new URL(url)
    return parsed.host
  } catch {
    return url
  }
}

// ============================================================================
// Dashboard Screen (Clean, Aligned, High Contrast)
// ============================================================================
function renderDashboard(state) {
  renderBanner()

  const allOperational = state.server.healthy && state.tunnel.ready
  if (allOperational) {
    line(cGreen('  ● Ready') + cGray(` · ${state.server.tools ?? '?'} tools available to ChatGPT`))
  } else {
    line(cRed('  ● Needs attention') + cGray(' · follow the Next action below'))
  }
  gap()

  const systemOk = state.platform.supported && state.platform.nodeSupported && state.client.installed
  const rows = [
    ['System',      `macOS ${state.platform.macOS || 'unknown'} · Apple Silicon · Node ${state.platform.node}`, systemOk],
    ['Secure Tunnel', state.tunnel.ready ? 'Connected' : (state.profile.tunnelId ? 'Configured, not connected' : 'Not configured'), state.tunnel.ready],
    ['MCP Server',  state.server.healthy ? `${state.server.tools ?? '?'} tools online` : 'Offline', state.server.healthy]
  ]

  for (const [lbl, val, ok] of rows) {
    const mark = ok ? cGreen('✔') : cRed('✖')
    const paddedLabel = cGray(padEnd(lbl, 14))
    const formattedVal = ok
      ? (lbl === 'MCP Server' || lbl === 'Tunnel Link' ? cGreen(val) : cWhite(val))
      : cRed(val)
    line(`  ${paddedLabel}${padEnd(formattedVal, 56)} ${mark}`)
  }

  if (VERBOSE) {
    gap()
    line(cGray(`  Profile: ${displayPath(state.profile.path)}`))
    line(cGray(`  MCP: ${state.server.url}`))
    line(cGray(`  Tunnel health: ${state.tunnel.url}`))
    line(cGray(`  Checked in ${state.ms} ms`))
  }

  gap()
  const next = nextStep(state)
  line(cGray('  Next:') + '  ' + cWhite(next.command) + cGray('  ·  ' + next.note))
  gap()
}

// ============================================================================
// Connect Guide — clean table of 5 copyable values
// ============================================================================
function connectorGuide(state) {
  const tunnelId = state?.profile?.tunnelId || 'run chat-unleashed setup first'

  gap()
  line(cWhite('  Copy these 5 values into ChatGPT:'))
  line(cGray('  ChatGPT web › Plugins › + › Add custom MCP server'))
  gap()

  // Simple two-column table: dim label, bold value
  const labelW = 22
  const rows = [
    ['1. Name',            CONNECTOR_NAME],
    ['2. Description',     'Runs commands, reads/writes files, looks at screen'],
    ['  ',                 'and drives apps on your Mac.'],
    ['3. Connection Type', 'Tunnel'],
    ['4. Tunnel ID',       tunnelId],
    ['5. Authentication',  'None']
  ]

  for (const [lbl, val] of rows) {
    const paddedLabel = cGray(lbl.padEnd(labelW))
    line(`  ${paddedLabel}  ${cWhite(val)}`)
  }
  gap()
  line(cGray('  ') + cBlue(TUNNELS_URL) + cGray('  ·  OpenAI Tunnels'))
  line(cGray('  ') + cBlue(KEYS_URL) + cGray('  ·  OpenAI API Keys'))
  line(cGray('  ') + cBlue(CONNECTORS_URL) + cGray('  ·  ChatGPT'))
  gap()
}

async function connectCommand() {
  const state = await withSpinner('Checking tunnel readiness', collectState)
  if (!state.profile.exists || !state.profile.tunnelId || !state.key.present) {
    gap()
    line(cRed('✖ Tunnel is not configured yet.'))
    line(cGray('  Run ') + cWhite('chat-unleashed setup') + cGray(' to configure.'))
    gap()
    return 1
  }

  if (flags.has('--open')) {
    for (const url of [TUNNELS_URL, KEYS_URL, CONNECTORS_URL]) {
      spawnSync('open', [url], { timeout: 5000 })
    }
    line(cGreen('✔ ') + cGray('Opened ChatGPT and OpenAI tunnel/key pages in your browser.'))
  }

  connectorGuide(state)
  return state.tunnel.ready ? 0 : 1
}

// ============================================================================
// Doctor Command (Clean Diagnostic Checklist)
// ============================================================================
function checkList(state) {
  const checks = []
  const add = (group, title, status, detail, remedy) => checks.push({ group, title, status, detail, remedy })

  add('System Environment', 'macOS Version', 'ok', `${state.platform.macOS || 'unknown'} (${state.platform.arch})`, null)
  add('System Environment', 'Node.js Runtime', 'ok', state.platform.node, null)
  add(
    'System Environment',
    'tunnel-client CLI',
    state.client.installed ? 'ok' : 'bad',
    state.client.installed ? `${state.client.version || 'installed'} at ${displayPath(state.client.path)}` : 'Missing from PATH',
    state.client.installed ? null : 'brew install openai/tools/tunnel-client'
  )

  add(
    'Configuration & Credentials',
    'Tunnel Profile',
    state.profile.exists ? 'ok' : 'bad',
    state.profile.exists ? displayPath(state.profile.path) : `${PROFILE}.yaml not found`,
    state.profile.exists ? null : 'chat-unleashed setup'
  )
  add(
    'Configuration & Credentials',
    'Runtime API Key',
    state.key.present ? 'ok' : 'bad',
    state.key.present ? `Loaded from ${state.key.source}` : 'Key missing',
    state.key.present ? null : 'chat-unleashed setup'
  )
  add(
    'Configuration & Credentials',
    'Tunnel ID',
    state.profile.tunnelId ? 'ok' : 'bad',
    state.profile.tunnelId ? maskId(state.profile.tunnelId) : 'No tunnel_id in profile',
    state.profile.tunnelId ? null : 'chat-unleashed setup'
  )

  const serverJob = state.jobs.server
  add(
    'Background Services & Connectivity',
    'MCP Server Service',
    serverJob?.loaded ? 'ok' : 'warn',
    serverJob?.loaded ? `${serverJob.label} (${serverJob.running ? `PID ${serverJob.pid}` : 'idle'})` : 'Job not loaded in launchd',
    serverJob?.loaded ? null : 'chat-unleashed restart'
  )

  const tunnelJob = state.jobs.tunnel
  add(
    'Background Services & Connectivity',
    'Tunnel Service',
    tunnelJob?.loaded ? 'ok' : 'warn',
    tunnelJob?.loaded ? `${tunnelJob.label} (${tunnelJob.running ? `PID ${tunnelJob.pid}` : 'idle'})` : 'Job not loaded in launchd',
    tunnelJob?.loaded ? null : 'chat-unleashed restart'
  )

  add(
    'Background Services & Connectivity',
    'MCP Server Handshake',
    state.server.healthy ? 'ok' : 'bad',
    state.server.healthy ? `${state.server.tools ?? '?'} tools responding on ${state.server.url}` : `No answer on ${state.server.url}`,
    state.server.healthy ? null : 'chat-unleashed restart'
  )

  add(
    'Background Services & Connectivity',
    'Tunnel Readiness Probe',
    state.tunnel.ready ? 'ok' : 'bad',
    state.tunnel.ready ? `Connected & ready on ${state.tunnel.url}/readyz` : `Answers "${state.tunnel.body}" on ${state.tunnel.url}/readyz`,
    state.tunnel.ready ? null : 'chat-unleashed restart'
  )

  return checks
}

async function doctor() {
  const state = await withSpinner('Running diagnostic checks', collectState)
  if (WANTS_JSON) {
    const checks = checkList(state)
    process.stdout.write(JSON.stringify({ ok: checks.every((c) => c.status !== 'bad'), checks }, null, 2) + '\n')
    return checks.some((check) => check.status === 'bad') ? 1 : 0
  }

  const checks = checkList(state)
  treeHeader('Chat Unleashed Doctor', 'System Diagnostics')

  const groups = ['System Environment', 'Configuration & Credentials', 'Background Services & Connectivity']
  for (const g of groups) {
    line(cWhite(bold(g)))
    const groupChecks = checks.filter((c) => c.group === g)
    for (const c of groupChecks) {
      const ok = c.status === 'ok'
      const mark = ok ? cGreen('✔ ') : c.status === 'warn' ? cYellow('▲ ') : cRed('✖ ')
      line(cGuide('│  ') + mark + cWhite(c.title) + cGray(' · ' + c.detail))
      if (c.remedy) {
        line(cGuide('│     ') + cGray('↳ To fix: ') + cWhite(c.remedy))
      }
    }
    line(cGuide('│'))
  }

  if (VERBOSE) treeInfo(`State collected in ${state.ms} ms`)

  const failed = checks.filter((c) => c.status === 'bad').length
  const passed = checks.filter((c) => c.status === 'ok').length

  if (failed === 0) {
    treeFooter(`All ${passed} checks passed! Everything is healthy and connected.`, true)
    return 0
  } else {
    treeFooter(`${failed} check${failed > 1 ? 's' : ''} failed. Run recommended fixes above.`, false)
    return 1
  }
}

// ============================================================================
// Setup Wizard (Step-by-Step, Interactive, Dead-Simple for Anyone)
// ============================================================================
function ask(question, { fallback = '', validate } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const promptText = `${cGuide('?  ')}${cWhite(question)}${fallback ? cGray(` (${fallback})`) : ''}: ${cBlue('›')} `
    rl.question(promptText, (answer) => {
      rl.close()
      const value = answer.trim() || fallback
      if (validate) {
        const problem = validate(value)
        if (problem) {
          line(cGuide('│  ') + cRed('✖ ') + cGray(problem))
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
    process.stdout.write(`${cGuide('?  ')}${cWhite(question)}: ${cBlue('›')} `)
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

function writeKeyToEnvFile(key) {
  mkdirSync(SHARE, { recursive: true })
  const existing = readText(ENV_FILE) || ''
  const entry = `export CONTROL_PLANE_API_KEY=${shellQuote(key)}`
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

function ensureJobs(state) {
  mkdirSync(AGENTS_DIR, { recursive: true })
  mkdirSync(LOG_DIR, { recursive: true })
  const created = []

  if (!state.jobs.server) {
    const nodePath = which('node') || process.execPath
    const entry = state.dist.exists ? state.dist.path : (existsSync(join(PKG_ROOT, 'dist/index.js')) ? join(PKG_ROOT, 'dist/index.js') : null)
    if (!entry) return { created, error: 'Server bundle is not compiled (run npm run build first).' }
    const path = join(AGENTS_DIR, 'com.local-agent-mcp.server.plist')
    writeFileSync(path, plistServer(nodePath, entry), { mode: 0o644 })
    created.push(path)
  }
  if (!state.jobs.tunnel) {
    if (!state.client.installed) return { created, error: 'tunnel-client is missing (brew install openai/tools/tunnel-client).' }
    const path = join(AGENTS_DIR, 'com.local-agent-mcp.tunnel.plist')
    writeFileSync(path, plistTunnel(state.client.path), { mode: 0o644 })
    created.push(path)
  }
  return { created, error: null }
}

function plistServer(nodePath, entry) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.local-agent-mcp.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(entry)}</string>
    <string>--http</string>
    <string>--port</string>
    <string>3344</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>WorkingDirectory</key><string>${xmlEscape(SHARE)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xmlEscape(join(LOG_DIR, 'server-http.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(LOG_DIR, 'server-http.log'))}</string>
</dict>
</plist>
`
}

function plistTunnel(clientPath) {
  const logPath = join(LOG_DIR, 'tunnel-daemon.log')
  const script = `set -a; f=${shellQuote(ENV_FILE)}; [ -s "$f" ] || cp "$f.bak" "$f" 2>/dev/null; . "$f"; set +a; exec ${shellQuote(clientPath)} run --profile ${shellQuote(PROFILE)} >> ${shellQuote(logPath)} 2>&1`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.local-agent-mcp.tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>${xmlEscape(script)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>WorkingDirectory</key><string>${xmlEscape(SHARE)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${xmlEscape(join(LOG_DIR, 'tunnel-launchd.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(LOG_DIR, 'tunnel-launchd.log'))}</string>
</dict>
</plist>
`
}

function kickJob(job) {
  if (!job) return false
  const state = launchJob(job.label)
  if (!state.loaded) {
    const boot = spawnSync('launchctl', ['bootstrap', `gui/${UID}`, job.path], { encoding: 'utf8', timeout: 5000 })
    if (boot.status !== 0) {
      // Compatibility fallback for older launchctl behavior.
      spawnSync('launchctl', ['load', '-w', job.path], { encoding: 'utf8', timeout: 5000 })
    }
  }
  spawnSync('launchctl', ['kickstart', '-k', `gui/${UID}/${job.label}`], { encoding: 'utf8', timeout: 5000 })
  return true
}

async function bringUp(jobs, profile, onStep) {
  if (jobs.server) {
    kickJob(jobs.server)
    await onStep('Waiting for MCP server on port 3344', () =>
      waitUntil(async () => (await probeMcp(profile.mcpUrl)).ok, 60000))
  }
  if (!jobs.tunnel) return
  const ready = () => waitUntil(async () => {
    const probe = await getText(`${profile.healthBase}/readyz`, 4000)
    return probe.ok && probe.text === 'ready'
  }, 45000)
  kickJob(jobs.tunnel)
  if (await onStep('Waiting for OpenAI tunnel connection', ready)) return
  kickJob(jobs.tunnel)
  await onStep('Waiting for tunnel (second attempt)', ready)
}

async function waitUntil(check, timeoutMs = 45000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  return false
}

async function setup() {
  const dryRun = flags.has('--check')
  const assumeYes = flags.has('--yes')
  const forceNew = flags.has('--fresh')

  renderBanner()

  if (dryRun) {
    line(cGray('  Running in inspection mode (--check). No files will be changed.'))
    gap()
  }

  const state = await withSpinner('Checking system state', collectState)

  // --------------------------------------------------------------------------
  // Step 1: System Requirements
  // --------------------------------------------------------------------------
  gap()
  line(cWhite('Step 1 of 4') + cGray('  ·  System Requirements'))
  line(cGuide('─'.repeat(48)))
  if (!state.platform.supported) {
    line(cRed('✖ ') + cWhite('Apple Silicon Mac required') + cGray(` · detected ${process.platform}-${process.arch}`))
    line(cGray('  Chat Unleashed supports macOS on Apple Silicon only.'))
    gap()
    return 1
  }
  line(cGreen('✔ ') + 'macOS ' + cWhite(state.platform.macOS || 'unknown') + cGray(' on Apple Silicon'))

  if (!state.platform.nodeSupported) {
    line(cRed('✖ ') + cWhite('Node.js 20.11.1 or newer required') + cGray(` · detected ${state.platform.node}`))
    line(cGray('  Update Node.js, then run setup again.'))
    gap()
    return 1
  }
  line(cGreen('✔ ') + 'Node.js ' + cWhite(state.platform.node))

  if (!state.client.installed) {
    line(cRed('✖ ') + cWhite('tunnel-client') + cGray(' is not installed'))
    if (!which('brew')) {
      line(cRed('✖ ') + cWhite('Homebrew is required to install tunnel-client automatically.'))
      line(cGray('  Install Homebrew from https://brew.sh, then run setup again.'))
      gap()
      return 1
    }
    gap()
    if (dryRun) {
      line(cGray('  Action needed: brew install openai/tools/tunnel-client'))
    } else {
      const consent = assumeYes || await ask('Install tunnel-client via Homebrew? (Y/n)', {
        fallback: 'y',
        validate: (v) => (/^[yn]/i.test(v) ? null : 'Please answer y or n.')
      })
      if (!/^y/i.test(consent)) {
        gap()
        line(cYellow('▲ ') + cGray('Skipped. Run: brew install openai/tools/tunnel-client, then run setup again.'))
        gap()
        return 1
      }
      gap()
      line(cGray('  Running brew install openai/tools/tunnel-client…'))
      const brew = spawnSync('brew', ['install', 'openai/tools/tunnel-client'], { stdio: 'inherit', timeout: 300000 })
      if (brew.status !== 0) {
        gap()
        line(cRed('✖ ') + cGray('Homebrew install failed. Install manually and retry.'))
        gap()
        return 1
      }
      line(cGreen('✔ ') + 'tunnel-client installed')
    }
  } else {
    line(cGreen('✔ ') + 'tunnel-client ' + cWhite(state.client.version || 'installed'))
  }

  if (!dryRun) await pressEnterToContinue()

  // --------------------------------------------------------------------------
  // Step 2: OpenAI Secure Tunnel
  // --------------------------------------------------------------------------
  gap()
  line(cWhite('Step 2 of 4') + cGray('  ·  OpenAI Tunnel'))
  line(cGuide('─'.repeat(48)))
  line(cGray('A secure tunnel lets ChatGPT reach your Mac without exposing any ports.'))
  line(cGray('Create your tunnel at: ') + cBlue(TUNNELS_URL))
  gap()

  let tunnelId = state.profile.tunnelId

  if (tunnelId && !forceNew) {
    // Existing tunnel found — ask if they want to keep or replace it
    line(cGreen('✔ ') + 'Existing tunnel found: ' + cWhite(maskId(tunnelId)))
    if (!dryRun && !assumeYes) {
      const keep = await ask('Keep this tunnel? (Y/n)', {
        fallback: 'y',
        validate: (v) => (/^[yn]/i.test(v) ? null : 'Please answer y or n.')
      })
      if (!/^y/i.test(keep)) {
        tunnelId = await ask('Enter your new Tunnel ID (starts with tunnel_)', {
          validate: (val) => (TUNNEL_ID_RE.test(val) ? null : 'Must start with "tunnel_" followed by 32 characters.')
        })
        line(cGreen('✔ ') + 'Tunnel ID updated: ' + cWhite(maskId(tunnelId)))
      }
    }
  } else {
    if (dryRun) {
      line(cGray('  Action needed: Paste your Tunnel ID (starts with tunnel_)'))
    } else {
      tunnelId = await ask('Paste your Tunnel ID (starts with tunnel_)', {
        validate: (val) => (TUNNEL_ID_RE.test(val) ? null : 'Must start with "tunnel_" followed by 32 characters.')
      })
      line(cGreen('✔ ') + 'Tunnel ID saved: ' + cWhite(maskId(tunnelId)))
    }
  }

  if (!dryRun) await pressEnterToContinue()

  // --------------------------------------------------------------------------
  // Step 3: OpenAI Runtime API Key
  // --------------------------------------------------------------------------
  gap()
  line(cWhite('Step 3 of 4') + cGray('  ·  OpenAI Runtime API Key'))
  line(cGuide('─'.repeat(48)))
  line(cGray('Your Mac needs this key to authenticate with the OpenAI tunnel.'))
  line(cGray('Create an API key with "Tunnels Read & Use" at: ') + cBlue(KEYS_URL))
  gap()

  if (state.key.present && !forceNew) {
    line(cGreen('✔ ') + 'Runtime key stored in ' + cWhite(state.key.source))
    if (!dryRun && !assumeYes) {
      const keep = await ask('Keep existing key? (Y/n)', {
        fallback: 'y',
        validate: (v) => (/^[yn]/i.test(v) ? null : 'Please answer y or n.')
      })
      if (!/^y/i.test(keep)) {
        const entered = await askSecret('Paste your new OpenAI Runtime API Key')
        if (!entered || entered.length < 10) {
          gap()
          line(cRed('✖ ') + cGray('No valid key provided. Run setup again when ready.'))
          gap()
          return 1
        }
        writeKeyToEnvFile(entered.trim())
        line(cGreen('✔ ') + 'Key saved securely in ' + cWhite('~/.local/share/local-agent-mcp/.env.tunnel'))
      }
    }
  } else {
    if (dryRun) {
      line(cGray('  Action needed: Paste your OpenAI API key with Tunnels permissions'))
    } else {
      line(cGray('  Your input is masked and saved to a 0600 file — never printed:'))
      const entered = await askSecret('Paste your OpenAI Runtime API Key')
      if (!entered || entered.length < 10) {
        gap()
        line(cRed('✖ ') + cGray('No valid key provided. Run setup again when ready.'))
        gap()
        return 1
      }
      writeKeyToEnvFile(entered.trim())
      line(cGreen('✔ ') + 'Key saved securely in ' + cWhite('~/.local/share/local-agent-mcp/.env.tunnel'))
    }
  }

  if (!dryRun) await pressEnterToContinue()

  // --------------------------------------------------------------------------
  // Step 4: Background Services & Verification
  // --------------------------------------------------------------------------
  gap()
  line(cWhite('Step 4 of 4') + cGray('  ·  Starting Chat Unleashed'))
  line(cGuide('─'.repeat(48)))

  if (dryRun) {
    if (state.server.healthy && state.tunnel.ready) {
      line(cGreen('✔ ') + 'Server and secure tunnel are already healthy. No service changes are needed.')
    } else {
      line(cGray('  Action needed: Build the server, register background services, and verify the connection.'))
    }
    gap()
    line(cGreen('✔ ') + 'Inspection complete. ' + (state.server.healthy && state.tunnel.ready
      ? 'Your current setup is ready.'
      : 'Run ' + cWhite('chat-unleashed setup') + ' to apply.'))
    gap()
    return 0
  }

  // Profile setup
  const profilePath = join(CLIENT_CONFIG, `${PROFILE}.yaml`)
  if (!state.profile.exists || state.profile.serverUrl !== MCP_URL_FALLBACK) {
    const res = ensureProfile(tunnelId)
    if (!res.ok) {
      gap()
      line(cRed('✖ ') + cGray('Failed to initialize tunnel profile: ' + res.output))
      gap()
      return 1
    }
    line(cGreen('✔ ') + 'Tunnel profile written: ' + cGray(displayPath(profilePath)))
  } else if (!state.profile.tunnelId && tunnelId) {
    writeTunnelIdToProfile(profilePath, tunnelId)
    line(cGreen('✔ ') + 'Tunnel ID saved to profile: ' + cGray(displayPath(profilePath)))
  } else {
    line(cGreen('✔ ') + 'Profile: ' + cGray(displayPath(profilePath)))
  }

  // Compile if needed
  if (!state.dist.exists) {
    line(cGray('  Compiling server bundle (npm run build)…'))
    const bld = spawnSync('npm', ['run', 'build'], { cwd: PKG_ROOT, stdio: 'inherit', timeout: 300000 })
    if (bld.status !== 0) {
      gap()
      line(cRed('✖ ') + cGray('Compilation failed. Fix errors and retry.'))
      gap()
      return 1
    }
    spawnSync('node', [join(PKG_ROOT, 'scripts/deploy-local.mjs')], { cwd: PKG_ROOT, stdio: 'inherit', timeout: 60000 })
    line(cGreen('✔ ') + 'Server bundle compiled and deployed')
  } else {
    line(cGreen('✔ ') + 'Server bundle already compiled')
  }

  // Register daemons
  const curr = await collectState()
  const jobs = ensureJobs(curr)
  for (const p of jobs.created) line(cGreen('✔ ') + 'Registered: ' + cGray(displayPath(p)))
  if (jobs.error) {
    gap()
    line(cRed('✖ ') + cGray(jobs.error))
    gap()
    return 1
  }

  // Start & Bring up
  const fresh = await collectState()
  await bringUp(fresh.jobs, fresh.profile, withSpinner)

  const final = await collectState()
  gap()
  if (final.server.healthy && final.tunnel.ready) {
    line(cGreen('✔ ') + cWhite('Setup complete!') + ' Chat Unleashed is live and ready for ChatGPT.')
    line(cGreen('  ✔ ') + 'MCP Server: ' + cWhite(`${final.server.tools ?? '?'} tools ready`))
    line(cGreen('  ✔ ') + 'OpenAI Tunnel: ' + cWhite('connected'))

    const updater = spawnSync(process.execPath, [join(PKG_ROOT, 'scripts/deferred-update.mjs'), 'install'], {
      encoding: 'utf8',
      cwd: PKG_ROOT,
      timeout: 15000
    })
    if (updater.status === 0) {
      line(cGreen('  ✔ ') + 'Safe updater: ' + cWhite('installed'))
    } else {
      line(cYellow('  ▲ ') + 'Safe updater could not be installed automatically.')
      if (VERBOSE) line(cGray('    ' + (updater.stderr || updater.stdout || '').trim()))
    }
    gap()

    // Inline final step: ChatGPT connector values
    line(cWhite('Almost done!') + cGray('  Copy these 5 values into ChatGPT to connect:'))
    line(cGray('  ChatGPT web › Plugins › + › Add custom MCP server'))
    connectorGuide(final)

    if (!assumeYes) {
      const open = await ask('Open ChatGPT Connectors in your browser? (y/N)', {
        fallback: 'n',
        validate: (v) => (/^[yn]/i.test(v) ? null : 'Please answer y or n.')
      })
      if (/^y/i.test(open)) {
        spawnSync('open', [CONNECTORS_URL], { timeout: 5000 })
        line(cGreen('✔ ') + cGray('Opened in browser.'))
        gap()
      }
    }
    return 0
  } else {
    line(cRed('✖ ') + 'Services did not fully come up.')
    line(cGray('  Server: ') + (final.server.healthy ? cGreen('online') : cRed('offline')))
    line(cGray('  Tunnel: ') + (final.tunnel.ready ? cGreen('ready') : cRed('offline')))
    gap()
    line(cGray('  Run ') + cWhite('chat-unleashed doctor') + cGray(' to inspect what went wrong.'))
    gap()
    return 1
  }
}

// ============================================================================
// Service Lifecycle (start, stop, restart, logs, status)
// ============================================================================
function stopServices(state) {
  for (const job of [state.jobs.server, state.jobs.tunnel]) {
    if (!job) continue
    spawnSync('launchctl', ['bootout', `gui/${UID}/${job.label}`], { encoding: 'utf8', timeout: 5000 })
    line(cGreen('✔ ') + cGray('Stopped ') + cWhite(job.label))
  }
}

async function startCommand(restart) {
  gap()
  line(cWhite(restart ? ' Restarting Services...' : ' Starting Services...'))
  gap()
  let state = await collectState()
  if (restart) {
    stopServices(state)
    await new Promise((resolve) => setTimeout(resolve, 800))
    state = await collectState()
  }
  const jobs = ensureJobs(state)
  for (const p of jobs.created) line(cGreen('✔ ') + cGray(`Created ${displayPath(p)}`))
  if (jobs.error) {
    line(cRed('✖ ') + cGray(jobs.error))
    return 1
  }

  state = await collectState()
  await bringUp(state.jobs, state.profile, withSpinner)
  const final = await collectState()
  gap()

  if (final.server.healthy && final.tunnel.ready) {
    line(cGreen('✔ All services running and operational!'))
    line(`  ${cGray('MCP Server:')} ${cGreen(`${final.server.tools ?? '?'} tools online`)} ${cGray(`(${final.server.url})`)}`)
    line(`  ${cGray('Tunnel:')}     ${cGreen('Connected & ready')} ${cGray(`(${final.tunnel.url})`)}`)
    gap()
    return 0
  } else {
    line(cRed('✖ Services did not come up completely.'))
    line(`  ${cGray('Server:')} ${final.server.healthy ? cGreen('online') : cRed('offline')}`)
    line(`  ${cGray('Tunnel:')} ${final.tunnel.ready ? cGreen('ready') : cRed('offline')}`)
    line(cGray('  Run `chat-unleashed doctor` to inspect causes.'))
    gap()
    return 1
  }
}

function showLogs(which) {
  gap()
  const logs = {
    server: join(LOG_DIR, 'server-http.log'),
    tunnel: join(LOG_DIR, 'tunnel-daemon.log'),
    launchd: join(LOG_DIR, 'tunnel-launchd.log')
  }
  const path = logs[which] || logs.server
  if (!existsSync(path)) {
    line(cYellow('▲ ') + cGray(`No log file found at ${displayPath(path)} yet.`))
    gap()
    return 1
  }
  line('  ' + cWhite('Streaming log') + '  ' + cBlue(displayPath(path)) + cGray('  ·  Press Control-C to stop'))
  gap()
  const tail = spawn('tail', ['-n', '40', '-f', path], { stdio: 'inherit' })
  tail.on('exit', (code) => process.exit(code ?? 0))
  return null
}

function statusLine() {
  return collectState().then((state) => {
    if (WANTS_JSON) {
      const next = nextStep(state)
      process.stdout.write(JSON.stringify({
        ok: state.server.healthy && state.tunnel.ready,
        version: VERSION,
        channel: DISPLAY_VERSION,
        client: state.client.version,
        profile: state.profile.name,
        tunnelId: state.profile.tunnelId,
        server: { url: state.server.url, healthy: state.server.healthy, tools: state.server.tools },
        tunnel: { url: state.tunnel.url, ready: state.tunnel.ready, body: state.tunnel.body },
        next: next.command
      }, null, 2) + '\n')
      return state.server.healthy && state.tunnel.ready ? 0 : 1
    }
    const mark = state.server.healthy && state.tunnel.ready ? cGreen('●') : cRed('✖')
    const parts = [
      `server ${state.server.healthy ? cGreen(`${state.server.tools ?? '?'} tools`) : cRed('down')}`,
      `tunnel ${state.tunnel.ready ? cGreen('ready') : cRed('down')}`
    ]
    line(`${mark}  ${parts.join(cGray(' · '))}  ${cGray(`(${DISPLAY_VERSION})`)}`)
    return state.server.healthy && state.tunnel.ready ? 0 : 1
  })
}

// ============================================================================
// Update Command (Standard CLI Updater)
// ============================================================================
async function updateCommand() {
  const isCheckOnly = flags.has('--check')
  const isForce = flags.has('--force')
  const isStage = flags.has('--stage')
  const isStatus = flags.has('--status')
  const isCancel = flags.has('--cancel')
  const updaterScript = join(PKG_ROOT, 'scripts/deferred-update.mjs')

  const updaterAction = (action) => spawnSync(process.execPath, [updaterScript, action], {
    encoding: 'utf8',
    cwd: PKG_ROOT,
    timeout: action === 'install' ? 15000 : 30000
  })

  if (isStatus) {
    treeHeader('Chat Unleashed Update', 'Safe Update Status')
    const res = updaterAction('status')
    treeInfo((res.stdout || res.stderr || '').trim() || 'No deferred update currently pending.')
    treeFooter('Status check complete.', res.status === 0)
    return res.status === 0 ? 0 : 1
  }

  if (isCancel) {
    treeHeader('Chat Unleashed Update', 'Cancel Pending Update')
    const res = updaterAction('cancel')
    treeInfo((res.stdout || res.stderr || '').trim() || 'Cancelled any pending deferred update.')
    treeFooter('Pending update cancelled. No service was restarted.', res.status === 0)
    return res.status === 0 ? 0 : 1
  }

  if (isStage) {
    treeHeader('Chat Unleashed Update', 'Stage Current Checkout')
    treeStep(1, 3, 'Building Candidate')
    const bld = spawnSync('npm', ['run', 'build'], { cwd: PKG_ROOT, stdio: 'inherit', timeout: 300000 })
    if (bld.status !== 0) {
      treeFooter('Build failed. Nothing was staged.', false)
      return 1
    }
    treeStep(2, 3, 'Checking Safe Updater')
    const install = updaterAction('install')
    if (install.status !== 0) {
      treeInfo((install.stderr || install.stdout || '').trim())
      treeFooter('Could not install the safe updater. Live services were left untouched.', false)
      return 1
    }
    treeItem(true, 'Updater:', 'Ready')
    treeStep(3, 3, 'Staging Candidate')
    const res = updaterAction('stage')
    treeInfo((res.stdout || res.stderr || '').trim())
    treeFooter('Update staged. The tunnel stays up and the server switches only after a quiet window.', res.status === 0)
    return res.status === 0 ? 0 : 1
  }

  const isGit = existsSync(join(PKG_ROOT, '.git'))
  if (!isGit) {
    treeHeader('Chat Unleashed Update', 'Source Checkout Required')
    treeInfo('This installation was unpacked without Git metadata, so it cannot safely self-update.')
    treeInfo('Download the latest release from GitHub, replace the source checkout, then run `chat-unleashed setup`.')
    treeLink('Releases', 'https://github.com/PotterSkxawng/chat-unleashed/releases')
    treeFooter('No files or services were changed.', false)
    return 1
  }

  await withSpinner('Checking GitHub for upstream commits', () => {
    const fetch = spawnSync('git', ['fetch', 'origin', 'main', '--quiet'], { cwd: PKG_ROOT, encoding: 'utf8', timeout: 20000 })
    if (fetch.status !== 0) throw new Error((fetch.stderr || 'git fetch failed').trim())
  })

  treeHeader('Chat Unleashed Update', 'Tunnel-Safe Software Update')
  treeStep(1, 4, 'Checking for Updates')

  const head = (spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: PKG_ROOT, encoding: 'utf8' }).stdout || '').trim()
  const remote = (spawnSync('git', ['rev-parse', '--short', 'origin/main'], { cwd: PKG_ROOT, encoding: 'utf8' }).stdout || '').trim()
  const behindCount = parseInt((spawnSync('git', ['rev-list', '--count', 'HEAD..origin/main'], { cwd: PKG_ROOT, encoding: 'utf8' }).stdout || '0').trim(), 10) || 0

  treeItem(true, 'Release:', `${DISPLAY_VERSION} · ${VERSION}`)
  treeItem(true, 'Current Commit:', head)

  if (isCheckOnly) {
    if (behindCount === 0) {
      treeItem(true, 'Remote Status:', 'Up to date with origin/main')
      treeFooter('You are running the latest source.', true)
    } else {
      treeItem(false, 'Remote Status:', `${behindCount} new commit${behindCount > 1 ? 's' : ''} available on origin/main (${remote})`)
      const commitLog = (spawnSync('git', ['log', 'HEAD..origin/main', '--pretty=format:%h %s (%cr)', '-n', '5'], { cwd: PKG_ROOT, encoding: 'utf8' }).stdout || '').trim()
      line(cGuide('│'))
      treeInfo('Incoming commits:')
      for (const cl of commitLog.split('\n')) line(cGuide('│     ') + cWhite('• ' + cl))
      treeFooter('Update available. Run `chat-unleashed update` to stage it safely.', true)
    }
    return 0
  }

  if (behindCount === 0 && !isForce) {
    treeItem(true, 'Remote Status:', 'Up to date with origin/main')
    treeFooter('Already on latest source. Use --force to rebuild and restage it.', true)
    return 0
  }

  treeStep(2, 4, 'Synchronizing Source')
  if (behindCount > 0) {
    const pull = spawnSync('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: PKG_ROOT, stdio: 'inherit', timeout: 30000 })
    if (pull.status !== 0) {
      treeFooter('Fast-forward pull failed. Resolve the checkout before updating.', false)
      return 1
    }
    treeItem(true, 'Git:', 'Fast-forwarded to origin/main')
  } else {
    treeItem(true, 'Git:', 'No source pull needed')
  }

  line(cGuide('│  ') + cGray('Installing locked dependencies...'))
  const deps = spawnSync('npm', ['ci', '--prefer-offline'], { cwd: PKG_ROOT, stdio: 'inherit', timeout: 180000 })
  if (deps.status !== 0) {
    treeFooter('Dependency installation failed. Live services were left untouched.', false)
    return 1
  }

  treeStep(3, 4, 'Building and Preflighting')
  const bld = spawnSync('npm', ['run', 'build'], { cwd: PKG_ROOT, stdio: 'inherit', timeout: 300000 })
  if (bld.status !== 0) {
    treeFooter('Build failed. Live services were left untouched.', false)
    return 1
  }
  treeItem(true, 'Build:', 'Candidate bundle ready')

  const install = updaterAction('install')
  if (install.status !== 0) {
    treeInfo((install.stderr || install.stdout || '').trim())
    treeFooter('Safe updater is unavailable. Refusing to restart the live tunnel.', false)
    return 1
  }
  treeItem(true, 'Updater:', 'Tunnel-preserving watcher ready')

  treeStep(4, 4, 'Staging Safe Cutover')
  const staged = updaterAction('stage')
  treeInfo((staged.stdout || staged.stderr || '').trim())
  if (staged.status !== 0) {
    treeFooter('Staging failed. The running server and tunnel were not changed.', false)
    return 1
  }
  treeFooter('Update staged. It will switch the local server after 20 quiet minutes without restarting the tunnel.', true)
  return 0
}

// ============================================================================
// Help / Command Reference (Standard CLI Manual)
// ============================================================================
function help() {
  gap()
  line(cWhite('Chat Unleashed') + '  ' + cGray(`[ ${DISPLAY_VERSION} ]`))
  line(cGray('Secure local Mac access for ChatGPT on Apple Silicon.'))
  gap()
  line(cWhite('Usage:'))
  line('  ' + cBlue('chat-unleashed') + cGray(' [command] [options]'))
  gap()
  line(cWhite('Commands:'))
  const cmds = [
    ['(none)', 'Display system status and recommended action'],
    ['setup', 'Step-by-step interactive onboarding wizard'],
    ['connect', 'Display ChatGPT connector form values to copy'],
    ['doctor', 'Run system diagnostics and verify connectivity'],
    ['update', 'Fetch, build, and stage a tunnel-safe update'],
    ['status', 'Print one-line status summary (JSON with --json)'],
    ['start', 'Start background MCP server & tunnel services'],
    ['stop', 'Stop background services'],
    ['restart', 'Restart both services and verify readiness'],
    ['logs [target]', 'Stream live logs (server, tunnel, or launchd)'],
    ['help', 'Show this help screen']
  ]
  for (const [name, desc] of cmds) {
    line(`  ${cBlue(name.padEnd(16))}${cGray(desc)}`)
  }
  gap()
  line(cWhite('Options:'))
  const opts = [
    ['--profile <name>', 'Select tunnel profile (default: local-mac)'],
    ['--check', 'Inspect without modifying (setup/update)'],
    ['--force', 'Rebuild and restage even when source is current'],
    ['--fresh', 'Replace saved tunnel/key during setup'],
    ['--stage', 'Build and stage the current checkout (update)'],
    ['--status', 'Show pending safe-update state (update)'],
    ['--cancel', 'Cancel a pending safe update (update)'],
    ['--open', 'Open links in default browser (connect)'],
    ['--yes', 'Automatically accept setup prompts'],
    ['--json', 'Format status output as machine-readable JSON'],
    ['--no-color', 'Disable ANSI colors and decorations'],
    ['--verbose', 'Show diagnostic paths, URLs, and timing']
  ]
  for (const [name, desc] of opts) {
    line(`  ${cWhite(name.padEnd(18))}${cGray(desc)}`)
  }
  gap()
}

// ============================================================================
// Main Dispatcher
// ============================================================================
async function main() {
  switch (command) {
    case 'home': {
      const state = await withSpinner('Inspecting system status', collectState)
      renderDashboard(state)
      return 0
    }
    case 'setup':
      return setup()
    case 'connect':
      return connectCommand()
    case 'doctor':
      return doctor()
    case 'update':
      return updateCommand()
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
      return showLogs(positionals[1]) ?? 0
    case 'version':
    case '--version':
      line(`${VERSION}  (${DISPLAY_VERSION})`)
      return 0
    case 'help':
    case '--help':
    case '-h':
      help()
      return 0
    default:
      gap()
      line(cRed('✖ ') + cWhite(`Unknown command: ${command}`))
      line(cGray('  Run `chat-unleashed help` to see all available commands.'))
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
