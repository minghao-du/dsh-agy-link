import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { resolveConfig } from '../src/common/config.ts'
import { isolatedHomeEnv } from '../src/host/runner.ts'
import { accountProcessEnvironment, userEnvironmentStatus } from '../src/host/user-environment.ts'

test('unverified sharing cannot change the account environment through any config layer', { timeout: 5000 }, () => {
  assert.equal(resolveConfig({}, {}, {}).userEnvironmentMode, 'isolated')
  assert.equal(resolveConfig({ userEnvironmentMode: 'shared' }, {}, { userEnvironmentMode: 'isolated' }).userEnvironmentMode, 'isolated')
  assert.equal(resolveConfig({}, {}, { userEnvironmentMode: 'invalid' }).userEnvironmentMode, 'isolated')
  const accountDir = join(tmpdir(), 'agy-environment-account')
  const checkEnvironment = (actual: NodeJS.ProcessEnv, expected: NodeJS.ProcessEnv) => {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort())
    for (const key of Object.keys(expected)) {
      assert.equal(actual[key] === expected[key], true, `environment changed for ${key}`)
    }
  }
  for (const cfg of [
    resolveConfig({ userEnvironmentMode: 'shared' }, {}, {}),
    resolveConfig({}, {}, { userEnvironmentMode: 'shared' }),
    resolveConfig({}, { DSH_AGY_USER_ENVIRONMENT_MODE: 'shared' }, { userEnvironmentMode: 'isolated' }),
  ]) {
    assert.equal(cfg.userEnvironmentMode, 'shared')
    const status = userEnvironmentStatus(cfg.userEnvironmentMode)
    assert.equal(status.sharedAvailable, false)
    assert.equal(status.effectiveMode, 'isolated')
    checkEnvironment(accountProcessEnvironment(accountDir, cfg.userEnvironmentMode), {
      ...process.env, ...isolatedHomeEnv(accountDir),
    })
    checkEnvironment(accountProcessEnvironment('', cfg.userEnvironmentMode), process.env)
  }
  checkEnvironment(accountProcessEnvironment(accountDir, 'isolated'), {
    ...process.env, ...isolatedHomeEnv(accountDir),
  })
  // The actual regression is a secondary account inheriting the host HOME.
  // Change the live host environment after module import: primary launches must
  // see it, while secondary launches must retain their account-specific HOME.
  const previousHome = process.env.HOME
  const sentinel = 'DSH_AGY_ENVIRONMENT_TEST_SENTINEL'
  const previousSentinel = process.env[sentinel]
  try {
    process.env.HOME = join(tmpdir(), 'agy-environment-system')
    process.env[sentinel] = 'before'
    const secondary = accountProcessEnvironment(accountDir, 'shared')
    assert.equal(secondary.HOME, accountDir)
    assert.equal(secondary.GEMINI_CLI_HOME, join(accountDir, '.gemini'))
    assert.equal(secondary.ANTIGRAVITY_APP_DATA_DIR, join(accountDir, '.gemini', 'antigravity-cli'))
    assert.equal(secondary[sentinel], 'before')
    process.env[sentinel] = 'after'
    assert.equal(accountProcessEnvironment(accountDir, 'shared')[sentinel], 'after')
    assert.equal(secondary[sentinel], 'before', 'a launch environment must be a separate snapshot')
    const primary = accountProcessEnvironment('', 'shared')
    assert.equal(primary.HOME, process.env.HOME)
    assert.equal(primary[sentinel], 'after')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousSentinel === undefined) delete process.env[sentinel]
    else process.env[sentinel] = previousSentinel
  }
})

test('settings reject unverified sharing, persist isolation, and report the effective mode', { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-environment-config-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const ctx = new Context()
  const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => void }> = []
  try {
    ctx.plugin({
      name: 'user-environment-test-host',
      apply(c: Context) {
        c.provide('llm', { registerAdapter() { return () => undefined } })
        c.provide('commands', { register() { return () => undefined } })
        c.provide('webServer', { register(route: typeof routes[number]) { routes.push(route) } })
      },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    apply(ctx, { enabled: false, mcpBridge: false, userEnvironmentMode: 'shared' })
    await new Promise(resolve => setTimeout(resolve, 20))
    const request = (path: string, method: string, body: Record<string, unknown> = {}): Promise<{ status: number; body: any }> =>
      new Promise(resolve => {
        const route = routes.find(r => r.path === path)
        assert.ok(route)
        let status = 0
        route.handler({ method, on(event: string, cb: (chunk: Buffer) => void) {
          if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
          if (event === 'end') cb(Buffer.alloc(0))
        } }, { writeHead(code: number) { status = code }, end(value: string) { resolve({ status, body: JSON.parse(value) }) } })
      })
    const initial = await request('/plugins/agy-link/status', 'GET')
    assert.equal(initial.body.userEnvironment.requestedMode, 'shared')
    assert.equal(initial.body.userEnvironment.effectiveMode, 'isolated')
    assert.equal(initial.body.userEnvironment.sharedAvailable, false)
    const update = (value: unknown) => request('/plugins/agy-link/config', 'POST', { key: 'userEnvironmentMode', value })
    assert.equal((await update('invalid')).status, 400)
    const blocked = await update('shared')
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.code, 'account-isolation-unavailable')
    assert.equal((await update('isolated')).status, 200)
    assert.equal((await update('shared')).status, 409)
    const overrides = JSON.parse(readFileSync(join(dir, 'agy-link', 'runtime-overrides.json'), 'utf8'))
    assert.equal(resolveConfig({}, {}, overrides).userEnvironmentMode, 'isolated')
    assert.equal((await request('/plugins/agy-link/status', 'GET')).body.userEnvironment.requestedMode, 'isolated')
  } finally {
    await ctx.fiber.dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
