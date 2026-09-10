import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import webpush from 'web-push'

const keys = webpush.generateVAPIDKeys()
const outputPath = path.resolve(
  process.env.VAPID_OUTPUT_FILE ?? path.join('.secrets', 'vapid.env'),
)
const contents = [
  `VAPID_PUBLIC_KEY=${keys.publicKey}`,
  `VAPID_PRIVATE_KEY=${keys.privateKey}`,
  'VAPID_SUBJECT=mailto:admin@example.com',
  '',
].join('\n')

await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 })
await writeFile(outputPath, contents, {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o600,
})

console.log(`VAPID configuration written to ${outputPath}. The private key was not printed.`)
