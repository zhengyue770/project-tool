import { join } from 'node:path'
import type { AppSettings } from '../../shared/types'
import { readJson, writeJsonAtomic } from './jsonFile'

export const DEFAULT_SETTINGS: AppSettings = { startupTimeoutMs: 60000, autoLaunch: false }

export class SettingsStore {
  constructor(private dir: () => string) {}
  private file(): string { return join(this.dir(), 'settings.json') }
  load(): AppSettings {
    return { ...DEFAULT_SETTINGS, ...readJson<Partial<AppSettings>>(this.file(), {}) }
  }
  save(s: AppSettings): void { writeJsonAtomic(this.file(), s) }
}
