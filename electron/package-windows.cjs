const fs = require('node:fs/promises')
const path = require('node:path')
const electronPackage = require('electron/package.json')

const projectRoot = path.resolve(__dirname, '..')
const stagingDirectory = path.join(projectRoot, 'tmp', 'electron-package-stage')
const outputDirectory = path.join(projectRoot, 'release')
const applicationName = 'ElectricityAccountant'

const electronApplicationFiles = [
  'backup-files.cjs',
  'device-settings.cjs',
  'main.cjs',
  'platform-security.cjs',
  'preload.cjs',
]

async function packageWindowsApplication() {
  await assertClientBuildExists()
  await fs.rm(stagingDirectory, { recursive: true, force: true })

  try {
    await stageApplication()
    const { packager } = await import('@electron/packager')
    const packagePaths = await packager({
      dir: stagingDirectory,
      out: outputDirectory,
      name: applicationName,
      executableName: applicationName,
      appVersion: '0.1.0',
      electronVersion: electronPackage.version,
      platform: 'win32',
      arch: 'x64',
      asar: true,
      overwrite: true,
      prune: true,
    })
    console.log(`Windows package created: ${packagePaths[0]}`)
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true })
  }
}

async function stageApplication() {
  await fs.mkdir(path.join(stagingDirectory, 'electron'), { recursive: true })
  await fs.cp(
    path.join(projectRoot, 'client', 'dist'),
    path.join(stagingDirectory, 'client', 'dist'),
    { recursive: true },
  )
  await Promise.all(electronApplicationFiles.map((fileName) => fs.copyFile(
    path.join(__dirname, fileName),
    path.join(stagingDirectory, 'electron', fileName),
  )))
  await fs.writeFile(
    path.join(stagingDirectory, 'package.json'),
    `${JSON.stringify({
      name: 'electricity-accountant-app',
      productName: applicationName,
      version: '0.1.0',
      author: 'Altra Innovations',
      private: true,
      main: 'electron/main.cjs',
    }, null, 2)}\n`,
    'utf8',
  )
}

async function assertClientBuildExists() {
  const indexPath = path.join(projectRoot, 'client', 'dist', 'index.html')
  try {
    await fs.access(indexPath)
  } catch {
    throw new Error('Client production build is missing. Run npm run build first.')
  }
}

packageWindowsApplication().catch((error) => {
  console.error('Electron packaging failed:', {
    errorCode: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
      ? error.code
      : 'ELECTRON_PACKAGE_FAILED',
    errorName: typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
      ? error.name
      : 'Error',
  })
  process.exitCode = 1
})
