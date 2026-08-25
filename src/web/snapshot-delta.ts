import type {
  AccountUpsertWire,
  SnapshotEventWire,
  SnapshotMetaWire,
} from '../rpc/contract'
import type { WebAccount, WebSnapshot } from './contract'
import {
  materializeAccountShell,
  materializeBilling,
  materializeDashboard,
  materializeTable,
  materializeWebSnapshot,
  type WireAccount,
  type WireSnapshot,
} from './snapshot-materialize'

/**
 * Snapshot delta protocol (introduced in wire protocol v5).
 *
 * The daemon's snapshot is dominated by three heavy per-account sections
 * (dashboard / table / billing) that only change when their refresh loop
 * refetches — yet the v4 stream re-sent all of them to every client on every
 * emission, so an 8-client hour cost ~1 GiB of redundant serialization.
 *
 * v5 sends one `init` (full snapshot) per stream, then `delta` frames:
 *   - `meta`: everything cheap, including the authoritative account id order —
 *     membership and ordering are total on every frame, so account removal
 *     needs no separate event and can never be missed.
 *   - `upserts`: only accounts whose content changed. The small shell travels
 *     whenever the account changed at all; each heavy section only when its
 *     content differs from the previous frame *on this stream*.
 *
 * Encoders are per-subscription and sit downstream of the server's sliding
 * backpressure buffer, so a delta is always relative to the previous frame the
 * client actually received; dropped intermediate snapshots cannot desync.
 * Any decoder-side inconsistency throws, which fails the stream, kills the
 * session, and reconnects into a fresh `init` — self-healing by construction.
 *
 * Change detection: reference equality first (sections are referentially
 * stable in the engine between refetches), then a 64-bit FNV-1a content hash
 * of the section JSON. Hashes are cached per section object in WeakMaps shared
 * across all subscriptions, so N clients hash a new section once, not N times.
 */

interface SectionFingerprint {
  length: number
  hashLo: number
  hashHi: number
}

const sectionFingerprints = new WeakMap<object, SectionFingerprint>()

function fnv1a(value: string, seed: number): number {
  let hash = seed >>> 0
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function fingerprintOf(section: object): SectionFingerprint {
  const cached = sectionFingerprints.get(section)
  if (cached) return cached
  const json = JSON.stringify(section)
  const fingerprint: SectionFingerprint = {
    length: json.length,
    hashLo: fnv1a(json, 0x811c9dc5),
    hashHi: fnv1a(json, 0xcbf29ce4),
  }
  sectionFingerprints.set(section, fingerprint)
  return fingerprint
}

function sameSection(left: object | null, right: object | null): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  const a = fingerprintOf(left)
  const b = fingerprintOf(right)
  return a.length === b.length && a.hashLo === b.hashLo && a.hashHi === b.hashHi
}

type Shell = Omit<WebAccount, 'dashboard' | 'table' | 'billing'>

function shellOf(account: WebAccount): Shell {
  const { dashboard: _dashboard, table: _table, billing: _billing, ...shell } = account
  return shell
}

// Shared across subscriptions like sectionFingerprints: account objects are
// rebuilt once per engine snapshot and shared to every subscriber, so N
// clients stringify each shell once per tick, not N times.
const shellJsonCache = new WeakMap<object, string>()

function shellJsonOf(account: WebAccount): string {
  const cached = shellJsonCache.get(account)
  if (cached) return cached
  const json = JSON.stringify(shellOf(account))
  shellJsonCache.set(account, json)
  return json
}

/**
 * Strip `undefined`-valued keys at every depth. Schema's optionalKey accepts
 * absence but rejects explicit undefined, and frames carry provider-built
 * objects whose optional keys aren't guaranteed absent. Deliberately NOT a
 * JSON round-trip: JSON.stringify would coerce NaN/Infinity to null, turning
 * a loud encode failure into silently wrong data in NullOr(Finite) fields.
 */
function scrubUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(scrubUndefined) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = scrubUndefined(entry)
    }
    return out as T
  }
  return value
}

function metaOf(snapshot: WebSnapshot): SnapshotMetaWire {
  return {
    version: snapshot.version,
    generatedAt: snapshot.generatedAt,
    tz: snapshot.tz,
    intervalMs: snapshot.intervalMs,
    ...(snapshot.billingIntervalMs === undefined ? {} : { billingIntervalMs: snapshot.billingIntervalMs }),
    ...(snapshot.installedProviders === undefined ? {} : { installedProviders: snapshot.installedProviders }),
    providers: snapshot.providers,
    ...(snapshot.suppressedAccounts === undefined ? {} : { suppressedAccounts: snapshot.suppressedAccounts }),
    seeded: snapshot.seeded,
    peak: snapshot.peak,
    accountIds: snapshot.accounts.map(account => account.id),
  } as SnapshotMetaWire
}

export interface SnapshotDeltaEncoder {
  /** Encode the next engine snapshot into the frame to send on this stream. */
  next(snapshot: WebSnapshot): SnapshotEventWire
}

interface EncodedAccountState {
  account: WebAccount
  shellJson: string
}

export function createSnapshotDeltaEncoder(): SnapshotDeltaEncoder {
  let previous: Map<string, EncodedAccountState> | null = null

  const remember = (snapshot: WebSnapshot): Map<string, EncodedAccountState> => {
    const state = new Map<string, EncodedAccountState>()
    for (const account of snapshot.accounts) {
      state.set(account.id, { account, shellJson: shellJsonOf(account) })
    }
    return state
  }

  return {
    next(snapshot) {
      if (previous === null) {
        previous = remember(snapshot)
        return { _tag: 'init', snapshot: scrubUndefined(snapshot) as unknown as WireSnapshot }
      }

      const upserts: AccountUpsertWire[] = []
      const nextState = new Map<string, EncodedAccountState>()
      for (const account of snapshot.accounts) {
        const prev = previous.get(account.id)
        const shellJson = shellJsonOf(account)
        nextState.set(account.id, { account, shellJson })

        // `?? null`: sections are typed non-undefined but travel from provider
        // code; an undefined would be scrubbed to "unchanged" otherwise.
        const dashboard = account.dashboard ?? null
        const table = account.table ?? null
        const billing = account.billing ?? null
        const dashboardChanged = !prev || !sameSection(prev.account.dashboard ?? null, dashboard)
        const tableChanged = !prev || !sameSection(prev.account.table ?? null, table)
        const billingChanged = !prev || !sameSection(prev.account.billing ?? null, billing)
        const shellChanged = !prev || prev.shellJson !== shellJson
        if (!shellChanged && !dashboardChanged && !tableChanged && !billingChanged) continue

        upserts.push({
          shell: JSON.parse(shellJson),
          ...(dashboardChanged ? { dashboard } : {}),
          ...(tableChanged ? { table } : {}),
          ...(billingChanged ? { billing } : {}),
        } as AccountUpsertWire)
      }

      previous = nextState
      return scrubUndefined({ _tag: 'delta', meta: metaOf(snapshot), upserts }) as SnapshotEventWire
    },
  }
}

export class SnapshotDeltaDesyncError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotDeltaDesyncError'
  }
}

export interface SnapshotDeltaDecoder {
  /** Apply the next frame; returns the full materialized snapshot. Throws on desync. */
  apply(event: SnapshotEventWire): WebSnapshot
}

export function createSnapshotDeltaDecoder(): SnapshotDeltaDecoder {
  let accounts = new Map<string, WebAccount>()
  let sawInit = false

  return {
    apply(event) {
      if (event._tag === 'init') {
        sawInit = true
        const snapshot = materializeWebSnapshot(event.snapshot)
        accounts = new Map(snapshot.accounts.map(account => [account.id, account]))
        return snapshot
      }

      // The encoder always leads with init; a delta-first stream means this
      // decoder is paired with the wrong stream state. Fail loudly rather
      // than materialize a snapshot from nothing.
      if (!sawInit) throw new SnapshotDeltaDesyncError('delta received before init frame')

      for (const upsert of event.upserts) {
        const prev = accounts.get(upsert.shell.id)
        if (!prev && !('dashboard' in upsert && 'table' in upsert && 'billing' in upsert)) {
          // A brand-new account must carry all sections. Anything else means
          // this stream lost a frame — fail fast and let the session redial.
          throw new SnapshotDeltaDesyncError(`delta introduced account ${upsert.shell.id} without full sections`)
        }
        accounts.set(upsert.shell.id, {
          ...materializeAccountShell(upsert.shell as Omit<WireAccount, 'dashboard' | 'table' | 'billing'>),
          dashboard: 'dashboard' in upsert ? materializeDashboard(upsert.dashboard as WireAccount['dashboard']) : prev!.dashboard,
          table: 'table' in upsert ? materializeTable(upsert.table as WireAccount['table']) : prev!.table,
          billing: 'billing' in upsert ? materializeBilling(upsert.billing as WireAccount['billing']) : prev!.billing,
        })
      }

      const meta = event.meta
      const ordered: WebAccount[] = []
      const live = new Set<string>()
      for (const id of meta.accountIds) {
        // Duplicates would defeat the size-based staleness reasoning and can
        // only mean a corrupt frame — fail into a fresh init.
        if (live.has(id)) throw new SnapshotDeltaDesyncError(`duplicate account id ${id} in delta order`)
        live.add(id)
        const account = accounts.get(id)
        if (!account) throw new SnapshotDeltaDesyncError(`delta references unknown account ${id}`)
        ordered.push(account)
      }
      // Drop state for accounts no longer in the authoritative order.
      for (const id of [...accounts.keys()]) if (!live.has(id)) accounts.delete(id)

      return {
        version: meta.version,
        generatedAt: meta.generatedAt,
        tz: meta.tz,
        intervalMs: meta.intervalMs,
        ...(meta.billingIntervalMs === undefined ? {} : { billingIntervalMs: meta.billingIntervalMs }),
        ...(meta.installedProviders === undefined ? {} : { installedProviders: meta.installedProviders }),
        providers: meta.providers.map(provider => ({
          ...provider,
          ...(provider.headroom !== undefined
            ? {
                headroom: {
                  ...provider.headroom,
                  activeAccountIds: [...provider.headroom.activeAccountIds],
                  factors: provider.headroom.factors.map(factor => ({ ...factor })),
                },
              }
            : {}),
        })),
        accounts: ordered,
        ...(meta.suppressedAccounts === undefined ? {} : { suppressedAccounts: meta.suppressedAccounts }),
        seeded: meta.seeded,
        peak: meta.peak ? { ...meta.peak } : null,
      } as WebSnapshot
    },
  }
}
