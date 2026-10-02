const fs = require('node:fs/promises')
const path = require('node:path')
const { build, Platform, Arch } = require('electron-builder')

const projectRoot = path.resolve(__dirname, '..')
const defaultPackage = path.join(projectRoot, 'release', 'ElectricityAccountant-win32-x64')

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

function workspacePath(value) {
  if (!value) throw new Error('Missing installer path option.')
  const result = path.resolve(projectRoot, value)
  const relative = path.relative(projectRoot, result)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Installer paths must be inside the workspace.')
  }
  return result
}

async function main() {
  const prepackaged = workspacePath(option('--prepackaged', defaultPackage))
  const output = workspacePath(option('--output', path.join(projectRoot, 'release', 'installer')))
  await fs.access(path.join(prepackaged, 'ElectricityAccountant.exe'))
  await fs.access(path.join(prepackaged, 'resources', 'windows-x64', 'bin', 'postgres.exe'))
  await fs.access(path.join(prepackaged, 'resources', 'trial-server', 'server', 'db', 'migrations'))

  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  process.env.ELECTRON_BUILDER_CACHE = path.join(projectRoot, 'tmp', 'electron-builder-cache')
  const artifacts = await build({
    projectDir: projectRoot,
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    prepackaged,
    config: {
      appId: 'com.altrainnovations.electricityaccountant.trial',
      productName: 'Electricity Accountant Trial',
      copyright: 'Altra Innovations',
      directories: { output },
      win: { executableName: 'ElectricityAccountant', target: 'nsis' },
      nsis: {
        artifactName: 'Electricity-Accountant-Trial-Setup.exe',
        oneClick: false,
        perMachine: false,
        selectPerMachineByDefault: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: 'always',
        createStartMenuShortcut: true,
        runAfterFinish: true,
        deleteAppDataOnUninstall: false,
        installerLanguages: ['ar_SA', 'en_US'],
        include: path.join(projectRoot, 'electron', 'installer.nsh'),
        shortcutName: 'نظام إدارة الحسابات والمتجر',
      },
      publish: null,
    },
  })
  for (const artifact of artifacts) console.log(`Installer created: ${artifact}`)
}

main().catch((error) => {
  console.error('Installer build failed:', error)
  process.exitCode = 1
})
