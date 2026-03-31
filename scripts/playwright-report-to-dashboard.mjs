#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'

const dashboardUrl = (process.env.DASHBOARD_URL || '').replace(/\/$/, '')
const token = process.env.DASHBOARD_INGEST_TOKEN || ''
const reportPath = process.argv[2]

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
  if (!token) throw new Error('Missing DASHBOARD_INGEST_TOKEN')
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

  const res = await fetch(`${dashboardUrl}/api/ingest/github-actions/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Ingest-Token': token,
    },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`)
  console.log(text)
}

main().catch((e) => {
  console.error(e.message || e)
  process.exit(1)
})