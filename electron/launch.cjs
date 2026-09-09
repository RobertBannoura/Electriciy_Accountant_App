const { spawn } = require('node:child_process')
const electronPath = require('electron')

const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  cwd: __dirname,
  env: environment,
  stdio: 'inherit',
  windowsHide: true,
})

child.once('error', (error) => {
  console.error('تعذر تشغيل Electron:', error)
  process.exitCode = 1
})

child.once('exit', (code) => {
  process.exitCode = code ?? 1
})
