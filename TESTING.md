# Testing Guide

## Folder Structure

```
tests/
├── unit/               # 14 suites, ~350 tests
│   ├── aiService.test.js
│   ├── calendarService.test.js
│   ├── chatLogger.test.js
│   ├── dateParsingEdgeCases.test.js
│   ├── dateTimeService.test.js
│   ├── dateTimeUtils.test.js
│   ├── dbChatLogger.test.js
│   ├── distanceMatrixService.test.js
│   ├── emailNotifier.test.js
│   ├── helpers.test.js
│   ├── mapsService.test.js
│   ├── refreshWhatsappToken.test.js
│   ├── timezoneUtils.test.js
│   └── userDetailsService.test.js
├── integration/        # 9 suites, ~250 tests
│   ├── bookingsRoute.test.js
│   ├── calendarIntegrity.test.js
│   ├── generalFlow.test.js
│   ├── multiInstructor.test.js
│   ├── pickupDropoff.test.js
│   ├── responseTime.test.js
│   ├── routeOptimizer.test.js
│   ├── tonality.test.js
│   └── vulgarMessages.test.js
├── e2e/                # 9 suites — real API calls (NOT in CI)
│   ├── helpers.js
│   ├── bookingFlow.e2e.test.js
│   ├── conversationStress.e2e.test.js
│   ├── dateExtraction.e2e.test.js
│   ├── fullBookingFlow.e2e.test.js
│   ├── geocoding.e2e.test.js
│   ├── responseTime.e2e.test.js
│   ├── routeOptimizer.e2e.test.js
│   ├── tonality.e2e.test.js
│   ├── userDetails.e2e.test.js
│   └── vulgarMessages.e2e.test.js
├── BulkTest.js
└── TestPlan.txt
```

## Commands

| Command | What it does |
|---------|-------------|
| `npm test` | Run all tests |
| `npm run test:unit` | Run unit tests only |
| `npm run test:integration` | Run integration tests only |
| `npm run test:route` | Run route optimizer tests only |
| `npm run test:coverage` | Run all tests with coverage report |
| `npm run test:e2e` | Run e2e tests (requires `GOOGLE_AI_API_KEY`) |

## Checking Coverage

### 1. Generate the report

```bash
npm run test:coverage
```

This runs all tests and generates:
- A **terminal summary** with % coverage per file
- An **HTML report** at `coverage/lcov-report/index.html`

### 2. View in browser

Option A — open the file directly:
```bash
# Windows
start coverage/lcov-report/index.html

# macOS
open coverage/lcov-report/index.html
```

Option B — serve it locally:
```bash
npx serve coverage/lcov-report -l 9090
```
Then open [http://localhost:9090](http://localhost:9090)

### 3. Reading the report

- **Green** = covered by tests
- **Yellow** = partially covered (some branches missed)
- **Red** = not covered
- Click any file to see **line-by-line** highlighting

## Coverage Targets

| Metric | Target | Current |
|--------|--------|---------|
| Statements | >80% | ~60% |
| Branches | >75% | ~55% |
| Functions | >80% | ~65% |
| Lines | >80% | ~60% |

## E2E Tests (Real Gemini API)

E2E tests call the **real Gemini API** — they are excluded from `npm test` and CI.

### Setup

Make sure your `.env` file has:
```
GOOGLE_AI_API_KEY=your-actual-api-key
GOOGLE_MAPS_API_KEY=your-actual-maps-key
```

### Run

```bash
npm run test:e2e
```

### What they test

| Suite | What it verifies |
|-------|------------------|
| `vulgarMessages.e2e` | Gemini deflects vulgar/dodgy messages, rejects prompt injection |
| `tonality.e2e` | Friendly tone, professional responses, stays on topic |
| `bookingFlow.e2e` | Correct ACTION tags, date/time extraction, 24h format |
| `fullBookingFlow.e2e` | Multi-turn booking, cancel, reschedule, show bookings, dynamic dropoff, weekend/past rejection |
| `conversationStress.e2e` | Long messages, emojis, typos, contradictions, topic switching, long context |
| `dateExtraction.e2e` | 12h→24h conversion, YYYY-MM-DD format, day-of-week, colloquial times, invalid hours |
| `geocoding.e2e` | Real postcode → lat/lng, UK bounds, nearby/far validation |
| `userDetails.e2e` | User onboarding flow, postcode geocoding, link generation |
| `responseTime.e2e` | Real API latency (< 10s per call, < 8s average) |
| `routeOptimizer.e2e` | Real Distance Matrix durations, multi-user slot ranking |

### Notes

- These tests hit real APIs — they cost tokens and may be rate-limited
- Gemini tests auto-skip if `GOOGLE_AI_API_KEY` is not set
- Route optimizer tests auto-skip if `GOOGLE_MAPS_API_KEY` is not set
- Do NOT add them to CI — they require secrets and are non-deterministic
- Run them locally before major releases to verify AI + routing behavior

## Notes

- `coverage/` is gitignored — do not commit it
- Coverage is regenerated fresh on every `npm run test:coverage`
- To check coverage for a single file: `npx jest --coverage --collectCoverageFrom="src/services/calendarService.js"`
