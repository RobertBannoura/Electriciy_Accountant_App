const fs = require('node:fs/promises')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const extracted = path.join(projectRoot, 'tmp', 'qa', 'installer-extracted-v2')
const asar = path.join(projectRoot, 'tmp', 'qa', 'app-asar-v2')
const installer = path.join(projectRoot, 'release', 'installer', 'Electricity-Accountant-Trial-Setup.exe')
const findings = []
const rendererHosts = new Set()
let inspectedFiles = 0

const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/i
const literalSecret = /\b(?:DATABASE_URL|VAPID_PRIVATE_KEY|OAUTH_CLIENT_SECRET|SMTP_PASSWORD|SMTP_SECRET|TLS_PRIVATE_KEY|ADMIN_PASSWORD)\s*[:=]\s*['"]([^'"\r\n]{1,500})['"]/g
const postgresUrl = /postgres(?:ql)?:\/\/([^\s'"`<>]{1,500})/gi
const externalApi = /https?:\/\/([a-z0-9.-]*(?:railway|api\.)[a-z0-9.-]*)/gi
const urlHost = /https?:\/\/([a-z0-9.-]+)/gi
const textExtensions = new Set(['.js', '.cjs', '.mjs', '.json', '.html', '.css', '.sql', '.txt', '.conf', '.sample', '.md', '.yml', '.yaml'])

function report(kind, file) {
  findings.push({ kind, file: path.relative(projectRoot, file) })
}

async function inspect(file, relative) {
  inspectedFiles += 1
  const name = path.basename(file).toLowerCase()
  if (name === '.env' || name.startsWith('.env.') || /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(name) || name === 'id_rsa') {
    report('secret-file-name', file)
  }
  const stat = await fs.stat(file)
  const extension = path.extname(name)
  const isFirstParty = relative.startsWith(`resources${path.sep}trial-server${path.sep}server${path.sep}src${path.sep}`)
    || relative.startsWith(`electron${path.sep}`)
    || relative.startsWith(`client${path.sep}dist${path.sep}`)
  if (stat.size > 20 * 1024 * 1024 || (!textExtensions.has(extension) && !isFirstParty)) return
  const content = await fs.readFile(file, 'utf8')
  if (privateKey.test(content)) report('private-key-block', file)
  if (isFirstParty) {
    if (/railway(?:\.app|\.internal)|\.railway\.app/i.test(content)) report('railway-reference', file)
    for (const match of content.matchAll(postgresUrl)) {
      const authority = match[1].split('/')[0]
      const host = authority.split('@').at(-1)?.split(':')[0]?.toLowerCase()
      if (host && !['127.0.0.1', 'localhost', '[::1]'].includes(host) && !host.includes('${')) {
        report('external-postgres-url', file)
      }
    }
    for (const match of content.matchAll(literalSecret)) {
      const key = match[0].split(/\s*[:=]/)[0]
      const expectedTrialAdmin = key === 'ADMIN_PASSWORD'
        && match[1] === 'admin'
        && relative === path.join('electron', 'trial-runtime.cjs')
      if (!expectedTrialAdmin) report('literal-secret-assignment', file)
    }
    if (externalApi.test(content)) report('external-api-reference', file)
    externalApi.lastIndex = 0
  }
  if (relative.startsWith(`client${path.sep}dist${path.sep}`)) {
    for (const match of content.matchAll(urlHost)) rendererHosts.add(match[1].toLowerCase())
  }
}

async function walk(root, prefix = '') {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    const relative = path.join(prefix, entry.name)
    if (entry.isSymbolicLink()) report('symbolic-link', file)
    else if (entry.isDirectory()) await walk(file, relative)
    else if (entry.isFile()) await inspect(file, relative)
  }
}

async function main() {
  await fs.access(installer)
  await fs.access(path.join(extracted, 'resources', 'windows-x64', 'bin', 'postgres.exe'))
  await fs.access(path.join(asar, 'electron', 'trial-runtime.cjs'))
  await walk(extracted)
  await walk(asar)
  const binary = await fs.readFile(installer)
  if (privateKey.test(binary.toString('latin1'))) report('private-key-block-in-installer', installer)
  if (/railway(?:\.app|\.internal)/i.test(binary.toString('latin1'))) report('railway-reference-in-installer', installer)
  console.log(JSON.stringify({ inspectedFiles, rendererHosts: [...rendererHosts].sort(), findings }, null, 2))
  if (findings.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('Package scan failed:', error.code ?? error.name)
  process.exitCode = 1
})
