const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const port = Number(process.env.QA_CLIENT_PORT || 39002)
const apiPort = Number(process.env.QA_API_PORT || 39001)
const root = path.resolve(__dirname, '..', 'client', 'dist')
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

http.createServer((request, response) => {
  const requested = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
  if (requested.startsWith('/api/')) {
    const proxy = http.request({
      hostname: '127.0.0.1',
      port: apiPort,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: `127.0.0.1:${apiPort}` },
    }, (upstream) => {
      response.writeHead(upstream.statusCode || 500, upstream.headers)
      upstream.pipe(response)
    })
    proxy.on('error', () => {
      response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: { message: 'خادم QA غير متاح' } }))
    })
    request.pipe(proxy)
    return
  }
  const candidate = path.resolve(root, requested.replace(/^\/+/, ''))
  const safeCandidate = candidate === root || candidate.startsWith(`${root}${path.sep}`)
    ? candidate
    : path.join(root, 'index.html')
  const filePath = safeCandidate !== root && fs.existsSync(safeCandidate) && fs.statSync(safeCandidate).isFile()
    ? safeCandidate
    : path.join(root, 'index.html')
  response.writeHead(200, {
    'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  })
  fs.createReadStream(filePath).pipe(response)
}).listen(port, '127.0.0.1', () => console.log(`QA client listening on http://localhost:${port}`))
