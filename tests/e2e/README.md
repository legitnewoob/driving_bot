# E2E Tests

End-to-end tests that exercise the **real** application pipeline through
`webhookController.handleIncomingMessage`.

## What runs real vs mocked

| Real | Mocked |
|------|--------|
| Gemini AI (real API calls) | calendarService |
| MongoDB (test DB) | sheetsService |
| Sessions, pending context | whatsappService |
| Date/time extraction | chatLogger (file writes) |
| Geocoding (Maps API) | |

## One-time setup

1. Copy the example env file and fill in your keys:
   ```powershell
   Copy-Item envs\.env.test.example envs\.env.test
   ```
2. Edit `envs\.env.test` and add the keys you need (see table below).

## Which keys you need

| Test files | Required keys |
|-----------|---------------|
| `bookingFlow`, `fullBookingFlow`, `dateExtraction`, `conversationStress`, `responseTime`, `tonality`, `vulgarMessages` | `GOOGLE_AI_API_KEY` |
| `geocoding`, `routeOptimizer`, `userDetails` | `GOOGLE_MAPS_API_KEY` |
| `calendar` | `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| `sheets` | `GOOGLE_REFRESH_TOKEN`, `GOOGLE_SPREADSHEET_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |

All tests also need `MONGO_URI` and `DB_NAME`.

## Running tests

### All e2e tests
```powershell
npm run test:e2e
```

### One file
```powershell
npm run test:e2e -- bookingFlow
```
(matches anything containing `bookingFlow` in the path)

### One specific test by name
```powershell
npm run test:e2e -- bookingFlow -t "date-only message"
```

### Skip suites with missing env vars (instead of failing)
```powershell
$env:E2E_SKIP_MISSING="1"; npm run test:e2e
```

## Debugging in VS Code

Two ways:

1. **Click the `Debug` lens above any `it()`** in an `*.e2e.test.js` file —
   set a breakpoint, hit play. Just works.
2. **Run > Start Debugging** with one of these configs (in `.vscode/launch.json`):
   - `Debug E2E: current file` — debugs the file you have open
   - `Debug E2E: all tests` — debugs everything sequentially

## How `describeE2E` works

Every e2e suite uses the centralized guard:

```js
const { describeE2E, E2E_KEYS } = require("./helpers");

describeE2E(E2E_KEYS.AI, "My Suite", () => {
  it("does something", async () => { /* ... */ });
});
```

Behaviour:

- **All required env vars present** → suite runs normally
- **Vars missing + `E2E_SKIP_MISSING=1`** → silently skipped (CI-friendly)
- **Vars missing, no flag** → fails loudly with a clear error message
  listing exactly which vars are missing

## Adding a new e2e test

1. Create `tests/e2e/myFeature.e2e.test.js`
2. At the top, set up mocks (copy the pattern from `bookingFlow.e2e.test.js`)
3. Wrap your suite with `describeE2E(E2E_KEYS.AI, ...)` (or whichever group)
4. Done — no env loading or boilerplate needed.

## Files in this directory

- `setup.js` — Jest `setupFiles` entry; loads `envs/.env.test`. Don't import this.
- `helpers.js` — shared utilities, fixtures, `describeE2E`, `E2E_KEYS`, `sendMessage`.
- `*.e2e.test.js` — the actual tests.
