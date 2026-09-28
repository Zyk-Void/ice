// -----------------------------------------------------------------------------
// Curax Agent turn checkpoints.
//
// The extension runs beside Pi on the workspace's owning host, so the same
// logic works for local, SSH, and WSL runtimes. It mirrors Void Desktop's
// non-mutating temporary-index snapshot: the real worktree and Git index are
// never staged, reset, stashed, or otherwise changed.
// -----------------------------------------------------------------------------

import { isUtf8 } from 'node:buffer'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, copyFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ExtensionAPI } from '@zykairotis/ice-coding-agent'

const execFileAsync = promisify(execFile)
// Keep these values and the entry identifier in sync with
// src/shared/codingTurnDiff.ts.
const TURN_DIFF_ENTRY = 'cate-turn-diff'
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_TEXT_BLOB_BYTES = 512 * 1024
const MAX_TOTAL_PREVIEW_BYTES = 2 * 1024 * 1024
const MAX_PREVIEW_FILES = 50
const SNAPSHOT_LOCK_REF = 'refs/cate/locks/turn-diff'
const SNAPSHOT_LOCK_RETRY_MS = 50
const SNAPSHOT_LOCK_TIMEOUT_MS = 2 * 60 * 1000
const SNAPSHOT_PROCESS_TOKEN = `${process.pid}:${randomUUID()}`

type GitResult = {
  code: number
  stdout: string
  stderr: string
}

type GitError = {
  code?: number | string
  stdout?: string | Buffer
  stderr?: string | Buffer
}

type GitRunner = (
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => Promise<GitResult>

async function runGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  try {
    const result = await execFileAsync(
      'git',
      ['-C', cwd, ...args],
      { cwd, env, maxBuffer: MAX_OUTPUT_BYTES },
    )
    return {
      code: 0,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    }
  } catch (error) {
    const failure = error as GitError
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? ''),
    }
  }
}

async function runGitBuffer(
  cwd: string,
  args: string[],
  maxBuffer: number,
): Promise<{ code: number; stdout: Buffer }> {
  try {
    const result = await execFileAsync(
      'git',
      ['-C', cwd, ...args],
      { cwd, maxBuffer, encoding: 'buffer' },
    )
    return {
      code: 0,
      stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout ?? '')),
    }
  } catch (error) {
    const failure = error as GitError
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: Buffer.isBuffer(failure.stdout)
        ? failure.stdout
        : Buffer.from(String(failure.stdout ?? '')),
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Serialize expensive snapshots through Git's atomic compare-and-swap refs. */
export async function withSnapshotLock<T>(
  commonDir: string,
  task: () => Promise<T>,
  runGitFn: GitRunner = runGit,
): Promise<T | null> {
  const ownerFile = path.join(commonDir, `cate-turn-diff-owner-${randomUUID()}`)
  let ownerObject: string
  try {
    await writeFile(ownerFile, SNAPSHOT_PROCESS_TOKEN)
    const ownerResult = await runGitFn(commonDir, ['hash-object', '-w', ownerFile])
    ownerObject = ownerResult.stdout.trim()
    if (ownerResult.code !== 0 || !isObjectId(ownerObject)) return null
  } finally {
    await rm(ownerFile, { force: true }).catch(() => {})
  }

  const zeroObject = '0'.repeat(ownerObject.length)
  const deadline = Date.now() + SNAPSHOT_LOCK_TIMEOUT_MS
  const waitForRetry = () => new Promise<void>((resolve) => {
    setTimeout(resolve, SNAPSHOT_LOCK_RETRY_MS)
  })

  while (Date.now() < deadline) {
    const acquired = await runGitFn(commonDir, [
      'update-ref',
      SNAPSHOT_LOCK_REF,
      ownerObject,
      zeroObject,
    ])
    if (acquired.code === 0) {
      try {
        return await task()
      } finally {
        await runGitFn(commonDir, ['update-ref', '-d', SNAPSHOT_LOCK_REF, ownerObject])
      }
    }

    const currentResult = await runGitFn(commonDir, [
      'rev-parse',
      '--verify',
      '--quiet',
      SNAPSHOT_LOCK_REF,
    ])
    const currentObject = currentResult.stdout.trim()
    if (currentResult.code !== 0 || !isObjectId(currentObject)) {
      await waitForRetry()
      continue
    }

    const ownerResult = await runGitFn(commonDir, ['cat-file', 'blob', currentObject])
    const currentOwner = ownerResult.stdout.trim()
    const ownerPid = Number.parseInt(currentOwner.split(':', 1)[0] ?? '', 10)
    const abandoned = ownerResult.code !== 0 || !Number.isSafeInteger(ownerPid) || ownerPid <= 0 ||
      (ownerPid === process.pid
        ? currentOwner !== SNAPSHOT_PROCESS_TOKEN
        : !processIsAlive(ownerPid))
    if (abandoned) {
      // The expected old value makes cleanup safe if ownership changed meanwhile.
      await runGitFn(commonDir, ['update-ref', '-d', SNAPSHOT_LOCK_REF, currentObject])
      await waitForRetry()
      continue
    }

    await waitForRetry()
  }

  return null
}

/** Capture the current filesystem tree in a detached Git commit. */
export async function captureSnapshot(cwd: string): Promise<string | null> {
  const commonDirResult = await runGit(cwd, ['rev-parse', '--git-common-dir'])
  if (commonDirResult.code !== 0) return null
  const rawCommonDir = commonDirResult.stdout.trim()
  if (!rawCommonDir) return null

  const commonDir = path.isAbsolute(rawCommonDir)
    ? rawCommonDir
    : path.resolve(cwd, rawCommonDir)

  return withSnapshotLock(commonDir, async () => {
    const tempIndexPath = path.join(commonDir, `cate-turn-diff-index-${randomUUID()}`)
    try {
      const commitEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_INDEX_FILE: tempIndexPath,
        GIT_AUTHOR_NAME: 'Curax',
        GIT_AUTHOR_EMAIL: 'curax@users.noreply.github.com',
        GIT_COMMITTER_NAME: 'Curax',
        GIT_COMMITTER_EMAIL: 'curax@users.noreply.github.com',
      }

      // Preserve Git's stat cache so `git add -A` only hashes changed content.
      const indexResult = await runGit(cwd, ['rev-parse', '--git-path', 'index'])
      const rawIndexPath = indexResult.stdout.trim()
      let seededFromIndex = false
      if (indexResult.code === 0 && rawIndexPath) {
        const indexPath = path.isAbsolute(rawIndexPath)
          ? rawIndexPath
          : path.resolve(cwd, rawIndexPath)
        seededFromIndex = await copyFile(indexPath, tempIndexPath)
          .then(() => true)
          .catch(() => false)
      }

      if (!seededFromIndex) {
        const headResult = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
        if (headResult.code === 0) {
          const readTreeResult = await runGit(cwd, ['read-tree', 'HEAD'], commitEnv)
          if (readTreeResult.code !== 0) return null
        }
      }

      const addResult = await runGit(cwd, ['add', '-A', '--', '.'], commitEnv)
      if (addResult.code !== 0) return null

      const treeResult = await runGit(cwd, ['write-tree'], commitEnv)
      if (treeResult.code !== 0) return null
      const tree = treeResult.stdout.trim()
      if (!tree) return null

      const commitResult = await runGit(
        cwd,
        ['commit-tree', tree, '-m', 'Curax turn checkpoint'],
        commitEnv,
      )
      if (commitResult.code !== 0) return null
      const commit = commitResult.stdout.trim()
      return commit || null
    } catch {
      return null
    } finally {
      await Promise.all([
        rm(tempIndexPath, { force: true }).catch(() => {}),
        rm(`${tempIndexPath}.lock`, { force: true }).catch(() => {}),
      ])
    }
  })
}

function lineCount(value: string): number {
  if (value === '-') return 0
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : 0
}

type TurnDiffFile = {
  path: string
  kind: string
  additions: number
  deletions: number
  before?: string
  after?: string
  previewUnavailable?: boolean
  previewUnavailableReason?: 'binary' | 'too-large' | 'unavailable'
}

type RawDiffFile = {
  path: string
  status: string
  oldObject: string
  newObject: string
}

/** Parse Git's NUL-delimited --numstat output, including rename records. */
export function parseNumstat(output: string): TurnDiffFile[] {
  const tokens = output.split('\0')
  const files: TurnDiffFile[] = []

  for (let index = 0; index < tokens.length;) {
    const header = tokens[index++] ?? ''
    if (!header) continue
    const firstTab = header.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : header.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue

    let filePath = header.slice(secondTab + 1)
    if (!filePath) {
      // With -z, Git emits a rename as: stats, NUL, old-path, NUL, new-path.
      index += 1
      filePath = tokens[index++] ?? ''
    }
    if (!filePath) continue

    files.push({
      path: filePath,
      kind: 'modified',
      additions: lineCount(header.slice(0, firstTab)),
      deletions: lineCount(header.slice(firstTab + 1, secondTab)),
    })
  }

  return files.sort((left, right) => left.path.localeCompare(right.path))
}

/** Parse Git's NUL-delimited --raw output so previews come from snapshot blobs. */
export function parseRawDiff(output: string): RawDiffFile[] {
  const tokens = output.split('\0')
  const files: RawDiffFile[] = []
  for (let index = 0; index < tokens.length;) {
    const header = tokens[index++] ?? ''
    if (!header) continue
    const match = header.match(/^:\S+ \S+ (\S+) (\S+) (\S+)$/)
    if (!match) continue
    const status = match[3] ?? ''
    let filePath = tokens[index++] ?? ''
    if (status.startsWith('R') || status.startsWith('C')) {
      filePath = tokens[index++] ?? ''
    }
    if (!filePath) continue
    files.push({
      path: filePath,
      status: status.slice(0, 1) || 'M',
      oldObject: match[1] ?? '',
      newObject: match[2] ?? '',
    })
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function isObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) && !/^0+$/.test(value)
}

function kindForStatus(status: string): string {
  switch (status) {
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    default: return 'modified'
  }
}

type SnapshotTextResult =
  | { kind: 'missing' }
  | { kind: 'unavailable'; reason: 'binary' | 'too-large' | 'unavailable' }
  | { kind: 'text'; text: string; bytes: number }

async function readSnapshotText(
  cwd: string,
  objectId: string,
  remainingBytes: number,
): Promise<SnapshotTextResult> {
  if (/^0+$/.test(objectId)) return { kind: 'missing' }
  if (!isObjectId(objectId)) return { kind: 'unavailable', reason: 'unavailable' }
  if (remainingBytes <= 0) return { kind: 'unavailable', reason: 'too-large' }
  const result = await runGitBuffer(
    cwd,
    ['cat-file', 'blob', objectId],
    Math.min(MAX_TEXT_BLOB_BYTES + 1, remainingBytes + 1),
  )
  if (result.code !== 0) return { kind: 'unavailable', reason: 'unavailable' }
  const content = result.stdout
  if (content.byteLength > MAX_TEXT_BLOB_BYTES || content.byteLength > remainingBytes) {
    return { kind: 'unavailable', reason: 'too-large' }
  }
  if (content.includes(0) || !isUtf8(content)) {
    return { kind: 'unavailable', reason: 'binary' }
  }
  return { kind: 'text', text: content.toString('utf8'), bytes: content.byteLength }
}

async function diffSnapshots(
  cwd: string,
  before: string,
  after: string,
): Promise<TurnDiffFile[]> {
  const result = await runGit(cwd, [
    '--no-pager',
    'diff',
    '--numstat',
    '-z',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    before,
    after,
    '--',
  ])
  if (result.code !== 0) return []

  const files = parseNumstat(result.stdout)
  const rawResult = await runGit(cwd, [
    '--no-pager',
    'diff',
    '--raw',
    '--no-abbrev',
    '-z',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    before,
    after,
    '--',
  ])
  const rawByPath = new Map(
    (rawResult.code === 0 ? parseRawDiff(rawResult.stdout) : [])
      .map((file) => [file.path, file] as const),
  )

  let totalPreviewBytes = 0
  const enriched: TurnDiffFile[] = []
  for (const [fileIndex, file] of files.entries()) {
    const raw = rawByPath.get(file.path)
    const previewLimitReached = fileIndex >= MAX_PREVIEW_FILES
    let beforeText: string | undefined
    let afterText: string | undefined
    let filePreviewBytes = 0
    let previewAvailable = raw !== undefined && !previewLimitReached
    let previewUnavailableReason: 'binary' | 'too-large' | 'unavailable' | undefined = raw && !previewLimitReached
      ? undefined
      : previewLimitReached ? 'too-large' : 'unavailable'
    if (raw && !previewLimitReached) {
      const oldPreview = await readSnapshotText(
        cwd,
        raw.oldObject,
        MAX_TOTAL_PREVIEW_BYTES - totalPreviewBytes,
      )
      if (oldPreview.kind === 'text') {
        beforeText = oldPreview.text
        filePreviewBytes += oldPreview.bytes
      } else if (oldPreview.kind === 'unavailable') {
        previewAvailable = false
        previewUnavailableReason ??= oldPreview.reason
      }

      const newPreview = await readSnapshotText(
        cwd,
        raw.newObject,
        MAX_TOTAL_PREVIEW_BYTES - totalPreviewBytes - filePreviewBytes,
      )
      if (newPreview.kind === 'text') {
        afterText = newPreview.text
        filePreviewBytes += newPreview.bytes
      } else if (newPreview.kind === 'unavailable') {
        previewAvailable = false
        previewUnavailableReason ??= newPreview.reason
      }
    }
    if (!previewAvailable) {
      beforeText = undefined
      afterText = undefined
      filePreviewBytes = 0
    } else {
      totalPreviewBytes += filePreviewBytes
    }
    enriched.push({
      ...file,
      ...(raw ? { kind: kindForStatus(raw.status) } : {}),
      ...(beforeText !== undefined ? { before: beforeText } : {}),
      ...(afterText !== undefined ? { after: afterText } : {}),
      ...(!previewAvailable
        ? {
            previewUnavailable: true,
            previewUnavailableReason: previewUnavailableReason ?? 'unavailable',
          }
        : {}),
    })
  }
  return enriched
}

export const CHANGES_SIDECAR_SUFFIX = '.cate-changes-v1.jsonl'

export function sidecarPathForSession(sessionFile: string): string {
  return `${sessionFile}${CHANGES_SIDECAR_SUFFIX}`
}

export async function writeSidecarRecord(
  sessionFile: string,
  entryId: string,
  files: TurnDiffFile[],
  createdAt = Date.now(),
): Promise<void> {
  try {
    const sidecarPath = sidecarPathForSession(sessionFile)
    const summaryFiles = files.map((file) => ({
      path: file.path,
      kind: file.kind,
      additions: file.additions,
      deletions: file.deletions,
      previewUnavailable: file.previewUnavailable === true || (file.before === undefined && file.after === undefined),
      ...(file.previewUnavailableReason ? { previewUnavailableReason: file.previewUnavailableReason } : {}),
    }))
    const totals = summaryFiles.reduce(
      (acc, f) => ({
        files: acc.files + 1,
        additions: acc.additions + f.additions,
        deletions: acc.deletions + f.deletions,
      }),
      { files: 0, additions: 0, deletions: 0 },
    )
    const sourceSize = await stat(sessionFile).then((value) => value.size).catch(() => undefined)
    const record = {
      version: 1,
      entryId,
      createdAt,
      ...(sourceSize !== undefined ? { sourceSize } : {}),
      totals,
      files: summaryFiles,
    }
    await appendFile(sidecarPath, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // Sidecar write is best-effort acceleration and must never fail an agent turn.
  }
}

export default function (pi: ExtensionAPI) {
  // undefined = no active run; null = active run in a non-Git/unavailable cwd.
  let baseline: string | null | undefined

  pi.on('session_start', () => {
    baseline = undefined
  })

  pi.on('agent_start', async (_event, ctx) => {
    // Retries and queued work belong to the same outer agent run. Keep the
    // first snapshot until the authoritative agent_settled event.
    if (baseline !== undefined) return
    baseline = await captureSnapshot(ctx.cwd)
  })

  pi.on('agent_settled', async (_event, ctx) => {
    const before = baseline
    baseline = undefined
    if (!before) return

    const after = await captureSnapshot(ctx.cwd)
    if (!after) return
    const files = await diffSnapshots(ctx.cwd, before, after)
    if (files.length === 0) return

    // Custom entries persist in Pi's JSONL but do not enter the next LLM
    // context. Curax consumes the entry both live and when reloading a chat.
    // The public ExtensionAPI types currently say void, while Pi's runtime
    // returns the authoritative entry id from SessionManager. Prefer that
    // return value and verify it through the leaf fallback before writing the
    // disposable sidecar; never invent an id that could point at another entry.
    const appendResult = (pi.appendEntry as unknown as (customType: string, data: unknown) => unknown)(
      TURN_DIFF_ENTRY,
      { files },
    )

    try {
      const ctxAny = ctx as unknown as {
        sessionManager?: {
          getLeafId?: () => string
          getSessionFile?: () => string
          getLeafEntry?: () => { timestamp?: string }
        }
      }
      const sessionFile = ctxAny?.sessionManager?.getSessionFile?.()
      const entryId = typeof appendResult === 'string' && appendResult
        ? appendResult
        : ctxAny?.sessionManager?.getLeafId?.()
      if (sessionFile && entryId) {
        const timestamp = ctxAny?.sessionManager?.getLeafEntry?.()?.timestamp
        const createdAt = timestamp ? Date.parse(timestamp) : NaN
        await writeSidecarRecord(
          sessionFile,
          entryId,
          files,
          Number.isFinite(createdAt) ? createdAt : Date.now(),
        )
      }
    } catch {
      // Best-effort sidecar record
    }
  })
}
