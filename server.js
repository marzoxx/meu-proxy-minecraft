// =====================================================================
//  Minecraft Web Proxy  -  ZERO dependências (só Node.js >= 18)
//  - Serve o site (public/index.html)
//  - Faz de ponte WebSocket <-> TCP para servers de Minecraft Java
//  Protocolo compatível com o cliente "minecraft-web-client" (net-browserify):
//    POST /api/vm/net/connect  -> abre TCP e devolve {remote, token}
//    WS   /api/vm/net/socket?token=...  -> bytes do jogo
//  Extra (modo "wss://" simples): wss://SEU-SITE/ws/host:porta
// =====================================================================
const http = require('http')
const net = require('net')
const dns = require('dns').promises
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const PORT = parseInt(process.env.PORT || '8080', 10)
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''            // opcional: exige ?token=XXX no site
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim())
const MAX_PER_IP = parseInt(process.env.MAX_PER_IP || '8', 10)
const MAX_TOTAL = parseInt(process.env.MAX_TOTAL || '200', 10)
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1'     // deixe desligado (segurança)
const BASE = '/api/vm/net'

const log = (...a) => console.log(new Date().toISOString(), ...a)

// ---------- segurança: bloquear IPs internos (SSRF) ----------
function isPrivateIp (ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  const l = ip.toLowerCase()
  if (l === '::1' || l === '::') return true
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7))
  return l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')
}

const perIp = new Map()
let total = 0
function acquire (ip) {
  if (total >= MAX_TOTAL || (perIp.get(ip) || 0) >= MAX_PER_IP) return false
  perIp.set(ip, (perIp.get(ip) || 0) + 1); total++
  return true
}
function release (ip) {
  const n = (perIp.get(ip) || 1) - 1
  if (n <= 0) perIp.delete(ip); else perIp.set(ip, n)
  total = Math.max(0, total - 1)
}
const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'

// abre TCP com validações; devolve o socket
async function openTcp (host, port) {
  host = String(host || '').trim().replace(/^\[|\]$/g, '')
  const explicitPort = port !== undefined && port !== null && String(port).trim() !== ''
  port = explicitPort ? Number(port) : 25565
  if (!host || host.length > 255 || !Number.isInteger(port) || !(port > 0 && port < 65536)) {
    const e = new Error('host/port inválido'); e.code = 'EINVAL'; throw e
  }

  // Minecraft Java servers may publish a custom port through DNS SRV.
  // Only query SRV when the user did not explicitly specify a port.
  let targets = [{ name: host, port }]
  if (!explicitPort && !net.isIP(host)) {
    try {
      const records = await dns.resolveSrv('_minecraft._tcp.' + host)
      if (records && records.length) {
        records.sort((a, b) => a.priority - b.priority || b.weight - a.weight)
        targets = records.map(r => ({ name: r.name.replace(/\.$/, ''), port: r.port }))
      }
    } catch (_) { /* no SRV record: use host:25565 */ }
  }

  let lastError
  for (const target of targets) {
    let addresses
    try {
      if (net.isIP(target.name)) addresses = [{ address: target.name, family: net.isIP(target.name) }]
      else {
        addresses = await dns.lookup(target.name, { all: true, verbatim: false })
        // Prefer IPv4; some shared hosts cannot make outbound IPv6 connections.
        addresses.sort((a, b) => a.family - b.family)
      }
    } catch (e) { lastError = e; continue }

    for (const r of addresses) {
      if (!ALLOW_PRIVATE && isPrivateIp(r.address)) {
        lastError = Object.assign(new Error('Destino bloqueado (IP interno)'), { code: 'EBLOCKED' })
        continue
      }
      try {
        const s = await new Promise((resolve, reject) => {
          const sock = net.connect({ host: r.address, port: target.port, family: r.family })
          sock.setNoDelay(true)
          sock.setKeepAlive(true, 30000)
          const t = setTimeout(() => {
            sock.destroy()
            reject(Object.assign(new Error('Timeout ao ligar a ' + target.name + ':' + target.port), { code: 'ETIMEDOUT' }))
          }, 12000)
          sock.once('connect', () => { clearTimeout(t); sock.removeAllListeners('error'); resolve(sock) })
          sock.once('error', e => { clearTimeout(t); reject(e) })
        })
        s._minecraftTarget = { host: target.name, port: target.port, address: r.address }
        return s
      } catch (e) { lastError = e }
    }
  }
  throw lastError || Object.assign(new Error('Não foi possível resolver o servidor Minecraft'), { code: 'ENOTFOUND' })
}

// ---------- CORS ----------
function cors (req, res) {
  const origin = req.headers.origin
  const ok = ALLOWED_ORIGINS.includes('*') || (origin && ALLOWED_ORIGINS.includes(origin))
  if (ok) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes('*') ? '*' : origin)
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Max-Age', '86400')
  }
}
const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length })
  res.end(b)
}
function authOk (req) {
  if (!AUTH_TOKEN) return true
  const h = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const q = new URL(req.url, 'http://x').searchParams.get('token')
  return h === AUTH_TOKEN || q === AUTH_TOKEN
}

// ---------- sessões pendentes (POST connect -> WS socket) ----------
const sessions = new Map() // token -> { tcp, ip, chunks, timer }

function dropSession (token) {
  const s = sessions.get(token)
  if (!s) return
  clearTimeout(s.timer); sessions.delete(token)
}

// ---------- mini WebSocket (RFC 6455) ----------
function wsAccept (req, socket) {
  const key = req.headers['sec-websocket-key']
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return false }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
  socket.setNoDelay(true)
  return true
}
function wsFrame (opcode, payload) {
  const len = payload.length
  let head
  if (len < 126) head = Buffer.from([0x80 | opcode, len])
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2) }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2) }
  return Buffer.concat([head, payload])
}
// onMessage(isText, Buffer), onClose()
function wsAttach (socket, onMessage, onClose) {
  let buf = Buffer.alloc(0)
  let fragOp = 0; let frags = []
  let closed = false
  const close = () => { if (closed) return; closed = true; try { socket.destroy() } catch {} ; onClose() }
  socket.on('data', chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0
      const op = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      if (len > 16 * 1024 * 1024) return close()
      if (!masked) return close() // clientes DEVEM mascarar
      if (buf.length < off + 4 + len) return
      const mask = buf.subarray(off, off + 4)
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len))
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3]
      buf = buf.subarray(off + 4 + len)
      if (op === 8) { try { socket.write(wsFrame(8, data.subarray(0, 2))) } catch {} ; return close() }
      if (op === 9) { socket.write(wsFrame(10, data)); continue }
      if (op === 10) continue
      if (op === 1 || op === 2) { fragOp = op; frags = [data] } else if (op === 0) frags.push(data)
      else return close()
      if (fin) {
        const msg = frags.length === 1 ? frags[0] : Buffer.concat(frags)
        frags = []
        try { onMessage(fragOp === 1, msg) } catch (e) { log('erro onMessage', e.message) }
      }
    }
  })
  socket.on('close', close)
  socket.on('error', close)
  return {
    sendBinary: b => socket.write(wsFrame(2, b)),
    sendText: t => socket.write(wsFrame(1, Buffer.from(t))),
    close: () => { try { socket.write(wsFrame(8, Buffer.alloc(0))) } catch {} ; close() },
    socket
  }
}

// liga um WS a um TCP (bytes crus)
function bridge (socket, tcp, ip, label, pending) {
  let released = false; let up = 0; let down = 0; let who = ''
  const t0 = Date.now()
  const done = () => {
    if (released) return
    released = true; release(ip)
    log('close', label, '| quem fechou:', who || '?', '| navegador->server', up + 'B | server->navegador', down + 'B |', ((Date.now() - t0) / 1000).toFixed(1) + 's')
  }
  const ws = wsAttach(socket, (isText, msg) => {
    if (isText) { // "ping:N" -> "pong:N" (usado pelo cliente pra medir ping do proxy)
      const t = msg.toString()
      if (t.startsWith('ping:')) ws.sendText('pong:' + t.slice(5))
      return
    }
    up += msg.length
    if (!tcp.destroyed) { if (tcp.write(msg) === false) { socket.pause(); tcp.once('drain', () => socket.resume()) } }
  }, () => { if (!who) who = 'NAVEGADOR (ou a hospedagem derrubou o WebSocket)'; tcp.destroy(); done() })
  if (pending) for (const c of pending) { down += c.length; ws.sendBinary(c) }
  tcp.on('data', c => { down += c.length; if (ws.sendBinary(c) === false) { tcp.pause(); socket.once('drain', () => tcp.resume()) } })
  tcp.on('close', () => { if (!who) who = 'SERVER DE MINECRAFT'; ws.close(); done() })
  tcp.on('error', e => { if (!who) who = 'SERVER DE MINECRAFT (erro ' + (e.code || e.message) + ')'; ws.close(); done() })
  tcp.setTimeout(0)
  const ka = setInterval(() => { try { socket.write(wsFrame(9, Buffer.alloc(0))) } catch {} }, 25000)
  socket.on('close', () => clearInterval(ka))
}

// ---------- site estático (já comprimido em memória) ----------
const PUBLIC = path.join(__dirname, 'public')
const cache = new Map()
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.txt': 'text/plain' }
function loadFile (rel) {
  if (cache.has(rel)) return cache.get(rel)
  const file = path.join(PUBLIC, rel)
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null
  const raw = fs.readFileSync(file)
  const type = MIME[path.extname(file)] || 'application/octet-stream'
  const gz = /\.(html|js|css|json|svg|txt)$/.test(file) ? zlib.gzipSync(raw, { level: 9 }) : null
  const e = { raw, gz, type }
  cache.set(rel, e); return e
}
function serveStatic (req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (p === '/' || p === '') p = '/index.html'
  const f = loadFile(p.replace(/^\/+/, ''))
  if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404') }
  const useGz = f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')
  const body = useGz ? f.gz : f.raw
  const h = { 'Content-Type': f.type, 'Content-Length': body.length, 'Cache-Control': 'public, max-age=300' }
  if (useGz) h['Content-Encoding'] = 'gzip'
  res.writeHead(200, h); res.end(body)
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  cors(req, res)
  const url = new URL(req.url, 'http://x')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  try {
    if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok') }
    if (url.pathname === '/status') return json(res, 200, {
      status: 'proxy online', active: total,
      tcpOutbound: 'test via POST /api/vm/net/connect with a server host and port',
      features: ['WebSocket bridge', 'IPv4/IPv6 fallback', 'Minecraft SRV lookup']
    })

    if (url.pathname === BASE + '/connect' || url.pathname === BASE + '/connect/') {
      if (req.method === 'GET') return json(res, 200, { ok: true, status: 'proxy online', capabilities: {} })
      if (req.method !== 'POST') return json(res, 405, { error: 'method' })
      if (!authOk(req)) return json(res, 401, { error: 'unauthorized' })
      let body = ''
      for await (const c of req) { body += c; if (body.length > 10000) return json(res, 413, { error: 'too big' }) }
      let o; try { o = JSON.parse(body || '{}') } catch { return json(res, 400, { error: 'bad json' }) }
      const ip = clientIp(req)
      if (!acquire(ip)) return json(res, 429, { error: { code: 'ELIMIT', message: 'Muitas conexões' } })
      let tcp
      try { tcp = await openTcp(o.host || o.hostname, o.port) } catch (e) {
        release(ip)
        log('falhou', o.host, o.port, e.code || e.message)
        if (['ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EACCES', 'EPERM'].includes(e.code)) {
          e.message += ' | A HOSPEDAGEM pode estar a bloquear ligações TCP de saída (ex.: GoDaddy Node.js só deixa sair portas 80/443). Aloja o proxy noutro sítio (Render, Koyeb, VPS).'
        }
        return json(res, 500, { error: { code: e.code || 'ECONNFAILED', message: e.message } })
      }
      const token = crypto.randomBytes(16).toString('hex')
      const s = { tcp, ip, chunks: [], label: `${o.host}:${o.port || 25565}` }
      tcp.on('data', c => s.chunks.push(c))
      const fail = () => { if (sessions.has(token)) { dropSession(token); tcp.destroy(); release(ip) } }
      tcp.on('error', fail); tcp.on('close', fail)
      s.timer = setTimeout(fail, 15000) // WS tem 15s pra conectar
      sessions.set(token, s)
      log('connect', s.label, '->', tcp._minecraftTarget || (tcp.remoteAddress + ':' + tcp.remotePort), 'de', ip)
      return json(res, 200, { remote: { address: tcp.remoteAddress, family: tcp.remoteFamily, port: tcp.remotePort }, token })
    }
    return serveStatic(req, res)
  } catch (e) {
    log('erro http', e.message)
    if (!res.headersSent) json(res, 500, { error: String(e.message) })
  }
})

// ---------- WebSocket upgrade ----------
server.on('upgrade', async (req, socket) => {
  socket.on('error', () => {})
  const url = new URL(req.url, 'http://x')
  const origin = req.headers.origin
  if (!ALLOWED_ORIGINS.includes('*') && origin && !ALLOWED_ORIGINS.includes(origin)) return socket.destroy()

  // modo oficial do cliente
  if (url.pathname === BASE + '/socket') {
    const token = url.searchParams.get('token')
    const s = sessions.get(token)
    if (!s) return socket.destroy()
    dropSession(token)
    s.tcp.removeAllListeners('data'); s.tcp.removeAllListeners('error'); s.tcp.removeAllListeners('close')
    if (!wsAccept(req, socket)) { s.tcp.destroy(); release(s.ip); return }
    return bridge(socket, s.tcp, s.ip, s.label, s.chunks)
  }

  // modo simples: wss://site/ws/host:porta  ou  wss://site/?host=..&port=..
  let host, port
  const m = url.pathname.match(/^\/ws\/([^/:]+)(?::(\d+))?\/?$/)
  if (m) { host = m[1]; port = m[2] } else { host = url.searchParams.get('host'); port = url.searchParams.get('port') }
  if (!host) return socket.destroy()
  if (!authOk(req)) return socket.destroy()
  const ip = clientIp(req)
  if (!acquire(ip)) return socket.destroy()
  let tcp
  try { tcp = await openTcp(host, port) } catch (e) { release(ip); log('falhou(ws)', host, port, e.code || e.message); return socket.destroy() }
  if (!wsAccept(req, socket)) { tcp.destroy(); release(ip); return }
  log('connect(ws)', host + ':' + (port || 25565), 'de', ip)
  bridge(socket, tcp, ip, host + ':' + (port || 25565))
})

server.listen(PORT, '0.0.0.0', () => log('Proxy Minecraft online na porta', PORT))

// ---------- anti-sono do Render (plano Free adormece após 15 min sem tráfego) ----------
// O Render define RENDER_EXTERNAL_URL sozinho. Para desligar: variável KEEP_AWAKE=0
const SELF_URL = process.env.RENDER_EXTERNAL_URL
if (SELF_URL && process.env.KEEP_AWAKE !== '0') {
  setInterval(() => {
    fetch(SELF_URL.replace(/\/$/, '') + '/health').catch(() => {})
  }, 10 * 60 * 1000)
  log('Anti-sono ativo para', SELF_URL)
}
process.on('uncaughtException', e => log('uncaught', e.message))
process.on('unhandledRejection', e => log('unhandled', e && e.message))
