import { spawn } from 'node:child_process'
import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'

function isPrivateIPv4(address) {
  const octets = address.split('.').map(Number)
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
}

function interfaceScore(name, address) {
  let score = isPrivateIPv4(address) ? 100 : 0
  if (/wi-?fi|wlan|ethernet|en\d/i.test(name)) score += 25
  if (/vethernet|virtual|vmware|hyper-v|wsl|docker|tailscale|loopback/i.test(name)) score -= 100
  return score
}

function findLanAddresses() {
  return Object.entries(networkInterfaces())
    .flatMap(([name, entries]) => (entries ?? [])
      .filter((entry) => entry.family === 'IPv4' && !entry.internal)
      .map((entry) => ({ name, address: entry.address })))
    .sort((left, right) => interfaceScore(right.name, right.address) - interfaceScore(left.name, left.address))
}

const requestedAddress = process.env.LAN_HOST?.trim()
if (requestedAddress && !isIPv4(requestedAddress)) {
  console.error('LAN_HOST must be an IPv4 address, for example LAN_HOST=192.168.1.20.')
  process.exit(1)
}

const candidates = findLanAddresses()
const lanAddress = requestedAddress || candidates[0]?.address

if (!lanAddress) {
  console.error('No LAN IPv4 address was found. Connect this computer to the network and try again.')
  process.exit(1)
}

const clientOrigin = `http://${lanAddress}:5173`
const childEnvironment = {
  ...process.env,
  HOST: '0.0.0.0',
  CLIENT_ORIGIN: clientOrigin,
  DEVELOPMENT_SHORT_ADMIN_PASSWORD_ENABLED: 'false',
  VITE_API_URL: '/api',
  VITE_API_PROXY_TARGET: 'http://127.0.0.1:3000',
}

console.log(`\nLAN development URL: ${clientOrigin}`)
console.log('Open this URL on a phone connected to the same network.')
if (!requestedAddress && candidates.length > 1) {
  console.log(`Selected ${lanAddress} from: ${candidates.map(({ address }) => address).join(', ')}`)
  console.log('If that adapter is wrong, set LAN_HOST to the correct IPv4 address and run again.')
}
console.log('Press Ctrl+C to stop both services.\n')

const npmCli = process.env.npm_execpath
const child = npmCli
  ? spawn(process.execPath, [npmCli, 'run', 'dev:lan:services'], {
      env: childEnvironment,
      stdio: 'inherit',
    })
  : spawn('npm', ['run', 'dev:lan:services'], {
      env: childEnvironment,
      stdio: 'inherit',
    })

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', (error) => {
  console.error(`Unable to start LAN development services: ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
