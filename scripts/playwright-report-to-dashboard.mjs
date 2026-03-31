#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'

const dashboardUrl = (process.env.DASHBOARD_URL || '').replace(/\/$/, '')
const token = process.env.DASHBOARD_INGEST_TOKEN || ''
const reportPath = process.argv[2]

function getDashboardFetchTimeoutMs() {
  return Math.min(
    Math.max(Number(process.env.DASHBOARD_FETCH_TIMEOUT_MS) || 60_000, 5_000),
    300_000
  )
}

/** Node fetch often throws TypeError: fetch failed with the real reason on error.cause */
function describeFetchError(e) {
  const c = e?.cause
  if (!c) return e?.message || String(e)
  const bits = [c.code, c.errno, c.syscall, c.hostname, c.address, c.port].filter(Boolean)
  const detail = bits.length ? ` (${bits.join(' ')})` : ''
  return `${e.message}${detail}: ${c.message || c}`
}

function mapStatus(playwrightStatus) {
  switch (playwrightStatus) {
    case 'passed':
      return 'PASSED'
    case 'failed':
    case 'timedOut':
    case 'interrupted':
      return 'FAILED'
    case 'skipped':
      return 'SKIPPED'
    default:
      return 'FAILED'
  }
}

function collectTests(suite, titlePath, fileHint, out) {
  const file = suite.file || fileHint
  const nextPath = suite.title ? [...titlePath, suite.title] : titlePath

  for (const t of suite.tests || []) {
    const last = (t.results && t.results[0]) || {}
    const status = mapStatus(last.status || 'failed')
    const durationMs = Math.round(Number(last.duration) || 0)
    const name = nextPath.length > 0 ? `${nextPath.join(' › ')} › ${t.title}` : t.title
    const module = file ? basename(file).replace(/\.(spec|test)\.[tj]s$/, '') : 'Playwright'
    out.push({ name, module, status, duration_ms: durationMs })
  }

  for (const s of suite.suites || []) {
    collectTests(s, nextPath, file, out)
  }
}

async function main() {
  if (!reportPath) throw new Error('Usage: node scripts/playwright-report-to-dashboard.mjs <report.json>')
  if (!dashboardUrl) throw new Error('Missing DASHBOARD_URL')
  if (!token) {
    console.log('Skipping dashboard ingest: DASHBOARD_INGEST_TOKEN is not set.')
    return
  }
  if (!existsSync(reportPath)) {
    throw new Error(
      `Report file not found: ${reportPath}. Ensure Playwright JSON reporter wrote this path ` +
        `(see playwright.config.ts). Avoid overriding reporters on the CLI without the same json outputFile.`
    )
  }

  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const testCases = []
  for (const root of report.suites || []) collectTests(root, [], root.file || '', testCases)

  const body = {
    suite_name: process.env.SUITE_NAME || 'Playwright CI',
    environment: process.env.ENVIRONMENT || 'CI',
    build_version: process.env.BUILD_VERSION || process.env.GITHUB_SHA || 'local',
    test_cases: testCases,
  }

  const timeoutMs = getDashboardFetchTimeoutMs()
  const signal = AbortSignal.timeout(timeoutMs)

  const url = `${dashboardUrl}/api/ingest/github-actions/run`
  console.log(`POST ${url} (timeout ${timeoutMs}ms, ${testCases.length} test case(s))`)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Ingest-Token': token,
    },
    body: JSON.stringify(body),
    signal,
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`)
  console.log(text)
}

main().catch((e) => {
  const isTimeout =
    e?.name === 'TimeoutError' ||
    e?.name === 'AbortError' ||
    e?.cause?.name === 'TimeoutError'
  if (isTimeout) {
    console.error(
      `Request timed out after ${getDashboardFetchTimeoutMs()}ms. Check ${dashboardUrl || '(DASHBOARD_URL)'} / API availability (cold starts on free tiers can be slow; raise DASHBOARD_FETCH_TIMEOUT_MS).`
    )
  } else {
    console.error(describeFetchError(e))
    if (e?.cause) console.error('cause:', e.cause)
  }
  process.exit(1)
})