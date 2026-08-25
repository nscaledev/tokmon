import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import type { LookupAddress } from 'node:dns'
import type { QuotaSourceConfig } from '../../config-schema'

export type QuotaSourceFetchResult =
  | { ok: true; response: Response }
  | { ok: false; error: string }

export type QuotaAddressResolver = (hostname: string) => Promise<LookupAddress[]>
const defaultResolver: QuotaAddressResolver = hostname => dnsLookup(hostname, { all: true, verbatim: true })

const blocked = new BlockList()
const globalUnicast = new BlockList()
globalUnicast.addSubnet('2000::', 3, 'ipv6')
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10],
  ['ff00::', 8], ['2001::', 32], ['2001:2::', 48], ['2001:10::', 28], ['2001:20::', 28],
  ['2001:db8::', 32], ['2002::', 16],
] as const) blocked.addSubnet(network, prefix, 'ipv6')

export function quotaHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '')
}

export function quotaTLSServername(url: URL): string | undefined {
  const hostname = quotaHostname(url)
  return url.protocol === 'https:' && isIP(hostname) === 0 ? hostname : undefined
}

export function isPublicQuotaAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '')
  const family = isIP(normalized)
  if (family === 6 && normalized.toLowerCase().startsWith('::ffff:')) return false
  if (family === 6) return globalUnicast.check(normalized, 'ipv6') && !blocked.check(normalized, 'ipv6')
  return family === 4 && !blocked.check(normalized, 'ipv4')
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '')
  const family = isIP(normalized)
  return family === 4
    ? blocked.check(normalized, 'ipv4') && normalized.startsWith('127.')
    : family === 6 && normalized === '::1'
}

export async function resolveQuotaAddresses(
  url: URL,
  resolve: QuotaAddressResolver = defaultResolver,
): Promise<LookupAddress[]> {
  const addresses = await resolve(quotaHostname(url))
  if (addresses.length === 0) throw new Error('no addresses')
  const allowLoopback = url.protocol === 'http:'
  if (addresses.some(({ address }) => allowLoopback ? !isLoopbackAddress(address) : !isPublicQuotaAddress(address))) {
    throw new Error('unsafe address')
  }
  return addresses
}

export function pinnedLookup(addresses: readonly LookupAddress[]) {
  return (
    _hostname: string,
    options: { all?: boolean } | number,
    callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    if (typeof options === 'object' && options.all) {
      callback(null, addresses.map(address => ({ ...address })))
      return
    }
    const selected = addresses[0]!
    callback(null, selected.address, selected.family)
  }
}

async function requestPinned(
  url: URL,
  headers: Record<string, string>,
  addresses: readonly LookupAddress[],
): Promise<Response> {
  const request = url.protocol === 'http:' ? httpRequest : httpsRequest
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, {
      method: 'GET',
      headers,
      lookup: pinnedLookup(addresses),
      servername: quotaTLSServername(url),
      timeout: 10_000,
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode ?? 500,
        headers: response.headers as HeadersInit,
      })))
      response.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

export interface QuotaSourceTransport {
  resolve?: QuotaAddressResolver
  request?: typeof requestPinned
}

export async function fetchQuotaSource(
  source: QuotaSourceConfig,
  providerHeaders: Record<string, string> = {},
  transport: QuotaSourceTransport = {},
): Promise<QuotaSourceFetchResult> {
  const apiKey = process.env[source.apiKeyEnv]?.trim()
  if (!apiKey) return { ok: false, error: `API key environment variable ${source.apiKeyEnv} is not set` }
  try {
    const url = new URL(source.url)
    const addresses = await resolveQuotaAddresses(url, transport.resolve)
    const response = await (transport.request ?? requestPinned)(url, {
      ...providerHeaders,
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'tokmon',
    }, addresses)
    return { ok: true, response }
  } catch {
    return { ok: false, error: 'Network error' }
  }
}
