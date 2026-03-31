# Self-Healing Playwright Framework (Nova Retail)

[![Playwright Tests](https://github.com/mmohan-bayone/SelfHealingPlaywrightFramework/actions/workflows/playwright.yml/badge.svg)](https://github.com/mmohan-bayone/SelfHealingPlaywrightFramework/actions/workflows/playwright.yml)

Self-healing Playwright tests for the Nova Retail login page: `https://retail-website-two.vercel.app/login`.

## Purpose

- **Reduce flaky failures from locator changes** by trying multiple locator strategies (fallbacks) for the same element.
- **Keep tests readable** by hiding healing logic behind page objects.
- **Make debugging easy** by attaching healing details (winning strategy + failures) to the Playwright HTML report.

## How “healing” works (concept)

For each element (Email, Password, Sign in, etc.) we define an **ordered list** of strategies (locators).

When an action runs (fill/click/wait):

- Try strategy 1 → if it succeeds, stop.
- If it fails, try strategy 2 → then strategy 3, etc.
- If all fail, throw one error containing a summary of all failures.

Healing implementation lives in `core/self-healing.ts` and is used by page objects like `pages/login.page.ts`.

## Project structure

- **`core/`**
  - `self-healing.ts`: healing engine (`withHealingPage`) + helpers (`fillHealing`, `clickHealing`, `expectVisibleHealing`)
  - `healing-types.ts`: `LocatorStrategy`, `HealingResult`
  - `healing-reporter.ts`: attaches healing details to the HTML report
- **`pages/`**
  - `login.page.ts`: page object with locator strategy chains for the login page
- **`tests/`**
  - `fixtures.ts`: provides `loginPage` fixture
  - `login.spec.ts`: example tests (page-load + demo customer login)
- **`.github/workflows/`**
  - `playwright.yml`: free GitHub Actions CI for running tests in headless Chromium

## Setup

### Prerequisites

- Node.js **20+**
- npm **9+** (comes with Node)

### Install dependencies

```bash
npm install
```

### Install Playwright browsers

```bash
npm run install:browsers
```

## Execute tests

### Run all tests (headless)

```bash
npm test
```

### Run in headed mode (visible browser)

```bash
npm run test:headed
```

### Run with Playwright UI mode

```bash
npm run test:ui
```

### Run a single spec file

```bash
npx playwright test tests/login.spec.ts
```

### Run a single test by title

```bash
npx playwright test -g "customer demo login"
```

## Reports and artifacts

- **HTML report**: generated at `playwright-report/`
- **Test artifacts** (traces, screenshots, videos on retry): under `test-results/`

Open the report locally:

```bash
npm run report
```

## Demo credentials used in tests

The target login page displays demo users:

- **Customer**: `test@demo.com` / `password123`
- **Admin**: `admin@demo.com` / `admin123`

## Configuration

### Base URL

The Playwright config uses:

- default `BASE_URL`: `https://retail-website-two.vercel.app`
- override with:

```bash
BASE_URL="https://retail-website-two.vercel.app" npm test
```

### Use system Chrome (optional)

If you prefer using an installed Google Chrome instead of Playwright-downloaded Chromium:

```bash
PW_USE_SYSTEM_CHROME=1 npm test
```

## Free, open-source CI (GitHub Actions)

This repo includes a workflow that runs on **push** and **pull requests**:

- installs dependencies (`npm ci`)
- installs Playwright Chromium + OS deps (`npx playwright install --with-deps chromium`)
- runs tests (`npx playwright test`)
- uploads `playwright-report/` as an artifact; uploads `test-results/` (traces/screenshots) when **present**—on an all-green run this folder may not exist, so the workflow uses `if-no-files-found: ignore` for that artifact
- optionally posts JSON results (`playwright-report/results.json`) to a dashboard via `scripts/playwright-report-to-dashboard.mjs` when `DASHBOARD_INGEST_TOKEN` is configured in repo secrets (HTTP requests use `DASHBOARD_FETCH_TIMEOUT_MS`, default **60s**; CI sets **120s** for slow cold starts on free hosts). That step uses **`continue-on-error: true`** so a down or unreachable dashboard API does **not** fail the whole workflow when Playwright tests passed

Reporters are defined in `playwright.config.ts` (including JSON at `playwright-report/results.json`). **Do not** pass `--reporter=...` on the command line in CI unless you repeat the same `outputFile`, or that JSON file will not be created.

Workflow file: `.github/workflows/playwright.yml`

