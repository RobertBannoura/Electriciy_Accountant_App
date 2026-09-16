const { spawn } = require('node:child_process')
const electronPath = require('electron')

const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  cwd: __dirname,
  env: environment,
  stdio: 'inherit',
})

child.once('error', (error) => {
  console.error('تعذر تشغيل Electron:', {
    errorCode: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
      ? error.code
      : 'ELECTRON_LAUNCH_FAILED',
    errorName: typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
      ? error.name
      : 'Error',
  })
  process.exitCode = 1
})

child.once('exit', (code) => {
  process.exitCode = code ?? 1
})
