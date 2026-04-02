#!/usr/bin/env node
/**
 * Reads Playwright JSON report and POSTs to /api/ingest/github-actions/run
 *
 * Playwright JSON format nests tests under `specs` (suite.specs[].tests[]).
 * Older formats may use suite.tests[] directly — we handle both.
 */
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
const dashboardUrl = (process.env.DASHBOARD_URL || '').replace(/\/$/, '')
const token = process.env.DASHBOARD_INGEST_TOKEN || ''
const reportPath = process.argv[2]
const timeoutMs = Number(process.env.DASHBOARD_FETCH_TIMEOUT_MS || 180000)
const maxAttempts = Math.max(1, Number(process.env.DASHBOARD_POST_RETRIES || 4))
const retryDelayMs = Number(process.env.DASHBOARD_POST_RETRY_DELAY_MS || 8000)
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
/**
 * Emit dashboard test cases from a Playwright JSON `test` object.
 */
function emitTestCasesFromTest(t, titlePath, file, out) {
  const last = (t.results && t.results[0]) || {}
  const status = mapStatus(last.status || 'failed')
  const durationMs = Math.round(Number(last.duration) || 0)
  const name =
    titlePath.length > 0 ? `${titlePath.join(' › ')} › ${t.title}` : t.title
  const module = file
    ? basename(file).replace(/\.(spec|test)\.[tj]s$/, '')
    : 'Playwright'
  out.push({ name, module, status, duration_ms: durationMs })
}
function collectFromSuite(suite, titlePath, fileHint, out) {
  const file = suite.file || fileHint
  const nextPath = suite.title ? [...titlePath, suite.title] : titlePath
  // Newer Playwright JSON: suite.specs[].tests[]
  for (const spec of suite.specs || []) {
    for (const t of spec.tests || []) {
      emitTestCasesFromTest(t, nextPath, file, out)
    }
  }
  // Older/alternate: suite.tests[] directly on the suite
  for (const t of suite.tests || []) {
    emitTestCasesFromTest(t, nextPath, file, out)
  }
  for (const s of suite.suites || []) {
    collectFromSuite(s, nextPath, file, out)
  }
}
function shouldRetryHttp(status) {
  return status === 502 || status === 503 || status === 504
}
async function postIngest(url, body) {
  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined
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
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text}`)
    err.status = res.status
    throw err
  }
  return text
}
async function postWithRetries(url, body) {
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await postIngest(url, body)
    } catch (e) {
      lastErr = e
      const aborted =
        e.name === 'AbortError' ||
        e.name === 'TimeoutError' ||
        (e.cause && String(e.cause).includes('aborted'))
      const httpRetry = e.status && shouldRetryHttp(e.status)
      const canRetry = attempt < maxAttempts && (aborted || httpRetry)
      console.warn(
        `[dashboard] POST attempt ${attempt}/${maxAttempts} failed: ${e.message || e} ` +
          `(timeout ${timeoutMs}ms per attempt, ${body.test_cases?.length ?? 0} test case(s))`,
      )
      if (!canRetry) {
        throw e
      }
      console.warn(
        `[dashboard] Retrying in ${retryDelayMs}ms (Render cold starts on free tier can exceed one timeout).`,
      )
      await sleep(retryDelayMs)
    }
  }
  throw lastErr
}
async function main() {
  if (!reportPath) {
    console.error('Usage: node playwright-report-to-dashboard.mjs <report.json>')
    process.exit(1)
  }
  if (!dashboardUrl) {
    console.error('Missing DASHBOARD_URL')
    process.exit(1)
  }
  if (!token) {
    console.error('Missing DASHBOARD_INGEST_TOKEN')
    process.exit(1)
  }
  let st
  try {
    st = statSync(reportPath)
  } catch {
    console.error(`Report file not found: ${reportPath}`)
    process.exit(1)
  }
  if (!st.isFile() || st.size === 0) {
    console.error(`Report file missing or empty: ${reportPath}`)
    process.exit(1)
  }
  const raw = readFileSync(reportPath, 'utf8')
  const report = JSON.parse(raw)
  const testCases = []
  for (const root of report.suites || []) {
    collectFromSuite(root, [], root.file || '', testCases)
  }
  if (testCases.length === 0) {
    console.warn(
      '[dashboard] Parsed 0 tests from JSON. Expected suite.specs[].tests[] or suite.tests[]. ' +
        'Ensure playwright.config.ts includes e.g. ["json",{outputFile:"playwright-report/results.json"}].',
    )
  }
  const body = {
    suite_name: process.env.SUITE_NAME || 'Playwright CI',
    environment: process.env.ENVIRONMENT || 'CI',
    build_version:
      process.env.BUILD_VERSION ||
      process.env.GITHUB_SHA ||
      process.env.GITHUB_REF_NAME ||
      'local',
    test_cases: testCases,
  }
  const url = `${dashboardUrl}/api/ingest/github-actions/run`
  const out = await postWithRetries(url, body)
  console.log(out)
}
main().catch((e) => {
  console.error(e.message || e)
  process.exit(1)
})