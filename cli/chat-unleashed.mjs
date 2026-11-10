#!/usr/bin/env node
//
//  chat-unleashed: Setup, health, and management for Chat Unleashed MCP Server
// Designed around Apple Human Interface Guidelines (HIG) & SwiftUI principles.
//

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = (() => {
  try {
    return JSON.parse(readText(join(PKG_ROOT, 'package.json')) || '{}').version || '0.2.0'
  } catch {
    return '0.2.0'
  }
})()
const DISPLAY_VERSION = 'Preview (Beta 1)'
const HOME = process.env.HOME || homedir()
const UID = typeof process.getuid === 'function' ? process.getuid() : 501

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
const CONNECTORS_URL = 'https://chatgpt.com/#settings/Connectors'
const CONNECTOR_NAME = 'Chat Unleashed'
const CONNECTOR_DESCRIPTION =
  'Runs commands, reads and writes files, looks at the screen and drives apps on my Mac. ' +
  'Use it when a request needs work done on the local machine instead of only an answer.'
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

// ============================================================================
// Apple HIG & SwiftUI Terminal Design System
// ============================================================================
const esc = (code) => (text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : String(text))
const bold = (text) => (COLOR ? `\u001b[1m${text}\u001b[22m` : String(text))
const dim = (text) => (COLOR ? `\u001b[2m${text}\u001b[22m` : String(text))
const italic = (text) => (COLOR ? `\u001b[3m${text}\u001b[23m` : String(text))
const underline = (text) => (COLOR ? `\u001b[4m${text}\u001b[24m` : String(text))
const rgb = (r, g, b) => (text) => (COLOR ? `\u001b[38;2;${r};${g};${b}m${text}\u001b[0m` : String(text))
const bgRgb = (r, g, b) => (text) => (COLOR ? `\u001b[48;2;${r};${g};${b}m${text}\u001b[0m` : String(text))

// Apple System Palette
const appleBlue = rgb(10, 132, 255)       // System Blue (primary accent)
const appleCyan = rgb(100, 210, 255)     // System Cyan (teal/highlight)
const appleIndigo = rgb(94, 92, 230)     // System Indigo (connectors)
const applePurple = rgb(191, 90, 242)    // System Purple (beta/special)
const appleGreen = rgb(48, 209, 88)      // System Green (healthy, active)
const appleYellow = rgb(255, 214, 10)    // System Yellow (warning)
const appleOrange = rgb(255, 159, 10)    // System Orange (action required)
const appleRed = rgb(255, 69, 58)        // System Red (error, offline)
const appleMint = rgb(99, 230, 226)      // System Mint

// Typography Hierarchy
const textWhite = (text) => (COLOR ? `\u001b[1m\u001b[38;2;255;255;255m${text}\u001b[0m` : String(text))
const textPrimary = rgb(242, 242, 247)   // Primary content
const textSecondary = rgb(161, 161, 166) // Secondary labels, descriptions
const textTertiary = rgb(110, 110, 115)  // Tertiary paths & metadata
const borderSlate = rgb(72, 72, 84)      // Card frame border
const borderActive = rgb(10, 132, 255)   // Highlighted border
const borderWarn = rgb(255, 159, 10)     // Warning border

const codeSnippet = (text) =>
  COLOR ? `\u001b[48;2;32;36;48m\u001b[38;2;255;255;255m\u001b[1m ${text} \u001b[0m` : ` ${text} `

const stateGlyph = {
  ok: appleGreen('✓'),
  warn: appleOrange('▲'),
  bad: appleRed('✗'),
  idle: textTertiary('·')
}

function glyphFor(status) {
  return stateGlyph[status] ?? stateGlyph.idle
}

function pill(text, type = 'blue') {
  if (!COLOR) return `[${text}]`
  switch (type) {
    case 'green':  return `${appleGreen('●')} ${appleGreen(bold(`[ ${text} ]`))}`
    case 'red':    return `${appleRed('✗')} ${appleRed(bold(`[ ${text} ]`))}`
    case 'orange':
    case 'yellow': return `${appleOrange('▲')} ${appleOrange(bold(`[ ${text} ]`))}`
    case 'purple': return `${applePurple(bold(`[ ${text} ]`))}`
    case 'cyan':   return `${appleCyan(bold(`[ ${text} ]`))}`
    case 'blue':
    default:       return `${appleBlue(bold(`[ ${text} ]`))}`
  }
}

function columns() {
  const c = process.stdout.columns || 80
  return Math.max(68, Math.min(c, 86))
}

function vlen(text) {
  const clean = String(text).replace(/\u001b\[[0-9;]*m/g, '')
  let len = 0
  for (const ch of clean) {
    const code = ch.codePointAt(0)
    if ((code >= 0x1F300 && code <= 0x1F9FF) || (code >= 0x2600 && code <= 0x27BF)) len += 2
    else len += 1
  }
  return len
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

// Card container (SwiftUI Grouped Inset Box)
function card(title, badgeText, rows, width = columns(), borderColor = borderSlate) {
  const badgePart = badgeText ? ` [ ${badgeText} ]` : ''
  const titlePart = ` ${title}${badgePart} `
  const padTop = width - 2 - vlen(titlePart)
  line('  ' + borderColor('╭─' + titlePart + '─'.repeat(Math.max(0, padTop - 2)) + '╮'))
  for (const r of rows) {
    const pad = width - 4 - vlen(r)
    line('  ' + borderColor('│ ') + r + ' '.repeat(Math.max(0, pad)) + borderColor(' │'))
  }
  line('  ' + borderColor('╰' + '─'.repeat(width - 2) + '╯'))
}

// SwiftUI Inspector Form Card
function formCard(title, fields, width = columns(), borderColor = borderSlate) {
  const titlePart = ` ${title} `
  const padTop = width - 2 - vlen(titlePart)
  line('  ' + borderColor('╭─' + titlePart + '─'.repeat(Math.max(0, padTop - 2)) + '╮'))
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    const lbl = textSecondary('  FIELD: ') + appleCyan(bold(f.label.toUpperCase()))
    line('  ' + borderColor('│') + lbl + ' '.repeat(Math.max(0, width - 2 - vlen(lbl))) + borderColor('│'))
    for (const val of f.values) {
      const v = '    ' + textWhite(val)
      line('  ' + borderColor('│') + v + ' '.repeat(Math.max(0, width - 2 - vlen(v))) + borderColor('│'))
    }
    if (f.hint) {
      const h = '    ' + textSecondary('↳ ' + f.hint)
      line('  ' + borderColor('│') + h + ' '.repeat(Math.max(0, width - 2 - vlen(h))) + borderColor('│'))
    }
    if (i < fields.length - 1) {
      line('  ' + borderColor('│') + ' '.repeat(width - 2) + borderColor('│'))
    }
  }
  line('  ' + borderColor('╰' + '─'.repeat(width - 2) + '╯'))
}

function renderBanner() {
  const bannerLines = [
    '   ___ _           _     _   _       _                 _              _ ',
    '  / __\\ |__   __ _| |_  | | | |_ __ | | ___  __ _  ___| |__   ___  __| |',
    ' / /  | \'_ \\ / _` | __| | | | | \'_ \\| |/ _ \\/ _` |/ __| \'_ \\ / _ \\/ _` |',
    '/ /___| | | | (_| | |_  | |_| | | | | |  __/ (_| |\\__ \\ | | |  __/ (_| |',
    '\\____/|_| |_|\\__,_|\\__|  \\___/|_| |_|_|\\___|\\__,_||___/_| |_|\\___|\\__,_|'
  ]
  const colors = [
    [100, 210, 255],
    [85, 175, 250],
    [94, 140, 245],
    [94, 92, 230],
    [150, 90, 235]
  ]
  gap()
  bannerLines.forEach((l, i) => {
    const [r, g, b] = colors[i]
    line('  ' + (COLOR ? `\u001b[1m\u001b[38;2;${r};${g};${b}m${l}\u001b[0m` : l))
  })
  line('  ' + textWhite(' CHAT UNLEASHED') + '  ' + applePurple(`[ ${DISPLAY_VERSION} ]`) + '  ' + textSecondary('Local MCP Reach for ChatGPT Chat'))
  gap()
}

async function withSpinner(label, work) {
  const run = typeof work === 'function' ? work : () => work
  if (!process.stdout.isTTY || NO_COLOR) return run()
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let frame = 0
  const paint = () => process.stdout.write(`\r\u001b[K  ${appleCyan(frames[frame++ % frames.length])} ${textSecondary(label)}`)
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
  if (process.env.CONTROL_PLANE_API_KEY) return { present: true, source: 'environment ($CONTROL_PLANE_API_KEY)' }
  const envText = readText(ENV_FILE) || ''
  const match = envText.match(/^\s*(?:export\s+)?CONTROL_PLANE_API_KEY\s*=\s*(.+)$/m)
  if (match && match[1].trim().length > 1) return { present: true, source: '.env.tunnel file' }
  if (profile?.apiKey && !profile.apiKey.startsWith('env:')) return { present: true, source: 'tunnel profile' }
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
    dist: { path: join(SHARE, 'dist/index.js'), exists: existsSync(join(SHARE, 'dist/index.js')) }
  }
}

function maskId(id) {
  if (!id) return 'not set'
  if (id.length <= 16) return id
  return `${id.slice(0, 11)}…${id.slice(-4)}`
}

function nextStep(state) {
  const { client, key, profile, server, tunnel } = state
  if (!client.installed) {
    return {
      command: 'brew install openai/tools/tunnel-client',
      note: 'Installs the client binary that carries the tunnel to OpenAI.'
    }
  }
  if (!profile.exists) {
    return { command: 'chat-unleashed setup', note: 'Creates a tunnel profile pointed at this server.' }
  }
  if (!key.present) {
    return { command: 'chat-unleashed setup', note: `The profile asks for ${key.waiting || 'CONTROL_PLANE_API_KEY'}, and it is not set.` }
  }
  if (!profile.tunnelId) {
    return { command: 'chat-unleashed setup', note: 'The profile has no tunnel ID configured yet.' }
  }
  if (!server.healthy) {
    return { command: 'chat-unleashed restart', note: `Nothing is answering at ${server.url}.` }
  }
  if (!tunnel.ready) {
    return { command: 'chat-unleashed restart', note: `The tunnel answers "${trimTo(tunnel.body, 40)}" instead of ready.` }
  }
  return {
    command: 'chat-unleashed connect',
    note: 'Both services answer. Add Chat Unleashed in ChatGPT, then start giving it tasks on your Mac!'
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

// ============================================================================
// Dashboard Screen (HIG Grouped Inset Cards)
// ============================================================================
function renderDashboard(state) {
  const width = columns()
  renderBanner()

  const allOperational = state.server.healthy && state.tunnel.ready
  if (allOperational) {
    line(`  ${appleGreen('●')} ${textWhite('STATUS:')} ${appleGreen(bold('ALL SYSTEMS OPERATIONAL (READY FOR CHATGPT)'))}`)
  } else {
    line(`  ${appleOrange('▲')} ${textWhite('STATUS:')} ${appleOrange(bold('ACTION REQUIRED · SERVICES PENDING OR OFFLINE'))}`)
  }
  gap()

  // 1. System Environment Card
  card(
    appleCyan(bold(' SYSTEM ENVIRONMENT')),
    state.platform.arch ? state.platform.arch.toUpperCase() : 'MACOS',
    [
      `${textSecondary('macOS             ')} ${textWhite(state.platform.macOS || 'unknown')} ${textSecondary(`(Apple Silicon ${state.platform.arch})`)}`,
      `${textSecondary('Node.js runtime   ')} ${textWhite(state.platform.node)}`,
      `${textSecondary('tunnel-client     ')} ${state.client.installed ? `${textWhite(state.client.version || 'installed')} ${textSecondary(`(${displayPath(state.client.path)})`)}` : appleRed('not installed')} ${glyphFor(state.client.installed ? 'ok' : 'bad')}`
    ],
    width
  )
  gap()

  // 2. Tunnel Configuration Card
  card(
    appleIndigo(bold('✦ TUNNEL CONFIGURATION')),
    state.profile.exists ? 'CONFIGURED' : 'UNCONFIGURED',
    [
      `${textSecondary('Profile           ')} ${state.profile.exists ? `${textWhite(state.profile.name)} ${textSecondary(`(${displayPath(state.profile.path)})`)}` : appleRed('missing')} ${glyphFor(state.profile.exists ? 'ok' : 'bad')}`,
      `${textSecondary('Tunnel ID         ')} ${state.profile.tunnelId ? textWhite(maskId(state.profile.tunnelId)) : appleRed('not configured')} ${glyphFor(state.profile.tunnelId ? 'ok' : 'bad')}`,
      `${textSecondary('Runtime Key       ')} ${state.key.present ? `${textWhite('Loaded')} ${textSecondary(`from ${state.key.source}`)}` : appleRed('not set')} ${glyphFor(state.key.present ? 'ok' : 'bad')}`
    ],
    width
  )
  gap()

  // 3. Services Card
  const serverDetail = state.server.healthy
    ? `${appleGreen(bold('Running'))} ${textSecondary(`· ${state.server.tools ?? '?'} tools · ${hostOf(state.server.url)}`)}`
    : `${appleRed(bold('Offline'))} ${textSecondary(`· ${state.server.healthOk ? 'health only' : 'no answer'} · ${hostOf(state.server.url)}`)}`

  const tunnelDetail = state.tunnel.ready
    ? `${appleGreen(bold('Connected'))} ${textSecondary(`· ready · ${hostOf(state.tunnel.url)}`)}`
    : `${appleRed(bold('Offline'))} ${textSecondary(`· ${trimTo(state.tunnel.body, 28)} · ${hostOf(state.tunnel.url)}`)}`

  card(
    appleMint(bold('⚡ SERVICES & ENDPOINTS')),
    allOperational ? appleGreen('HEALTHY') : appleRed('OFFLINE'),
    [
      `${textSecondary('MCP Server        ')} ${serverDetail} ${glyphFor(state.server.healthy ? 'ok' : 'bad')}`,
      `${textSecondary('Secure Tunnel     ')} ${tunnelDetail} ${glyphFor(state.tunnel.ready ? 'ok' : 'bad')}`
    ],
    width
  )
  gap()

  // 4. Action Card
  const next = nextStep(state)
  const isSetupDone = allOperational && next.command.includes('connect')
  card(
    isSetupDone ? appleBlue(bold('❯ READY FOR CHATGPT')) : appleOrange(bold('❯ RECOMMENDED NEXT ACTION')),
    isSetupDone ? 'CONNECT' : 'ACTION REQUIRED',
    [
      `${textSecondary('Execute command:')}`,
      `  ${codeSnippet(next.command)}`,
      '',
      `${textSecondary('↳ Detail: ')}${textWhite(next.note)}`
    ],
    width,
    isSetupDone ? borderActive : borderWarn
  )

  if (flags.has('--verbose')) {
    gap()
    line(`  ${textTertiary(`Probed in ${state.ms} ms`) }`)
  }
  gap()
}

// ============================================================================
// ChatGPT Connector Form Inspector (Connect Guide)
// ============================================================================
function connectorGuide(state) {
  const width = columns()
  line(`  ${appleIndigo(bold('✦ CHATGPT CONNECTOR CONFIGURATION'))}`)
  line(`  ${textSecondary('Chat is where your conversations happen; this connector grants it local reach.')}`)
  gap()

  formCard(
    appleCyan(bold('FORM INSPECTOR: VALUES TO COPY INTO CHATGPT')),
    [
      { label: 'Name', values: [CONNECTOR_NAME] },
      {
        label: 'Description',
        values: [
          'Runs commands, reads and writes files, looks at the screen and',
          'drives apps on my Mac. Use it when a request needs work done',
          'on the local machine instead of only an answer.'
        ]
      },
      { label: 'Connection', values: ['Tunnel'] },
      {
        label: 'Tunnel',
        values: [state?.profile?.tunnelId ? state.profile.tunnelId : 'run chat-unleashed setup first']
      },
      {
        label: 'Authentication',
        values: ['None'],
        hint: 'None is correct: your local tunnel client manages keys securely; ChatGPT receives no direct token.'
      }
    ],
    width
  )
  gap()

  card(
    appleBlue(bold('⌘ STEP-BY-STEP SETUP IN CHATGPT')),
    'WALKTHROUGH',
    [
      `${appleCyan(bold('[ 1 ]'))} ${textWhite('Open')} ${underline('chatgpt.com')} ${textWhite('in your browser and sign in')}`,
      `${appleCyan(bold('[ 2 ]'))} ${textWhite('Navigate to')} ${textSecondary('Settings ❯ Security & login ❯ turn on Developer mode')}`,
      `${appleCyan(bold('[ 3 ]'))} ${textWhite('Navigate to')} ${textSecondary('Settings ❯ Connectors (or Plugins) ❯ "Add custom MCP server"')}`,
      `${appleCyan(bold('[ 4 ]'))} ${textWhite('Paste the 5 values above, click Save, then click "Refresh tools" in connector details')}`,
      `${appleCyan(bold('[ 5 ]'))} ${textWhite('Open a new chat, pick "Chat Unleashed" from (+), and ask it to do something local!')}`
    ],
    width
  )
  gap()

  line(`  ${appleBlue('✦')} ${textSecondary('OpenAI Tunnels:   ')} ${underline(TUNNELS_URL)}`)
  line(`  ${appleBlue('✦')} ${textSecondary('OpenAI API Keys:  ')} ${underline(KEYS_URL)}`)
  line(`  ${appleBlue('✦')} ${textSecondary('ChatGPT Settings: ')} ${underline(CONNECTORS_URL)}`)
}

async function connectCommand() {
  const state = await withSpinner('Checking tunnel readiness', collectState)
  if (!state.profile.exists || !state.profile.tunnelId || !state.key.present) {
    renderBanner()
    card(
      appleOrange(bold('TUNNEL NOT YET CONFIGURED')),
      'SETUP REQUIRED',
      [
        textSecondary('The tunnel profile or API credentials are not set up on this machine.'),
        '',
        `Run: ${codeSnippet('chat-unleashed setup')}`
      ],
      columns(),
      borderWarn
    )
    gap()
    return 1
  }
  if (flags.has('--open')) {
    for (const url of [TUNNELS_URL, KEYS_URL, CONNECTORS_URL]) {
      spawnSync('open', [url], { timeout: 5000 })
    }
    line(`  ${appleGreen('✓')} ${textSecondary('Opened tunnel, key and connector pages in your default browser.')}`)
  }
  renderBanner()
  line(`  ${state.tunnel.ready ? appleGreen('●') : appleRed('✗')} ${textWhite('TUNNEL STATUS:')} ${state.tunnel.ready ? appleGreen(bold('ONLINE & READY')) : appleRed(bold(`OFFLINE (${trimTo(state.tunnel.body, 30)})`))}`)
  gap()
  connectorGuide(state)
  gap()
  return state.tunnel.ready ? 0 : 1
}

// ============================================================================
// Doctor Screen (Diagnostic Test Suites & Scorecard)
// ============================================================================
function checkList(state) {
  const checks = []
  const add = (title, status, detail, remedy) => checks.push({ title, status, detail, remedy })

  add('macOS Version', 'ok', `${state.platform.macOS || 'unknown'} (${state.platform.arch})`, null)
  add('Node.js Runtime', 'ok', state.platform.node, null)

  add(
    'tunnel-client CLI',
    state.client.installed ? 'ok' : 'bad',
    state.client.installed ? `${state.client.version || 'unknown'} at ${displayPath(state.client.path)}` : 'Not found on PATH.',
    state.client.installed ? null : 'brew install openai/tools/tunnel-client'
  )

  add(
    'Tunnel Profile',
    state.profile.exists ? 'ok' : 'bad',
    state.profile.exists ? displayPath(state.profile.path) : `${PROFILE}.yaml does not exist.`,
    state.profile.exists ? null : 'chat-unleashed setup'
  )

  add(
    'Runtime API Key',
    state.key.present ? 'ok' : 'bad',
    state.key.present ? `Loaded from ${state.key.source}.` : 'The profile references a variable that is not set.',
    state.key.present ? null : 'chat-unleashed setup'
  )

  add(
    'Tunnel ID',
    state.profile.tunnelId ? 'ok' : 'bad',
    state.profile.tunnelId ? maskId(state.profile.tunnelId) : 'No tunnel_id found in profile.',
    state.profile.tunnelId ? null : 'chat-unleashed setup'
  )

  const serverJob = state.jobs.server
  add(
    'MCP Server Daemon',
    serverJob?.loaded ? 'ok' : 'warn',
    serverJob?.loaded ? `${serverJob.label} (${serverJob.running ? `running PID ${serverJob.pid}` : 'loaded, idle'})` : 'No launchd job found.',
    serverJob?.loaded ? null : 'chat-unleashed setup'
  )

  const tunnelJob = state.jobs.tunnel
  add(
    'Tunnel Daemon',
    tunnelJob?.loaded ? 'ok' : 'warn',
    tunnelJob?.loaded ? `${tunnelJob.label} (${tunnelJob.running ? `running PID ${tunnelJob.pid}` : 'loaded, idle'})` : 'No launchd job found.',
    tunnelJob?.loaded ? null : 'chat-unleashed setup'
  )

  add(
    'MCP Server Handshake',
    state.server.healthy ? 'ok' : 'bad',
    state.server.healthy
      ? `${state.server.tools ?? '?'} tools responsive at ${state.server.url}`
      : `${state.server.healthOk ? 'Responds to /health, but MCP handshake timed out' : 'No response'} at ${state.server.url}.`,
    state.server.healthy ? null : 'chat-unleashed restart'
  )

  add(
    'Tunnel Readiness Probe',
    state.tunnel.ready ? 'ok' : 'bad',
    state.tunnel.ready ? `Ready at ${state.tunnel.url}/readyz` : `Answers "${trimTo(state.tunnel.body, 40)}" at ${state.tunnel.url}/readyz.`,
    state.tunnel.ready ? null : 'chat-unleashed restart'
  )

  return checks
}

async function doctor() {
  const state = await withSpinner('Executing diagnostic test suites', collectState)
  if (WANTS_JSON) {
    const checks = checkList(state)
    process.stdout.write(JSON.stringify({ ok: checks.every((c) => c.status !== 'bad'), checks }, null, 2) + '\n')
    return checks.some((check) => check.status === 'bad') ? 1 : 0
  }

  const checks = checkList(state)
  const width = columns()
  renderBanner()

  const groups = [
    { title: appleCyan(bold(' THIS MAC')), keys: ['macOS Version', 'Node.js Runtime', 'tunnel-client CLI'] },
    { title: appleIndigo(bold('✦ CONFIGURATION & CREDENTIALS')), keys: ['Tunnel Profile', 'Runtime API Key', 'Tunnel ID'] },
    { title: appleMint(bold('⚡ SERVICES & HANDSHAKES')), keys: ['MCP Server Daemon', 'Tunnel Daemon', 'MCP Server Handshake', 'Tunnel Readiness Probe'] }
  ]

  for (const g of groups) {
    const rows = []
    for (const key of g.keys) {
      const c = checks.find((entry) => entry.title === key)
      if (!c) continue
      const mark = c.status === 'ok' ? appleGreen('✓ PASS') : c.status === 'warn' ? appleOrange('! WARN') : appleRed('✗ FAIL')
      const left = `${textSecondary(padEnd(key, 24))}${textWhite(trimTo(c.detail, width - 36))}`
      const pad = width - 4 - vlen(left) - vlen(mark)
      rows.push(left + ' '.repeat(Math.max(2, pad)) + mark)
      if (c.remedy) {
        rows.push(`  ${textSecondary('↳ Fix: ')}${codeSnippet(c.remedy)}`)
      }
    }
    card(g.title, null, rows, width)
    gap()
  }

  const passed = checks.filter((c) => c.status === 'ok').length
  const warned = checks.filter((c) => c.status === 'warn').length
  const failed = checks.filter((c) => c.status === 'bad').length

  const allGood = failed === 0
  const summaryBadge = allGood ? appleGreen('HEALTHY') : appleRed('ISSUES DETECTED')
  const summaryRows = [
    `${appleGreen('●')} ${textWhite(`${passed} Passed`)}  ${warned ? `${appleOrange('▲')} ${textWhite(`${warned} Optional / Notice`)}  ` : ''}${failed ? `${appleRed('✗')} ${textWhite(`${failed} Need Attention`)}` : ''}`
  ]

  if (!allGood) {
    const firstFail = checks.find((c) => c.status === 'bad')
    if (firstFail?.remedy) {
      summaryRows.push('')
      summaryRows.push(`${textSecondary('Primary recommendation:')}`)
      summaryRows.push(`  ${codeSnippet(firstFail.remedy)}`)
    }
  } else {
    summaryRows.push(`${textSecondary('All systems and daemons are communicating properly with OpenAI.')}`)
  }

  card(
    allGood ? appleGreen(bold('◈ DIAGNOSTIC SUMMARY')) : appleRed(bold('◈ DIAGNOSTIC SUMMARY')),
    summaryBadge,
    summaryRows,
    width,
    allGood ? borderSlate : borderWarn
  )
  gap()

  return failed > 0 ? 1 : 0
}

// ============================================================================
// Service Plists & Lifecycle
// ============================================================================
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
    const entry = state.dist.exists ? state.dist.path : (existsSync(join(PKG_ROOT, 'dist/index.js')) ? join(PKG_ROOT, 'dist/index.js') : null)
    if (!entry) return { created, error: 'The MCP server is not built yet (run npm run build first).' }
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

async function bringUp(jobs, profile, onStep) {
  if (jobs.server) {
    kickJob(jobs.server)
    await onStep('Waiting for MCP server to answer', () =>
      waitUntil(async () => (await probeMcp(profile.mcpUrl)).ok, 60000))
  }
  if (!jobs.tunnel) return
  const ready = () => waitUntil(async () => {
    const probe = await getText(`${profile.healthBase}/readyz`, 4000)
    return probe.ok && probe.text === 'ready'
  }, 45000)
  kickJob(jobs.tunnel)
  if (await onStep('Waiting for tunnel to connect', ready)) return
  kickJob(jobs.tunnel)
  await onStep('Waiting for tunnel, retry attempt', ready)
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
    const label = `  ${appleBlue('❯')} ${textWhite(question)}${fallback ? ` ${textTertiary(`(${fallback})`)}` : ''}: `
    rl.question(label, (answer) => {
      rl.close()
      const value = answer.trim() || fallback
      if (validate) {
        const problem = validate(value)
        if (problem) {
          line(`  ${appleOrange('▲')} ${textSecondary(problem)}`)
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
    process.stdout.write(`  ${appleBlue('❯')} ${textWhite(question)}: `)
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

// ============================================================================
// Setup Command (Interactive & Clear Progression)
// ============================================================================
async function setup() {
  const dryRun = flags.has('--check')
  const assumeYes = flags.has('--yes')
  const width = columns()
  renderBanner()

  line(`  ${appleBlue(bold('⚙ GUIDED ONBOARDING SETUP'))}`)
  line(`  ${textSecondary('Sets up local tunnel, builds executable, and creates launchd daemons.')}`)
  if (dryRun) line(`  ${appleOrange(bold('[ DRY RUN: NO CHANGES WILL BE WRITTEN ]'))}`)
  gap()

  const state = await withSpinner('Inspecting current system state', collectState)
  const checklist = [
    { name: 'tunnel-client CLI', ok: state.client.installed, detail: state.client.installed ? state.client.version : 'needs Homebrew install' },
    { name: 'Tunnel Profile', ok: state.profile.exists, detail: state.profile.exists ? displayPath(state.profile.path) : 'will be created' },
    { name: 'Tunnel ID', ok: Boolean(state.profile.tunnelId), detail: state.profile.tunnelId ? maskId(state.profile.tunnelId) : 'required from OpenAI' },
    { name: 'Runtime API Key', ok: state.key.present, detail: state.key.present ? `loaded from ${state.key.source}` : 'required from OpenAI' },
    { name: 'MCP Server Bundle', ok: state.dist.exists, detail: state.dist.exists ? displayPath(state.dist.path) : 'will be compiled' },
    { name: 'Launchd Daemons', ok: Boolean(state.server.healthy && state.tunnel.ready), detail: state.server.healthy && state.tunnel.ready ? 'both running' : 'will be configured' }
  ]

  const rows = checklist.map((item, idx) => {
    const mark = item.ok ? appleGreen('✓ OK') : appleOrange('▲ PENDING')
    const num = appleCyan(bold(`[${idx + 1}/6]`))
    const left = `${num} ${textSecondary(padEnd(item.name, 22))}${textWhite(trimTo(item.detail, width - 42))}`
    const pad = width - 4 - vlen(left) - vlen(mark)
    return left + ' '.repeat(Math.max(2, pad)) + mark
  })

  card(appleCyan(bold('📋 SETUP CHECKLIST')), dryRun ? 'INSPECTION' : 'PROGRESS', rows, width)
  gap()

  const needed = checklist.filter((entry) => !entry.ok).length
  if (needed === 0) {
    line(`  ${appleGreen('●')} ${textWhite('Everything is already configured and answering!')}`)
    gap()
    connectorGuide(state)
    gap()
    return 0
  }

  if (dryRun) {
    line(`  ${appleOrange('▲')} ${textWhite(`${needed} step${needed > 1 ? 's' : ''} require changes on this Mac.`)}`)
    line(`  ${textSecondary('Run without --check to execute the setup steps interactively.')}`)
    gap()
    return 0
  }

  // 1. tunnel-client check
  if (!state.client.installed) {
    const consent = assumeYes || await ask('Install tunnel-client with Homebrew now? (y/n)', {
      fallback: 'y',
      validate: (v) => (/^[yn]/i.test(v) ? null : 'Answer y or n.')
    })
    if (!/^y/i.test(consent)) {
      line(`  ${appleOrange('▲')} ${textSecondary('Skipped. Install manually: brew install openai/tools/tunnel-client')}`)
      return 1
    }
    const result = spawnSync('brew', ['install', 'openai/tools/tunnel-client'], {
      stdio: 'inherit',
      timeout: 300000
    })
    if (result.status !== 0) {
      line(`  ${appleRed('✗')} ${textSecondary('Homebrew install did not succeed. Please install tunnel-client and re-run setup.')}`)
      return 1
    }
  }

  // 2. Tunnel ID
  let tunnelId = state.profile.tunnelId
  if (!tunnelId) {
    card(
      appleBlue(bold('OPENAI TUNNEL ID REQUIRED')),
      'STEP 2/6',
      [
        textSecondary('Create a tunnel at platform.openai.com/settings/organization/tunnels'),
        textSecondary('and paste the generated ID (starts with tunnel_):')
      ],
      width
    )
    if (!process.stdin.isTTY) {
      line(`  ${appleRed('✗')} ${textSecondary('No interactive terminal. Create the tunnel and run setup in a terminal.')}`)
      return 1
    }
    tunnelId = await ask('Tunnel ID', {
      validate: (value) => (TUNNEL_ID_RE.test(value) ? null : tunnelIdProblem(value))
    })
    gap()
  }

  // 3. Runtime API Key
  if (!state.key.present) {
    card(
      appleBlue(bold('OPENAI RUNTIME API KEY REQUIRED')),
      'STEP 3/6',
      [
        textSecondary('Create an API key with "Tunnels Read and Use" permissions at:'),
        underline(KEYS_URL),
        '',
        textSecondary('Input is masked and stored securely in .env.tunnel (mode 0600).')
      ],
      width
    )
    if (!process.stdin.isTTY) {
      line(`  ${appleRed('✗')} ${textSecondary('No interactive terminal. Export CONTROL_PLANE_API_KEY and re-run setup.')}`)
      return 1
    }
    const entered = sanitizeKey(await askSecret('Runtime API Key'))
    if (entered.problem) {
      line(`  ${appleRed('✗')} ${textSecondary(entered.problem)}`)
      return 1
    }
    writeKeyToEnvFile(entered.key)
    line(`  ${appleGreen('✓')} ${textSecondary('API key stored securely in .env.tunnel.')}`)
    gap()
  } else if (state.key.source.includes('environment') && !existsSync(ENV_FILE)) {
    writeKeyToEnvFile(process.env.CONTROL_PLANE_API_KEY)
    line(`  ${appleGreen('✓')} ${textSecondary('Synchronized key from environment into .env.tunnel.')}`)
  }

  // 4. Tunnel Profile
  const profilePath = join(CLIENT_CONFIG, `${PROFILE}.yaml`)
  const wrongTarget = state.profile.exists && state.profile.serverUrl !== MCP_URL_FALLBACK
  if (!state.profile.exists || wrongTarget) {
    const result = ensureProfile(tunnelId)
    if (!result.ok) {
      line(`  ${appleRed('✗')} ${textSecondary('Failed to initialize tunnel profile.')}`)
      return 1
    }
    line(`  ${appleGreen('✓')} ${textSecondary(`Configured tunnel profile at ${displayPath(profilePath)}.`)}`)
  } else if (!state.profile.tunnelId && tunnelId) {
    writeTunnelIdToProfile(profilePath, tunnelId)
    line(`  ${appleGreen('✓')} ${textSecondary('Updated tunnel ID in existing profile.')}`)
  }

  // 5. Server build
  if (!state.dist.exists) {
    line(`  ${appleCyan('●')} ${textSecondary('Building and deploying server runtime bundle...')}`)
    const repo = PKG_ROOT
    if (!existsSync(join(repo, 'package.json'))) {
      line(`  ${appleRed('✗')} ${textSecondary('Package root not found to build server.')}`)
      return 1
    }
    const build = spawnSync('npm', ['run', 'build'], { cwd: repo, stdio: 'inherit', timeout: 300000 })
    if (build.status !== 0) {
      line(`  ${appleRed('✗')} ${textSecondary('Build failed. Check errors above and try again.')}`)
      return 1
    }
    spawnSync('node', [join(repo, 'scripts/deploy-local.mjs')], { cwd: repo, stdio: 'inherit', timeout: 120000 })
    line(`  ${appleGreen('✓')} ${textSecondary('Server bundle compiled and deployed.')}`)
  }

  // 6. Services & Launchd
  line(`  ${appleCyan('●')} ${textSecondary('Configuring launchd background services...')}`)
  const current = await collectState()
  const jobs = ensureJobs(current)
  for (const path of jobs.created) line(`  ${appleGreen('✓')} ${textSecondary(`Created ${displayPath(path)}`)}`)
  if (jobs.error) {
    line(`  ${appleRed('✗')} ${textSecondary(jobs.error)}`)
    return 1
  }

  const fresh = await collectState()
  await bringUp(fresh.jobs, fresh.profile, withSpinner)

  const final = await collectState()
  gap()
  if (!final.server.healthy || !final.tunnel.ready) {
    card(
      appleRed(bold('SETUP INCOMPLETE')),
      'SERVICES UNRESPONSIVE',
      [
        textSecondary(`Server status: ${final.server.healthy ? 'answering' : 'offline'}`),
        textSecondary(`Tunnel status: ${final.tunnel.ready ? 'connected' : trimTo(final.tunnel.body, 40)}`),
        '',
        `Run ${codeSnippet('chat-unleashed doctor')} to inspect the failing component.`
      ],
      width,
      borderWarn
    )
    return 1
  }

  card(
    appleGreen(bold('SETUP COMPLETE & SERVICES RUNNING!')),
    'ONLINE',
    [
      `${textSecondary('MCP Server: ')}${appleGreen(`${final.server.tools ?? '?'} tools online`)} ${textSecondary(`at ${hostOf(final.server.url)}`)}`,
      `${textSecondary('OpenAI Tunnel: ')}${appleGreen('Ready & connected')}`
    ],
    width
  )
  gap()
  connectorGuide(final)
  gap()
  return 0
}

function stopServices(state) {
  for (const job of [state.jobs.server, state.jobs.tunnel]) {
    if (!job) continue
    spawnSync('launchctl', ['bootout', `gui/${UID}/${job.label}`], { encoding: 'utf8', timeout: 5000 })
    line(`  ${appleOrange('●')} ${textSecondary(`Stopped service ${job.label}`)}`)
  }
}

async function startCommand(restart) {
  renderBanner()
  line(`  ${appleBlue(bold(restart ? 'RESTARTING SERVICES' : 'STARTING SERVICES'))}`)
  gap()
  let state = await collectState()
  if (restart) {
    stopServices(state)
    await new Promise((resolve) => setTimeout(resolve, 900))
    state = await collectState()
  }
  const jobs = ensureJobs(state)
  for (const path of jobs.created) line(`  ${appleGreen('✓')} ${textSecondary(`Wrote ${displayPath(path)}`)}`)
  if (jobs.error) {
    line(`  ${appleRed('✗')} ${textSecondary(jobs.error)}`)
    return 1
  }
  state = await collectState()
  await bringUp(state.jobs, state.profile, withSpinner)
  const final = await collectState()
  gap()
  if (!final.server.healthy || !final.tunnel.ready) {
    card(
      appleRed(bold('STARTUP FAILED')),
      'OFFLINE',
      [
        `${textSecondary('Server: ')}${final.server.healthy ? appleGreen('online') : appleRed('no answer')}`,
        `${textSecondary('Tunnel: ')}${final.tunnel.ready ? appleGreen('ready') : appleRed(trimTo(final.tunnel.body, 30))}`,
        '',
        `Run ${codeSnippet('chat-unleashed logs tunnel')} to inspect daemon logs.`
      ],
      columns(),
      borderWarn
    )
    return 1
  }
  card(
    appleGreen(bold('ALL SERVICES STARTED')),
    'ONLINE',
    [
      `${textSecondary('MCP Server: ')}${appleGreen(`${final.server.tools ?? '?'} tools online`)} ${textSecondary(`(${hostOf(final.server.url)})`)}`,
      `${textSecondary('OpenAI Tunnel: ')}${appleGreen('Ready & connected')}`
    ],
    columns()
  )
  gap()
  return 0
}

function showLogs(which) {
  renderBanner()
  const logs = {
    server: join(LOG_DIR, 'server-http.log'),
    tunnel: join(LOG_DIR, 'tunnel-daemon.log'),
    launchd: join(LOG_DIR, 'tunnel-launchd.log')
  }
  const path = logs[which] || logs.server
  if (!existsSync(path)) {
    line(`  ${appleOrange('▲')} ${textSecondary(`No log file at ${displayPath(path)} yet.`)}`)
    return 1
  }
  line(`  ${appleCyan(bold('STREAMING LOG:'))} ${textWhite(displayPath(path))} ${textSecondary('(Press Control-C to exit)')}`)
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
        version: DISPLAY_VERSION,
        client: state.client.version,
        profile: state.profile.name,
        tunnelId: state.profile.tunnelId,
        server: { url: state.server.url, healthy: state.server.healthy, tools: state.server.tools },
        tunnel: { url: state.tunnel.url, ready: state.tunnel.ready, body: state.tunnel.body },
        next: next.command
      }, null, 2) + '\n')
      return state.server.healthy && state.tunnel.ready ? 0 : 1
    }
    const mark = state.server.healthy && state.tunnel.ready ? appleGreen('●') : appleRed('✗')
    const parts = [
      `server ${state.server.healthy ? appleGreen(`${state.server.tools ?? '?'} tools`) : appleRed('down')}`,
      `tunnel ${state.tunnel.ready ? appleGreen('ready') : appleRed('down')}`
    ]
    line(`${mark} ${textWhite(parts.join(` ${textTertiary('·')} `))}`)
    return state.server.healthy && state.tunnel.ready ? 0 : 1
  })
}

// ============================================================================
// Help / Command Palette Screen
// ============================================================================
// ============================================================================
// Update Command (Pull upstream, Recompile, Deploy & Restart)
// ============================================================================
async function updateCommand() {
  const isCheckOnly = flags.has('--check')
  const isForce = flags.has('--force')
  const isStage = flags.has('--stage')
  const isStatus = flags.has('--status')
  const isCancel = flags.has('--cancel')
  const width = columns()

  renderBanner()

  // Deferred update sub-actions
  if (isStatus) {
    const res = spawnSync(process.execPath, [join(PKG_ROOT, 'scripts/deferred-update.mjs'), 'status'], {
      encoding: 'utf8',
      cwd: PKG_ROOT,
      timeout: 10000
    })
    const output = (res.stdout || res.stderr || '').trim()
    card(appleCyan(bold('DEFERRED UPDATE STATUS')), 'STAGE', [
      output || 'No deferred update currently pending.'
    ], width)
    gap()
    return res.status === 0 ? 0 : 1
  }

  if (isCancel) {
    const res = spawnSync(process.execPath, [join(PKG_ROOT, 'scripts/deferred-update.mjs'), 'cancel'], {
      encoding: 'utf8',
      cwd: PKG_ROOT,
      timeout: 10000
    })
    const output = (res.stdout || res.stderr || '').trim()
    card(appleOrange(bold('DEFERRED UPDATE CANCELLED')), 'CANCEL', [
      output || 'Cancelled any pending deferred update.'
    ], width)
    gap()
    return 0
  }

  if (isStage) {
    line(`  ${appleCyan('●')} ${textSecondary('Compiling and staging candidate bundle for deferred update...')}`)
    const build = spawnSync('npm', ['run', 'build'], { cwd: PKG_ROOT, stdio: 'inherit', timeout: 300000 })
    if (build.status !== 0) {
      line(`  ${appleRed('✗')} ${textSecondary('Build failed. Fix errors above before staging.')}`)
      return 1
    }
    const res = spawnSync(process.execPath, [join(PKG_ROOT, 'scripts/deferred-update.mjs'), 'stage'], {
      encoding: 'utf8',
      cwd: PKG_ROOT,
      timeout: 15000
    })
    const output = (res.stdout || res.stderr || '').trim()
    card(appleGreen(bold('UPDATE STAGED (DEFERRED)')), 'STAGED', [
      textSecondary(output || 'Bundle staged. Will automatically switch after 20 minutes of no tool activity.'),
      '',
      `Check status with: ${codeSnippet('chat-unleashed update --status')}`
    ], width)
    gap()
    return res.status === 0 ? 0 : 1
  }

  // Standard git-based update
  const isGit = existsSync(join(PKG_ROOT, '.git'))
  if (!isGit) {
    card(appleOrange(bold('GIT REPOSITORY NOT FOUND')), 'MANUAL UPDATE', [
      textSecondary('This installation was not cloned from a git repository.'),
      '',
      `To update manually, run: ${codeSnippet('npm install -g local-agent-mcp@latest')}`
    ], width, borderWarn)
    gap()
    return 1
  }

  line(`  ${appleBlue(bold('✦ CHECKING FOR UPDATES'))}`)
  await withSpinner('Fetching latest commits from GitHub', () => {
    spawnSync('git', ['fetch', 'origin', 'main', '--quiet'], { cwd: PKG_ROOT, encoding: 'utf8', timeout: 20000 })
  })

  const head = (spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: PKG_ROOT, encoding: 'utf8' }).stdout || '').trim()
  const remote = (spawnSync('git', ['rev-parse', '--short', 'origin/main'], { cwd: PKG_ROOT, encoding: 'utf8' }).stdout || '').trim()
  const behindCount = parseInt((spawnSync('git', ['rev-list', '--count', 'HEAD..origin/main'], { cwd: PKG_ROOT, encoding: 'utf8' }).stdout || '0').trim(), 10) || 0

  if (isCheckOnly) {
    if (behindCount === 0) {
      card(appleGreen(bold('✦ CHAT UNLEASHED IS UP TO DATE')), 'LATEST', [
        `${textSecondary('Active Version:  ')}${textWhite(DISPLAY_VERSION)}`,
        `${textSecondary('Current Commit:  ')}${textWhite(head)}`,
        `${textSecondary('Remote Status:   ')}${appleGreen('Synchronized with origin/main')}`,
        '',
        textSecondary('No new commits found upstream.')
      ], width)
    } else {
      const commitLog = (spawnSync('git', ['log', 'HEAD..origin/main', '--pretty=format:  • %h %s (%cr)', '-n', '5'], { cwd: PKG_ROOT, encoding: 'utf8' }).stdout || '').trim()
      card(appleCyan(bold('✦ UPDATE AVAILABLE')), `${behindCount} NEW`, [
        `${textSecondary('Active Version:  ')}${textWhite(DISPLAY_VERSION)}`,
        `${textSecondary('Current Commit:  ')}${textWhite(head)}`,
        `${textSecondary('Remote Commit:   ')}${appleGreen(remote)} (${behindCount} commit${behindCount > 1 ? 's' : ''} behind)`,
        '',
        textWhite('Incoming Changes:'),
        commitLog,
        '',
        `Execute: ${codeSnippet('chat-unleashed update')}`
      ], width, borderActive)
    }
    gap()
    return 0
  }

  if (behindCount === 0 && !isForce) {
    card(appleGreen(bold('✦ CHAT UNLEASHED IS UP TO DATE')), 'LATEST', [
      `${textSecondary('Active Version:  ')}${textWhite(DISPLAY_VERSION)}`,
      `${textSecondary('Current Commit:  ')}${textWhite(head)}`,
      `${textSecondary('Remote Status:   ')}${appleGreen('Synchronized with origin/main')}`,
      '',
      textSecondary('You are already running the latest version.'),
      `To force a rebuild and service redeployment, run: ${codeSnippet('chat-unleashed update --force')}`
    ], width)
    gap()
    return 0
  }

  // Execute update
  line(`  ${appleBlue(bold('⚙ EXECUTING CHAT UNLEASHED UPDATE'))}`)
  gap()

  // Step 1: Pull commits
  if (behindCount > 0) {
    line(`  ${appleCyan('[ 1/5 ]')} ${textSecondary('Pulling latest commits from origin/main...')}`)
    const pull = spawnSync('git', ['pull', 'origin', 'main'], { cwd: PKG_ROOT, stdio: 'inherit', timeout: 30000 })
    if (pull.status !== 0) {
      line(`  ${appleRed('✗')} ${textSecondary('git pull failed. Resolve merge conflicts before updating.')}`)
      return 1
    }
  } else {
    line(`  ${appleCyan('[ 1/5 ]')} ${textSecondary(`Already at latest commit (${head}), continuing with force rebuild...`)}`)
  }

  // Step 2: npm install
  line(`  ${appleCyan('[ 2/5 ]')} ${textSecondary('Updating npm dependencies...')}`)
  const install = spawnSync('npm', ['install', '--prefer-offline'], { cwd: PKG_ROOT, stdio: 'inherit', timeout: 120000 })
  if (install.status !== 0) {
    line(`  ${appleRed('✗')} ${textSecondary('npm install failed. Fix dependency issues and re-run update.')}`)
    return 1
  }

  // Step 3: compile bundle
  line(`  ${appleCyan('[ 3/5 ]')} ${textSecondary('Compiling TypeScript & bundling standalone executable...')}`)
  const build = spawnSync('npm', ['run', 'build'], { cwd: PKG_ROOT, stdio: 'inherit', timeout: 300000 })
  if (build.status !== 0) {
    line(`  ${appleRed('✗')} ${textSecondary('Build failed. Fix build errors and re-run update.')}`)
    return 1
  }

  // Step 4: deploy
  line(`  ${appleCyan('[ 4/5 ]')} ${textSecondary('Deploying runtime to ~/.local/share/local-agent-mcp...')}`)
  const deploy = spawnSync(process.execPath, [join(PKG_ROOT, 'scripts/deploy-local.mjs')], { cwd: PKG_ROOT, stdio: 'inherit', timeout: 60000 })
  if (deploy.status !== 0) {
    line(`  ${appleRed('✗')} ${textSecondary('Local deployment failed.')}`)
    return 1
  }

  // Step 5: restart & verify
  line(`  ${appleCyan('[ 5/5 ]')} ${textSecondary('Restarting background daemons and verifying health...')}`)
  const currentState = await collectState()
  stopServices(currentState)
  await new Promise((resolve) => setTimeout(resolve, 800))
  const fresh = await collectState()
  ensureJobs(fresh)
  await bringUp(fresh.jobs, fresh.profile, withSpinner)

  const final = await collectState()
  const newHead = (spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: PKG_ROOT, encoding: 'utf8' }).stdout || '').trim()
  gap()

  if (final.server.healthy && final.tunnel.ready) {
    card(appleGreen(bold(' UPDATE COMPLETE & SERVICES ONLINE')), 'SUCCESS', [
      `${textSecondary('Active Version:   ')}${textWhite(DISPLAY_VERSION)}`,
      `${textSecondary('Deployed Commit:  ')}${textWhite(newHead)}`,
      `${textSecondary('MCP Server:       ')}${appleGreen(`${final.server.tools ?? '?'} tools online`)} ${textSecondary(`at ${hostOf(final.server.url)}`)}`,
      `${textSecondary('OpenAI Tunnel:    ')}${appleGreen('Connected & ready')}`
    ], width)
  } else {
    card(appleOrange(bold('UPDATE DEPLOYED (CHECK SERVICES)')), 'ATTENTION', [
      `${textSecondary('Deployed Commit:  ')}${textWhite(newHead)}`,
      `${textSecondary('Server status:    ')}${final.server.healthy ? appleGreen('online') : appleRed('offline')}`,
      `${textSecondary('Tunnel status:    ')}${final.tunnel.ready ? appleGreen('ready') : appleRed(trimTo(final.tunnel.body, 30))}`,
      '',
      `Run ${codeSnippet('chat-unleashed doctor')} to inspect the service status.`
    ], width, borderWarn)
  }
  gap()
  return 0
}

function help() {
  const width = columns()
  renderBanner()

  card(
    appleCyan(bold('⌘ COMMAND PALETTE')),
    'OVERVIEW',
    [
      textSecondary('Usage: chat-unleashed [command] [options]'),
      '',
      textWhite('CORE WORKFLOWS:'),
      `  ${appleBlue(padEnd('setup', 18))}${textSecondary('Interactive setup wizard (client, profile, key, jobs)')}`,
      `  ${appleBlue(padEnd('connect', 18))}${textSecondary('Display exact form values to paste into ChatGPT')}`,
      `  ${appleBlue(padEnd('doctor', 18))}${textSecondary('Run complete diagnostic health checks on all systems')}`,
      `  ${appleBlue(padEnd('update', 18))}${textSecondary('Check for updates, pull changes, recompile & restart')}`,
      `  ${appleBlue(padEnd('(none)', 18))}${textSecondary('Open the visual dashboard and status summary')}`,
      '',
      textWhite('SERVICE MANAGEMENT:'),
      `  ${appleBlue(padEnd('start', 18))}${textSecondary('Load and start MCP server and tunnel launchd jobs')}`,
      `  ${appleBlue(padEnd('stop', 18))}${textSecondary('Safely shut down background daemons')}`,
      `  ${appleBlue(padEnd('restart', 18))}${textSecondary('Restart both services and verify readiness')}`,
      `  ${appleBlue(padEnd('status', 18))}${textSecondary('One-line summary status (JSON with --json)')}`,
      `  ${appleBlue(padEnd('logs [target]', 18))}${textSecondary('Stream live logs: server, tunnel, or launchd')}`
    ],
    width
  )
  gap()

  card(
    appleIndigo(bold('⚙ FLAGS & OPTIONS')),
    'REFERENCE',
    [
      `  ${textWhite(padEnd('--profile <name>', 20))}${textSecondary('Select tunnel profile (default: local-mac)')}`,
      `  ${textWhite(padEnd('--json', 20))}${textSecondary('Format output as machine-readable JSON')}`,
      `  ${textWhite(padEnd('--check', 20))}${textSecondary('Check for updates or dry-run setup without changes')}`,
      `  ${textWhite(padEnd('--force', 20))}${textSecondary('With update: force rebuild, redeploy and restart')}`,
      `  ${textWhite(padEnd('--stage', 20))}${textSecondary('With update: stage bundle for deferred quiet update')}`,
      `  ${textWhite(padEnd('--yes', 20))}${textSecondary('Automatically accept prompts in setup')}`,
      `  ${textWhite(padEnd('--no-color', 20))}${textSecondary('Disable ANSI colors and box decorations')}`,
      `  ${textWhite(padEnd('--verbose', 20))}${textSecondary('Display timing and probe diagnostics')}`
    ],
    width
  )
  gap()
}

// ============================================================================
// Main Dispatcher
// ============================================================================
async function main() {
  switch (command) {
    case 'home': {
      const state = await withSpinner('Inspecting system state', collectState)
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
      return showLogs(argv.find((token, index) => index > 0 && !token.startsWith('-') && token !== 'logs')) ?? 0
    case 'version':
    case '--version':
      line(DISPLAY_VERSION)
      return 0
    case 'help':
    case '--help':
    case '-h':
      help()
      return 0
    default:
      renderBanner()
      line(`  ${appleOrange('▲')} ${textWhite(`Unknown command "${command}".`)}`)
      line(`  ${textSecondary('Run chat-unleashed help to view available commands.')}`)
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
