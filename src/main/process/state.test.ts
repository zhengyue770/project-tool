import { describe, it, expect } from 'vitest'
import { aggregateProjectStatus } from './state'

describe('aggregateProjectStatus（spec §5.3 聚合表）', () => {
  it('全 running → running', () =>
    expect(aggregateProjectStatus(['running', 'running'])).toBe('running'))
  it('任一 starting → starting（优先于 failed）', () =>
    expect(aggregateProjectStatus(['running', 'starting', 'failed'])).toBe('starting'))
  it('任一 failed 且无 starting → failed', () =>
    expect(aggregateProjectStatus(['running', 'failed'])).toBe('failed'))
  it('全 stopped → stopped', () =>
    expect(aggregateProjectStatus(['stopped', 'stopped'])).toBe('stopped'))
  it('running 与 stopped 混合 → partial', () =>
    expect(aggregateProjectStatus(['running', 'stopped'])).toBe('partial'))
  it('空数组 → stopped', () =>
    expect(aggregateProjectStatus([])).toBe('stopped'))
})
