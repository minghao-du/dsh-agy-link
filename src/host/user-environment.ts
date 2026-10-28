import type { UserEnvironmentMode } from '../common/types.ts'
import { isolatedHomeEnv } from './runner.ts'

export function userEnvironmentStatus(requestedMode: UserEnvironmentMode, hostToolsAvailable = false) {
  return {
    requestedMode,
    effectiveMode: requestedMode === 'shared' && hostToolsAvailable ? 'shared' as const : 'isolated' as const,
    sharedAvailable: hostToolsAvailable,
    reason: hostToolsAvailable ? 'host-tools' as const : 'account-isolation-unavailable' as const,
  }
}

/** Preserve account authentication even when persisted config requests sharing. */
export function accountProcessEnvironment(accountDir: string, _requestedMode: UserEnvironmentMode): NodeJS.ProcessEnv {
  return { ...process.env, ...(accountDir ? isolatedHomeEnv(accountDir) : {}) }
}
