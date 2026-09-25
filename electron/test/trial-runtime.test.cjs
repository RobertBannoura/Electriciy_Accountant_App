const assert = require('node:assert/strict')
const test = require('node:test')
const { hiddenProcessOptions } = require('../trial-runtime.cjs')

test('trial child processes never request a console, shell, or detached lifetime', () => {
  const options = hiddenProcessOptions({ cwd: 'C:\\trial', stdio: 'ignore' })
  assert.equal(options.windowsHide, true)
  assert.equal(options.detached, false)
  assert.equal(options.shell, false)
  assert.equal(options.cwd, 'C:\\trial')
})
