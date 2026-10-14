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

## E2E Tests (Real Pipeline)

E2E tests exercise the **real application pipeline** through `webhookController.handleIncomingMessage` — they are excluded from `npm test` and CI.

### What runs real vs mocked

| Real | Mocked |
|------|--------|
| Gemini AI (`@google/generative-ai`) | Calendar API (`calendarService`) |
| MongoDB (test database) | Google Sheets (`sheetsService`) |
| Sessions (`getUserSession/updateUserSession`) | WhatsApp sends (captured via mock callback) |
| Pending context (`aiService.pendingContext`) | File chat logger (`chatLogger`) |
| Date/time extraction (`dateTimeService`) | |
| Geocoding (`mapsService`) | |
| DB chat logging (`dbChatLogger`) | |

### Setup

1. **Create `envs/.env.test`** — copy `envs/.env.example` and fill in real keys:
   ```
   NODE_ENV=development
   LOAD_ENV=test
   MONGO_URI=mongodb+srv://.../<test_db_name>?retryWrites=true&w=majority
   DB_NAME=driving_school_test
   GOOGLE_AI_API_KEY=your-actual-api-key
   GOOGLE_MAPS_API_KEY=your-actual-maps-key
   APP_TIMEZONE=Asia/Kolkata
   ```
   > **Important:** Use a **separate test database** (`DB_NAME=driving_school_test`) — all collections are wiped between tests.

2. Env is loaded automatically via `helpers.js` → `src/config/env.js` with `LOAD_ENV=test`.

### How it works

- **Entry point**: `sendMessage(msg)` calls `webhookController.handleIncomingMessage` with `isMock=true` and captures all replies via a callback
- **Sessions**: Real in-memory sessions accumulate conversation history across `sendMessage()` calls within the same test. Cleared between tests via `cleanupE2ETest()`
- **Pending context**: `aiService.pendingContext` accumulates date/time across turns automatically via `dateTimeService` — no manual context injection needed
- **DB seeding**: `setupE2ESuite()` seeds a test instructor + test user in the DB so the pipeline can resolve them
- **Mocking**: Each test file calls `jest.mock()` at the top using factories from `E2E_MOCKS` (calendar, sheets, whatsapp, chatLogger)

### Test file pattern

```js
const { E2E_MOCKS } = require("./helpers");
jest.mock("../../src/services/calendarService", E2E_MOCKS.calendarService);
jest.mock("../../src/services/sheetsService", E2E_MOCKS.sheetsService);
jest.mock("../../src/services/whatsappService", E2E_MOCKS.whatsappService);
jest.mock("../../src/utils/chatLogger", E2E_MOCKS.chatLogger);

const { sendMessage, setupE2ESuite, cleanupE2ETest, teardownE2ESuite } = require("./helpers");

describe("E2E – My Test", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  it("does something", async () => {
    const { raw, replies } = await sendMessage("Hello!");
    expect(raw).toContain("help");
  }, 30000);
});
```

### Run

```bash
npm run test:e2e
```

### What they test

| Suite | What it verifies |
|-------|------------------|
| `bookingFlow.e2e` | Multi-turn booking, session + pending context, show/cancel/ASAP |
| `fullBookingFlow.e2e` | Complete flows: booking, cancel, reschedule, show, weekend/past rejection, edge cases |
| `conversationStress.e2e` | Long messages, emojis, typos, contradictions, topic switching, long context via sessions |
| `dateExtraction.e2e` | 12h→24h via dateTimeService, YYYY-MM-DD in pendingContext, colloquial times, invalid hours |
| `vulgarMessages.e2e` | Deflects vulgar messages, rejects prompt injection/system prompt extraction |
| `tonality.e2e` | Friendly tone, professional responses, stays on topic, multi-turn context |
| `responseTime.e2e` | Full pipeline latency (< 15s per call, < 12s average) |
| `geocoding.e2e` | Real postcode → lat/lng, UK bounds (isolated service test) |
| `userDetails.e2e` | Postcode geocoding, link generation (isolated service test) |
| `routeOptimizer.e2e` | Real Distance Matrix durations, multi-user slot ranking (isolated service test) |
| `calendar.e2e` | Real Google Calendar API: create/update/delete events, check availability, find earliest slot |
| `sheets.e2e` | Real Google Sheets API: create/update/cancel learner records, find rows, build row data |

### Notes

- These tests hit real APIs — they cost tokens and may be rate-limited
- Gemini tests auto-skip if `GOOGLE_AI_API_KEY` is not set
- Route optimizer tests auto-skip if `GOOGLE_MAPS_API_KEY` is not set
- Calendar tests auto-skip if `GOOGLE_REFRESH_TOKEN` / `GOOGLE_CALENDAR_ID` / `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are not set
- Sheets tests auto-skip if `GOOGLE_REFRESH_TOKEN` / `GOOGLE_SPREADSHEET_ID` / `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are not set
- **Calendar/Sheets tests require a dedicated test calendar and test spreadsheet** — they create real events/rows
- Do NOT add them to CI — they require secrets and are non-deterministic
- Run them locally before major releases to verify AI + routing behavior

## Notes

- `coverage/` is gitignored — do not commit it
- Coverage is regenerated fresh on every `npm run test:coverage`
- To check coverage for a single file: `npx jest --coverage --collectCoverageFrom="src/services/calendarService.js"`
