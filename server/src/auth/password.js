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
const parallelization = 1
const keyLength = 64
const maximumMemory = 64 * 1024 * 1024

async function deriveKey(password, salt) {
  return scrypt(password, salt, keyLength, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: maximumMemory,
  })
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
  if (typeof encodedHash !== 'string') {
    return false
  }

  const [
    storedAlgorithm,
    storedCost,
    storedBlockSize,
    storedParallelization,
    encodedSalt,
    encodedKey,
  ] = encodedHash.split('$')

  if (
    storedAlgorithm !== algorithm ||
    storedCost !== String(cost) ||
    storedBlockSize !== String(blockSize) ||
    storedParallelization !== String(parallelization) ||
    !encodedSalt ||
    !encodedKey
  ) {
    return false
  }

  try {
    const salt = Buffer.from(encodedSalt, 'base64url')
    const storedKey = Buffer.from(encodedKey, 'base64url')

    if (salt.length !== 16 || storedKey.length !== keyLength) {
      return false
    }

    const candidateKey = await deriveKey(password, salt)
    return timingSafeEqual(storedKey, candidateKey)
  } catch {
    return false
  }
}
