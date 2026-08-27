import { join } from 'node:path'
import type { RuntimeFile } from '../../shared/types'
import { readJson, writeJsonAtomic } from './jsonFile'

export class RuntimeStore {
  constructor(private dir: () => string) {}
  private file(): string { return join(this.dir(), 'runtime.json') }
  load(): RuntimeFile { return readJson<RuntimeFile>(this.file(), {}) }
  save(rf: RuntimeFile): void { writeJsonAtomic(this.file(), rf) }
}
