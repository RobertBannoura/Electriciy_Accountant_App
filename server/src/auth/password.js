import {
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(nodeScrypt)
const algorithm = 'scrypt'
const cost = 16_384
const blockSize = 8
const parallelization = 5
const keyLength = 64
const maximumMemory = 64 * 1024 * 1024
const supportedProfiles = new Set([
  `${cost}:${blockSize}:1`,
  `${cost}:${blockSize}:${parallelization}`,
])

async function deriveKey(password, salt, parameters = { cost, blockSize, parallelization }) {
  return scrypt(password, salt, keyLength, {
    N: parameters.cost,
    r: parameters.blockSize,
    p: parameters.parallelization,
    maxmem: maximumMemory,
  })
}

function parseEncodedHash(encodedHash) {
  if (typeof encodedHash !== 'string') {
    return null
  }

  const parts = encodedHash.split('$')
  if (parts.length !== 6) {
    return null
  }

  const [
    storedAlgorithm,
    storedCost,
    storedBlockSize,
    storedParallelization,
    encodedSalt,
    encodedKey,
  ] = parts
  const profile = `${storedCost}:${storedBlockSize}:${storedParallelization}`

  if (
    storedAlgorithm !== algorithm ||
    !supportedProfiles.has(profile) ||
    !/^[A-Za-z0-9_-]{22}$/.test(encodedSalt) ||
    !/^[A-Za-z0-9_-]{86}$/.test(encodedKey)
  ) {
    return null
  }

  const salt = Buffer.from(encodedSalt, 'base64url')
  const storedKey = Buffer.from(encodedKey, 'base64url')

  if (salt.length !== 16 || storedKey.length !== keyLength) {
    return null
  }

  return {
    parameters: {
      cost: Number(storedCost),
      blockSize: Number(storedBlockSize),
      parallelization: Number(storedParallelization),
    },
    salt,
    storedKey,
  }
}

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const derivedKey = await deriveKey(password, salt)

  return [
    algorithm,
    String(cost),
    String(blockSize),
    String(parallelization),
    salt.toString('base64url'),
    derivedKey.toString('base64url'),
  ].join('$')
}

export async function verifyPassword(password, encodedHash) {
  const parsed = parseEncodedHash(encodedHash)
  if (!parsed) return false

  try {
    const candidateKey = await deriveKey(password, parsed.salt, parsed.parameters)
    return timingSafeEqual(parsed.storedKey, candidateKey)
  } catch {
    return false
  }
}

export function passwordHashNeedsUpgrade(encodedHash) {
  const parsed = parseEncodedHash(encodedHash)

  return Boolean(
    parsed &&
    parsed.parameters.parallelization !== parallelization,
  )
}
