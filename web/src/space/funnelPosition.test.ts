// Funnel position: each creative joins the segment that took most of its spend and is ranked only against that
// segment, CPMr weighted twice as heavily as frequency.
import { describe, expect, it } from 'vitest'
import type { Ad } from '../lib/api'
import { classifyFunnelPositions } from './funnelPosition'

let n = 0
// CPMr here is spend / reach * 1000, so reach comes from the CPMr we want.
const ad = (seg: Partial<NonNullable<Ad['segment_spend']>>, frequency: number, cpmr: number): Ad => {
  n += 1
  const reach = (100 / cpmr) * 1000
  return {
    ad_id: String(n), ad_name: `creative number ${n}`, creative_hash: `h${n}`, spend: 100,
    impressions: reach * frequency, reach, frequency, segment_spend: seg,
  } as unknown as Ad
}
const ENG = { prospecting: 20, engaged: 80, existing: 0, unknown: 0 }
const NEW = { prospecting: 90, engaged: 10, existing: 0, unknown: 0 }

describe('classifyFunnelPositions', () => {
  it('weights CPMr over frequency inside the engaged segment', () => {
    const hiCpmr = ad(ENG, 1.2, 40), hiFreq = ad(ENG, 4, 10)
    const out = classifyFunnelPositions([hiCpmr, hiFreq])
    expect(out.get(hiCpmr.ad_id)?.lane).toBe('BOF')
    expect(out.get(hiFreq.ad_id)?.lane).toBe('MOF')
  })

  it('ranks engaged ads without regard to how hard the New segment is hit', () => {
    const a = ad(ENG, 1.5, 12), b = ad(ENG, 2.5, 25)
    const alone = classifyFunnelPositions([a, b])
    const withNew = classifyFunnelPositions([a, b, ad(NEW, 9, 400), ad(NEW, 8, 300), ad(NEW, 0.5, 1)])
    for (const x of [a, b]) expect(withNew.get(x.ad_id)?.lane).toBe(alone.get(x.ad_id)?.lane)
    expect(alone.get(b.ad_id)?.lane).toBe('BOF')
  })

  it('maps segments to lanes and flags Unknown-led ads as estimated', () => {
    const existing = ad({ prospecting: 10, engaged: 10, existing: 80, unknown: 0 }, 2, 20)
    const cold = ad(NEW, 1, 8)
    const warmNew = ad({ prospecting: 55, engaged: 45, existing: 0, unknown: 0 }, 1, 8)
    const unknownLed = ad({ prospecting: 30, engaged: 0, existing: 0, unknown: 70 }, 1, 8)
    const none = ad({}, 1, 8)
    const out = classifyFunnelPositions([existing, cold, warmNew, unknownLed, none])
    expect(out.get(existing.ad_id)?.lane).toBe('REACT')
    expect(out.get(cold.ad_id)?.lane).toBe('TOF')
    expect(out.get(warmNew.ad_id)?.lane).toBe('MOF')
    expect(out.get(cold.ad_id)?.estimated).toBe(false)
    expect(out.get(unknownLed.ad_id)?.estimated).toBe(true)
    expect(out.get(none.ad_id)?.estimated).toBe(true)
  })
})

describe('classifyFunnelPositions, small groups and shared creatives', () => {
  it('puts a lone ad with no segment data in the middle, not the bottom', () => {
    const lone = ad({}, 2, 15)
    const out = classifyFunnelPositions([lone])
    expect(out.get(lone.ad_id)?.lane).toBe('MOF')
    expect(out.get(lone.ad_id)?.estimated).toBe(true)
  })

  it('averages CPMr and frequency by spend for a creative running as several ads', () => {
    // One creative in two ad sets: reach overlaps, so it is not summed.
    const a = { ...ad(ENG, 2, 30), creative_hash: 'shared', spend: 300, reach: 10000 } as Ad
    const b = { ...ad(ENG, 3, 40), creative_hash: 'shared', spend: 100, reach: 2500, frequency: null, impressions: 7500 } as Ad
    const out = classifyFunnelPositions([a, b])
    const p = out.get(a.ad_id)!
    expect(out.get(b.ad_id)).toBe(p)
    expect(p.members).toBe(2)
    expect(p.cpmr).toBeCloseTo(32.5) // (30*300 + 40*100) / 400
    expect(p.freq).toBeCloseTo(2.25) // missing frequency falls back to impressions / reach = 3
  })
})
