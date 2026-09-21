import { basename } from 'node:path'
import { collectSessionFiles } from '../usage-core'
import { readJsonLines } from './jsonl'

export async function sessionFiles(roots: string[], provider: 'claude' | 'codex', sessionId: string): Promise<string[]> {
  const files = await collectSessionFiles(roots, path => {
    const name = basename(path)
    return name === `${sessionId}.jsonl`
      || (provider === 'codex' && name.startsWith('rollout-') && name.endsWith(`-${sessionId}.jsonl`))
  }, 0, { ignoreReadErrors: false })
  for (const { path } of files) {
    let identity: unknown
    for await (const row of readJsonLines(path, undefined, { ignoreReadErrors: false })) {
      identity = provider === 'claude' ? row.sessionId : row.type === 'session_meta' ? row.payload?.id : undefined
      if (typeof identity === 'string') break
    }
    if (identity !== sessionId) throw new Error('Transcript identity does not match the requested session')
  }
  return files.map(file => file.path)
}
