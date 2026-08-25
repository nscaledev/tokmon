import assert from 'node:assert/strict'
import test from 'node:test'
import type { LookupAddress } from 'node:dns'
import { fetchQuotaSource, isPublicQuotaAddress, pinnedLookup, quotaHostname, quotaTLSServername, resolveQuotaAddresses } from './quota-source'

test('custom quota fetch authenticates against the pre-resolved public address set', async () => {
  const originalSecret = process.env.TOKMON_TEST_PROXY_KEY
  process.env.TOKMON_TEST_PROXY_KEY = 'secret-value'
  let requestAddresses: readonly LookupAddress[] = []
  try {
    const result = await fetchQuotaSource(
      { url: 'https://proxy.example/api/oauth/usage', apiKeyEnv: 'TOKMON_TEST_PROXY_KEY' },
      { 'anthropic-beta': 'oauth-2025-04-20' },
      {
        resolve: async () => [{ address: '8.8.8.8', family: 4 }],
        request: async (_url, headers, addresses) => {
          requestAddresses = addresses
          assert.equal(headers.Authorization, 'Bearer secret-value')
          assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20')
          return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
        },
      },
    )
    assert.equal(result.ok, true)
    assert.deepEqual(requestAddresses, [{ address: '8.8.8.8', family: 4 }])
  } finally {
    if (originalSecret === undefined) delete process.env.TOKMON_TEST_PROXY_KEY
    else process.env.TOKMON_TEST_PROXY_KEY = originalSecret
  }
})

test('custom quota fetch does not make a request when its secret is missing', async () => {
  delete process.env.TOKMON_TEST_MISSING_KEY
  const result = await fetchQuotaSource({
    url: 'https://proxy.example/backend-api/wham/usage', apiKeyEnv: 'TOKMON_TEST_MISSING_KEY',
  }, {}, { request: async () => assert.fail('request must not run without the configured secret') })
  assert.deepEqual(result, { ok: false, error: 'API key environment variable TOKMON_TEST_MISSING_KEY is not set' })
})

test('quota address policy rejects private, link-local, metadata, unspecified, and multicast addresses', () => {
  for (const address of [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '224.0.0.1',
    '::', '::1', '100::1', 'fd00::1', 'fe80::1', 'fec0::1', 'ff02::1',
    '2001::1', '2001:2::1', '2001:10::1', '2001:20::1', '2001:db8::1', '2002:0808:0808::1',
  ]) {
    assert.equal(isPublicQuotaAddress(address), false, address)
  }
  assert.equal(isPublicQuotaAddress('8.8.8.8'), true)
  assert.equal(isPublicQuotaAddress('2606:4700:4700::1111'), true)
})

test('IPv6 URL brackets never reach address checks or TLS SNI', () => {
  const literal = new URL('https://[2606:4700:4700::1111]/api/oauth/usage')
  assert.equal(quotaHostname(literal), '2606:4700:4700::1111')
  assert.equal(quotaTLSServername(literal), undefined)
  assert.equal(isPublicQuotaAddress('[2606:4700:4700::1111]'), true)
  assert.equal(quotaTLSServername(new URL('https://proxy.example/api/oauth/usage')), 'proxy.example')
})

test('public hostnames that resolve to a private address are rejected before request', async () => {
  await assert.rejects(
    resolveQuotaAddresses(new URL('https://proxy.example/api/oauth/usage'), async () => [{ address: '169.254.169.254', family: 4 }]),
    /unsafe address/,
  )
  await assert.rejects(
    resolveQuotaAddresses(new URL('https://169.254.169.254/api/oauth/usage'), async () => [{ address: '169.254.169.254', family: 4 }]),
    /unsafe address/,
  )
})

test('the connection lookup stays pinned if DNS changes after validation', async () => {
  const addresses: LookupAddress[] = [{ address: '8.8.8.8', family: 4 }]
  const lookup = pinnedLookup(addresses)
  const selected = await new Promise<{ address: string; family: number }>((resolve, reject) => {
    lookup('proxy.example', {}, (error, address, family) => {
      if (error) reject(error)
      else resolve({ address: address as string, family: family! })
    })
  })
  assert.deepEqual(selected, { address: '8.8.8.8', family: 4 })
})

test('plain HTTP accepts only addresses that resolve entirely to loopback', async () => {
  assert.deepEqual(
    await resolveQuotaAddresses(new URL('http://localhost/api/oauth/usage'), async () => [
      { address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 },
    ]),
    [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }],
  )
  await assert.rejects(
    resolveQuotaAddresses(new URL('http://localhost/api/oauth/usage'), async () => [
      { address: '127.0.0.1', family: 4 }, { address: '10.0.0.1', family: 4 },
    ]),
    /unsafe address/,
  )
})
