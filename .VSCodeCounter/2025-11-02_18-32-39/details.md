# Details

Date : 2025-11-02 18:32:39

Directory /Users/rajagrawal/Code/driving_bot

Total : 58 files,  9497 codes, 1260 comments, 1368 blanks, all 12125 lines

[Summary](results.md) / Details / [Diff Summary](diff.md) / [Diff Details](diff-details.md)

## Files
| filename | language | code | comment | blank | total |
| :--- | :--- | ---: | ---: | ---: | ---: |
| [.github/workflows/deploy.yml](/.github/workflows/deploy.yml) | YAML | 32 | 0 | 8 | 40 |
| [Dockerfile](/Dockerfile) | Docker | 7 | 6 | 6 | 19 |
| [app.js](/app.js) | JavaScript | 28 | 4 | 7 | 39 |
| [docker-compose.logging.yml](/docker-compose.logging.yml) | YAML | 41 | 0 | 3 | 44 |
| [docker-compose.yml](/docker-compose.yml) | YAML | 65 | 4 | 9 | 78 |
| [gemini-int-test.js](/gemini-int-test.js) | JavaScript | 616 | 31 | 67 | 714 |
| [gemini-test.js](/gemini-test.js) | JavaScript | 471 | 28 | 75 | 574 |
| [index5.js](/index5.js) | JavaScript | 726 | 150 | 147 | 1,023 |
| [logging/loki-config.yaml](/logging/loki-config.yaml) | YAML | 26 | 0 | 4 | 30 |
| [logging/promtail-config.yaml](/logging/promtail-config.yaml) | YAML | 18 | 6 | 5 | 29 |
| [nginx.conf](/nginx.conf) | Properties | 33 | 2 | 4 | 39 |
| [old-backends/index2.js](/old-backends/index2.js) | JavaScript | 382 | 52 | 61 | 495 |
| [old-backends/index3.js](/old-backends/index3.js) | JavaScript | 536 | 46 | 91 | 673 |
| [old-backends/index4.js](/old-backends/index4.js) | JavaScript | 641 | 49 | 115 | 805 |
| [package-lock.json](/package-lock.json) | JSON | 2,555 | 0 | 1 | 2,556 |
| [package.json](/package.json) | JSON | 30 | 0 | 1 | 31 |
| [server.js](/server.js) | JavaScript | 13 | 0 | 5 | 18 |
| [src/actions/bookingActions.js](/src/actions/bookingActions.js) | JavaScript | 52 | 0 | 10 | 62 |
| [src/actions/sessionActions.js](/src/actions/sessionActions.js) | JavaScript | 0 | 0 | 1 | 1 |
| [src/config/database.js](/src/config/database.js) | JavaScript | 16 | 5 | 5 | 26 |
| [src/config/env.js](/src/config/env.js) | JavaScript | 25 | 5 | 7 | 37 |
| [src/config/gemini.js](/src/config/gemini.js) | JavaScript | 15 | 4 | 5 | 24 |
| [src/config/google.js](/src/config/google.js) | JavaScript | 11 | 0 | 3 | 14 |
| [src/config/openai.js](/src/config/openai.js) | JavaScript | 5 | 0 | 2 | 7 |
| [src/controllers/authController.js](/src/controllers/authController.js) | JavaScript | 0 | 0 | 1 | 1 |
| [src/controllers/testController.js](/src/controllers/testController.js) | JavaScript | 0 | 0 | 1 | 1 |
| [src/controllers/webhookController.js](/src/controllers/webhookController.js) | JavaScript | 327 | 39 | 75 | 441 |
| [src/middleware/auth.js](/src/middleware/auth.js) | JavaScript | 22 | 13 | 7 | 42 |
| [src/middleware/validation.js](/src/middleware/validation.js) | JavaScript | 0 | 0 | 1 | 1 |
| [src/models/bookingModel.js](/src/models/bookingModel.js) | JavaScript | 20 | 2 | 3 | 25 |
| [src/models/instructorModel.js](/src/models/instructorModel.js) | JavaScript | 56 | 17 | 17 | 90 |
| [src/models/userModel.js](/src/models/userModel.js) | JavaScript | 15 | 0 | 3 | 18 |
| [src/routes/auth.js](/src/routes/auth.js) | JavaScript | 22 | 0 | 4 | 26 |
| [src/routes/status.js](/src/routes/status.js) | JavaScript | 134 | 5 | 8 | 147 |
| [src/routes/webhook.js](/src/routes/webhook.js) | JavaScript | 6 | 0 | 4 | 10 |
| [src/services/bookingService.js](/src/services/bookingService.js) | JavaScript | 264 | 34 | 49 | 347 |
| [src/services/calendarService.js](/src/services/calendarService.js) | JavaScript | 255 | 74 | 51 | 380 |
| [src/services/dateTimeService copy.js](/src/services/dateTimeService%20copy.js) | JavaScript | 304 | 75 | 58 | 437 |
| [src/services/dateTimeService.js](/src/services/dateTimeService.js) | JavaScript | 38 | 2 | 7 | 47 |
| [src/services/dateTimeServiceConservative.js](/src/services/dateTimeServiceConservative.js) | JavaScript | 215 | 20 | 41 | 276 |
| [src/services/gemini/aiService.js](/src/services/gemini/aiService.js) | JavaScript | 338 | 93 | 81 | 512 |
| [src/services/gemini/dateTimeService.js](/src/services/gemini/dateTimeService.js) | JavaScript | 232 | 140 | 67 | 439 |
| [src/services/mapsService.js](/src/services/mapsService.js) | JavaScript | 31 | 1 | 12 | 44 |
| [src/services/messageHandler.js](/src/services/messageHandler.js) | JavaScript | 48 | 1 | 7 | 56 |
| [src/services/openai/aiService.js](/src/services/openai/aiService.js) | JavaScript | 299 | 78 | 69 | 446 |
| [src/services/routeOptimizer.js](/src/services/routeOptimizer.js) | JavaScript | 103 | 25 | 21 | 149 |
| [src/services/sheetsService.js](/src/services/sheetsService.js) | JavaScript | 145 | 36 | 34 | 215 |
| [src/services/userDetailsService.js](/src/services/userDetailsService.js) | JavaScript | 45 | 7 | 14 | 66 |
| [src/services/whatsappService.js](/src/services/whatsappService.js) | JavaScript | 30 | 0 | 4 | 34 |
| [src/utils/constants.js](/src/utils/constants.js) | JavaScript | 0 | 0 | 1 | 1 |
| [src/utils/dateTimeUtils.js](/src/utils/dateTimeUtils.js) | JavaScript | 20 | 4 | 5 | 29 |
| [src/utils/envLogger.js](/src/utils/envLogger.js) | JavaScript | 20 | 1 | 4 | 25 |
| [src/utils/haversine.js](/src/utils/haversine.js) | JavaScript | 13 | 9 | 6 | 28 |
| [src/utils/helpers.js](/src/utils/helpers.js) | JavaScript | 37 | 5 | 7 | 49 |
| [src/utils/logger.js](/src/utils/logger.js) | JavaScript | 0 | 0 | 1 | 1 |
| [src/utils/refreshWhatsappToken.js](/src/utils/refreshWhatsappToken.js) | JavaScript | 29 | 3 | 7 | 39 |
| [src/utils/show\_bookings\_assets.js](/src/utils/show_bookings_assets.js) | JavaScript | 0 | 95 | 29 | 124 |
| [src/utils/timezoneUtils.js](/src/utils/timezoneUtils.js) | JavaScript | 85 | 89 | 27 | 201 |

[Summary](results.md) / Details / [Diff Summary](diff.md) / [Diff Details](diff-details.md)