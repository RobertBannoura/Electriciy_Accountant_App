const fs = require('node:fs/promises')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const electronPackage = require('electron/package.json')
const { ensurePostgresRuntime } = require('../scripts/materialize-postgres.cjs')
const applicationVersion = require('./package.json').version

const projectRoot = path.resolve(__dirname, '..')
const stagingDirectory = path.join(projectRoot, 'tmp', 'electron-package-stage')
const resourceStageDirectory = path.join(projectRoot, 'tmp', 'trial-server')
const electronZipDirectory = path.join(projectRoot, 'tmp', 'electron-cache')
const outputDirectory = path.join(projectRoot, 'release')
const applicationName = 'ElectricityAccountant'

const electronApplicationFiles = [
  'backup-files.cjs',
  'device-settings.cjs',
  'main.cjs',
  'platform-security.cjs',
  'preload.cjs',
  'trial-runtime.cjs',
]

async function packageWindowsApplication() {
  await assertClientBuildExists()
  await ensurePostgresRuntime()
  await ensureLocalElectronArchive()
  assertWorkspaceChild(stagingDirectory)
  assertWorkspaceChild(resourceStageDirectory)
  await fs.rm(stagingDirectory, { recursive: true, force: true })
  await fs.rm(resourceStageDirectory, { recursive: true, force: true })

  try {
    await stageApplication()
    const { packager } = await import('@electron/packager')
    const packagePaths = await packager({
      dir: stagingDirectory,
      out: outputDirectory,
      name: applicationName,
      executableName: applicationName,
      appVersion: applicationVersion,
      electronVersion: electronPackage.version,
      electronZipDir: electronZipDirectory,
      platform: 'win32',
      arch: 'x64',
      asar: true,
      extraResource: [
        path.join(projectRoot, 'vendor', 'postgresql', 'windows-x64'),
        resourceStageDirectory,
      ],
      overwrite: true,
      prune: false,
    })
    console.log(`Windows package created: ${packagePaths[0]}`)
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true })
    await fs.rm(resourceStageDirectory, { recursive: true, force: true })
  }
}

async function ensureLocalElectronArchive() {
  const filename = `electron-v${electronPackage.version}-win32-x64.zip`
  const archive = path.join(electronZipDirectory, filename)
  try {
    await fs.access(archive)
    return
  } catch { /* Build the archive from the installed development dependency. */ }
  const distribution = path.join(projectRoot, 'node_modules', 'electron', 'dist')
  await fs.access(path.join(distribution, 'electron.exe'))
  await fs.mkdir(electronZipDirectory, { recursive: true })
  const result = spawnSync('tar.exe', ['-a', '-cf', archive, '-C', distribution, '.'], {
    cwd: projectRoot, windowsHide: true, encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error('Could not archive the local Electron runtime.')
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
  const serverStage = path.join(resourceStageDirectory, 'server')
  await fs.mkdir(serverStage, { recursive: true })
  await fs.cp(path.join(projectRoot, 'server', 'src'), path.join(serverStage, 'src'), { recursive: true })
  await fs.cp(path.join(projectRoot, 'server', 'db'), path.join(serverStage, 'db'), { recursive: true })
  await fs.copyFile(path.join(projectRoot, 'server', 'package.json'), path.join(serverStage, 'package.json'))
  await stageProductionDependencies()
  await fs.writeFile(
    path.join(stagingDirectory, 'package.json'),
    `${JSON.stringify({
      name: 'electricity-accountant-app',
      productName: applicationName,
      version: applicationVersion,
      author: 'Altra Innovations',
      private: true,
      main: 'electron/main.cjs',
    }, null, 2)}\n`,
    'utf8',
  )
}

async function stageProductionDependencies() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['ls', '--all', '--omit=dev', '--parseable', '--workspace', 'server'], {
    cwd: projectRoot, encoding: 'utf8', shell: process.platform === 'win32',
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error('Production server dependencies are incomplete.')
  const destinationRoot = resourceStageDirectory
  for (const source of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const relative = path.relative(projectRoot, source)
    if (!relative.startsWith('node_modules') || relative === path.join('node_modules', '@electricity-accountant', 'server')) {
      continue
    }
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Production dependency is outside the project.')
    }
    await fs.cp(source, path.join(destinationRoot, relative), {
      recursive: true,
      filter: (candidate) => {
        const parts = path.relative(source, candidate).split(path.sep).filter(Boolean)
        return !parts.some((part) => {
          const name = part.toLowerCase()
          return ['test', 'tests', '__tests__', 'example', 'examples', 'doc', 'docs'].includes(name)
            || /^(readme|changelog|history)(\.|$)/.test(name)
            || (name.endsWith('.md') && !/^(license|licence|notice|copying)/.test(name))
            || name.endsWith('.map')
        })
      },
    })
  }
}

function assertWorkspaceChild(target) {
  const relative = path.relative(projectRoot, path.resolve(target))
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Package staging path is outside the project.')
  }
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
  if (process.env.DEBUG_OFFLINE_PACKAGE === '1') console.error(error.stack)
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
