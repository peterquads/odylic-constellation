// =============================================================================
// Funnel position: where each creative sits in the funnel. Ported from
// Atelier's creative space, same rules. Pure functions over the ads already
// loaded: no request, no Meta call.
//
// Placement uses each creative's REAL spend mix from Meta's `user_segment_key`
// breakdown (segment_spend), NOT a frequency guess. Lanes, top to bottom:
//   TOF    New (prospecting) cohort
//   MOF    Engaged cohort, lower saturation (warming)
//   BOF    Engaged cohort, higher saturation (hit harder, NOT customers)
//   REACT  Reactivation = the EXISTING-customer cohort (retention layer)
//
// Each creative joins the segment that took most of its spend, and is ranked
// against the other creatives IN THAT SEGMENT by a "saturation" score: its
// CPMr percentile and frequency percentile within the segment, CPMr weighted
// twice as heavily. The ENGAGED segment splits MOF vs BOF at its median score.
// Ads with no measured cohort (no segment delivery, or Unknown is the biggest
// share) are ranked among themselves, ranged across TOF/MOF/BOF by score and
// flagged `estimated`, so a view is honest about measured vs inferred.
//
// Absolute frequency / CPMr numbers are never used (a frequency of 3 means
// fatigue for cold traffic but health for warm), only percentile ranks.
// =============================================================================

import type { Ad } from '../lib/api'
import { SEGMENT_LABELS } from '../lib/metrics'

type AdCreative = Ad

export type FunnelLane = 'TOF' | 'MOF' | 'BOF' | 'REACT'
export const FUNNEL_LANES: FunnelLane[] = ['TOF', 'MOF', 'BOF', 'REACT']

export const FUNNEL_LANE_LABEL: Record<FunnelLane, string> = {
  TOF: 'Top of funnel',
  MOF: 'Middle of funnel',
  BOF: 'Bottom of funnel',
  REACT: 'Reactivation',
}
export const FUNNEL_LANE_SUB: Record<FunnelLane, string> = {
  TOF: SEGMENT_LABELS.prospecting,
  MOF: `${SEGMENT_LABELS.engaged}: warming`,
  BOF: `${SEGMENT_LABELS.engaged}: saturated (high frequency and CPMr)`,
  REACT: `${SEGMENT_LABELS.existing} customers`,
}

export type FunnelPlacement = {
  lane: FunnelLane
  /** True when the lane came from frequency / CPMr, not measured segment delivery. */
  estimated: boolean
  /** Same-creative group key; every ad in a group shares its placement. */
  key: string
  /** Ads in the same-creative group. */
  members: number
  /** Spend-weighted frequency of the group. */
  freq: number
  cpmr: number
}

/** CPMr's share of the saturation score; frequency takes the rest. */
const CPMR_WEIGHT = 2 / 3

type SegSpend = { prospecting: number; engaged: number; existing: number; unknown: number }

function segOf(ad: AdCreative): SegSpend {
  const s = ad.segment_spend || ({} as Partial<NonNullable<AdCreative['segment_spend']>>)
  return {
    prospecting: Number(s.prospecting) || 0,
    engaged: Number(s.engaged) || 0,
    existing: Number(s.existing) || 0,
    unknown: Number(s.unknown) || 0,
  }
}

function dominantOf(s: SegSpend): keyof SegSpend {
  const entries: [keyof SegSpend, number][] = [
    ['prospecting', s.prospecting], ['engaged', s.engaged],
    ['existing', s.existing], ['unknown', s.unknown],
  ]
  entries.sort((a, b) => b[1] - a[1])
  return entries[0][1] > 0 ? entries[0][0] : 'unknown'
}

/** Quantile of an already sorted list. */
function sortedQuantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo)
}

/**
 * Same-creative key: the backend's creative_hash (image hash, video id or
 * creative id), so every ad running one creative shares one placement. Ads
 * without it fall back to the ad name, then the ad itself.
 */
export function funnelDedupeKey(ad: AdCreative): string {
  if (ad.creative_hash) return `c:${ad.creative_hash}`
  const n = (ad.ad_name || '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (n.length >= 6) return `n:${n}`
  return `a:${ad.ad_id}`
}

/**
 * Funnel lane for every spending ad, keyed by ad_id. Percentiles are relative
 * to the ads passed in (the view), the same as the funnel viewer. Ads with no
 * spend are not placed (absent from the map).
 */
export function classifyFunnelPositions(ads: AdCreative[]): Map<string, FunnelPlacement> {
  // A creative can run as several ads (one per ad set). Frequency and CPMr are each ad's own, averaged by spend:
  // reach doesn't add up across ad sets (the same people sit in several), so summing it would understate CPMr
  // for creatives that run in many places. Ads missing a value don't weigh into its average.
  type G = { seg: SegSpend; freqSum: number; freqW: number; cpmrSum: number; cpmrW: number; ids: string[] }
  const groups = new Map<string, G>()
  for (const ad of ads) {
    const spend = Number(ad.spend) || 0
    if (!ad.ad_id || !(spend > 0)) continue
    const key = funnelDedupeKey(ad)
    const seg = segOf(ad)
    const reach = Number(ad.reach) || 0
    const freq = Number(ad.frequency) || (reach > 0 ? (Number(ad.impressions) || 0) / reach : 0)
    const cpmr = reach > 0 ? (spend / reach) * 1000 : 0
    let g = groups.get(key)
    if (!g) {
      g = { seg: { prospecting: 0, engaged: 0, existing: 0, unknown: 0 }, freqSum: 0, freqW: 0, cpmrSum: 0, cpmrW: 0, ids: [] }
      groups.set(key, g)
    }
    g.seg.prospecting += seg.prospecting
    g.seg.engaged += seg.engaged
    g.seg.existing += seg.existing
    g.seg.unknown += seg.unknown
    if (freq > 0) { g.freqSum += freq * spend; g.freqW += spend }
    if (cpmr > 0) { g.cpmrSum += cpmr * spend; g.cpmrW += spend }
    g.ids.push(ad.ad_id)
  }

  type Pre = {
    key: string; ids: string[]; seg: SegSpend; total: number
    dominant: keyof SegSpend; freq: number; cpmr: number; estimated: boolean
  }
  const pre: Pre[] = []
  for (const [key, g] of groups) {
    const total = g.seg.prospecting + g.seg.engaged + g.seg.existing + g.seg.unknown
    const freq = g.freqW > 0 ? g.freqSum / g.freqW : 0
    const cpmr = g.cpmrW > 0 ? g.cpmrSum / g.cpmrW : 0
    pre.push({ key, ids: g.ids, seg: g.seg, total, dominant: dominantOf(g.seg), freq, cpmr, estimated: total <= 0 })
  }

  // SHARE-BASED cohort on the measured axis only (unknown is off-axis).
  type Bucket = 'existing' | 'engaged' | 'new' | 'none'
  const cohortShares = (p: Pre): { pr: number; en: number; ex: number } | null => {
    const t = p.seg.prospecting + p.seg.engaged + p.seg.existing
    if (t <= 0) return null
    return { pr: p.seg.prospecting / t, en: p.seg.engaged / t, ex: p.seg.existing / t }
  }
  const bucketOf = (p: Pre): Bucket => {
    const sh = p.estimated || p.dominant === 'unknown' ? null : cohortShares(p)
    if (!sh) return 'none'
    if (sh.ex >= sh.pr && sh.ex >= sh.en && sh.ex > 0) return 'existing'
    if (sh.en > sh.pr && sh.en >= sh.ex && sh.en > 0) return 'engaged'
    return 'new'
  }
  const buckets = new Map<Pre, Bucket>()
  for (const p of pre) buckets.set(p, bucketOf(p))

  // Percentile position within the creative's OWN segment, combined into a
  // 0..1 saturation score. Higher = hit harder than its segment peers.
  const sortedBy = (b: Bucket, f: (p: Pre) => number): number[] =>
    pre.filter(p => buckets.get(p) === b).map(f).filter(v => v > 0).sort((a, c) => a - c)
  const ranks = new Map<Bucket, { freq: number[]; cpmr: number[] }>()
  for (const b of ['existing', 'engaged', 'new', 'none'] as Bucket[]) {
    ranks.set(b, { freq: sortedBy(b, p => p.freq), cpmr: sortedBy(b, p => p.cpmr) })
  }
  // Mid-rank percentile: share below v plus half the ties, so ranks run evenly
  // around 0.5 (the old share-at-or-below never reached 0, which pushed lone
  // and small groups toward the bottom). Binary searches keep it O(n log n).
  const pctRank = (sorted: number[], v: number): number => {
    if (!sorted.length || !(v > 0)) return 0.5
    const upper = (strict: boolean) => {
      let lo = 0, hi = sorted.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (strict ? sorted[mid] < v : sorted[mid] <= v) lo = mid + 1
        else hi = mid
      }
      return lo
    }
    const below = upper(true), atOrBelow = upper(false)
    return (below + atOrBelow) / 2 / sorted.length
  }
  const satCache = new Map<Pre, number>()
  const saturation = (p: Pre): number => {
    let s = satCache.get(p)
    if (s === undefined) {
      const r = ranks.get(buckets.get(p)!)!
      s = CPMR_WEIGHT * pctRank(r.cpmr, p.cpmr) + (1 - CPMR_WEIGHT) * pctRank(r.freq, p.freq)
      satCache.set(p, s)
    }
    return s
  }

  //   existing is the top cohort    -> REACTIVATION
  //   engaged is the top cohort     -> MOF vs BOF, split at the MEDIAN score of
  //                                    the engaged segment
  //   prospecting is the top cohort -> TOF, or MOF when the audience already
  //                                    skews warm (engaged >= NEW_MOF_WARMTH of
  //                                    the cold + warm mix)
  //   no measured cohort            -> TOF/MOF/BOF by score tertiles, estimated
  const engSats = pre.filter(p => buckets.get(p) === 'engaged').map(saturation).sort((a, b) => a - b)
  const engMedian = engSats.length ? sortedQuantile(engSats, 0.5) : 0.5
  const NEW_MOF_WARMTH = 0.4

  const laneOf = (p: Pre): FunnelLane => {
    const b = buckets.get(p)!
    if (b === 'existing') return 'REACT'
    if (b === 'engaged') return saturation(p) >= engMedian ? 'BOF' : 'MOF'
    if (b === 'new') {
      const sh = cohortShares(p)!
      const pe = sh.pr + sh.en
      return pe > 0 && sh.en / pe >= NEW_MOF_WARMTH ? 'MOF' : 'TOF'
    }
    const s = saturation(p)
    if (s < 1 / 3) return 'TOF'
    if (s < 2 / 3) return 'MOF'
    return 'BOF'
  }

  const out = new Map<string, FunnelPlacement>()
  for (const p of pre) {
    const placement: FunnelPlacement = {
      lane: laneOf(p),
      estimated: buckets.get(p) === 'none',
      key: p.key,
      members: p.ids.length,
      freq: p.freq,
      cpmr: p.cpmr,
    }
    for (const id of p.ids) out.set(id, placement)
  }
  return out
}
