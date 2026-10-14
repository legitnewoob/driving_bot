# [1.2.0](https://github.com/legitnewoob/driving_bot/compare/v1.1.0...v1.2.0) (2026-10-14)


### Bug Fixes

* correct typo in LOAD_ENV variable in .env.example ([5fb3a51](https://github.com/legitnewoob/driving_bot/commit/5fb3a51415712a8bdeef42dea2f4111039f3de83))
* correct typo in LOAD_ENV variable in .env.example ([584fd3e](https://github.com/legitnewoob/driving_bot/commit/584fd3e4e2171e733215495d33aaa735f8c64810))
* enhance booking and sheets services to include instructor details and address handling ([c0c2569](https://github.com/legitnewoob/driving_bot/commit/c0c25693244d8ccfc526722700a0cb87b599ff12))
* reply when a number has no instructor; tolerate lessons without a time ([9edabfc](https://github.com/legitnewoob/driving_bot/commit/9edabfcd720dca403f49d7970b387a6d8c19a017))
* resolve merge conflict in seedDevData.js ([961cf83](https://github.com/legitnewoob/driving_bot/commit/961cf8320334f31b2c07d00c1cab4bc293422362))
* resolve seed data not visible on portal due to instructorId mismatch ([c33fbef](https://github.com/legitnewoob/driving_bot/commit/c33fbef383f80efb24daab81ee230cd3ba79707f))
* retired date model, and keep dates Donna works out herself ([dd1bc37](https://github.com/legitnewoob/driving_bot/commit/dd1bc37ec9cf9d6681d542f278ddcb454a9c6dc7))
* update phone number in chat topbar to reflect new contact ([50f920d](https://github.com/legitnewoob/driving_bot/commit/50f920d0d9b4582abccacb470a59092ed2fef640))
* update PHONE_NUMBER_ID to a valid default value ([5dad8bf](https://github.com/legitnewoob/driving_bot/commit/5dad8bf4cceed078f5f3bb5267b39f7bd60a48b7))
* update test:e2e:report script to include NODE_OPTIONS for compatibility ([f149f81](https://github.com/legitnewoob/driving_bot/commit/f149f813c6f94a2034d468f080dd6e7b1097d8af))
* use unique phone numbers in seed data to avoid portal deduplication ([e09e35a](https://github.com/legitnewoob/driving_bot/commit/e09e35ab1df45276e6730aeb861f52cf105fb165))


### Features

* add 'test:all' script to run all tests ([12e5956](https://github.com/legitnewoob/driving_bot/commit/12e5956fd8c77c49e458879a339cc2567c056e50))
* add API key auth, dashboard & learner routes, and instructor CLI overhaul ([f587770](https://github.com/legitnewoob/driving_bot/commit/f58777094c02b1546ad5e6ca94fa6f71065e0833))
* add automatic WhatsApp token refresh on startup and 7-day schedule ([7c37454](https://github.com/legitnewoob/driving_bot/commit/7c374541f6f38ead28dbffd59762c8b54959301d))
* add bookings API route with authentication and update test expectations for instructor parameter ([3b186ff](https://github.com/legitnewoob/driving_bot/commit/3b186ffe0ddd94266c6910f46d3b3a3a84f919f0))
* add email notifications for invalid_grant errors and update environment configuration ([1f7db60](https://github.com/legitnewoob/driving_bot/commit/1f7db606adf48f6b318740a7b8cd5132755c1933))
* add instructor phone field and migrate OAuth flow to use phone-based identification ([9ce0d75](https://github.com/legitnewoob/driving_bot/commit/9ce0d75f69df575cca0731c68274893b0a99fab1))
* add instructor phone number ID support to mock webhook for multi-instructor testing ([356e5f3](https://github.com/legitnewoob/driving_bot/commit/356e5f31d1259e07357c7552f11fa38d524293a2))
* add Jest testing framework with route optimizer test scripts ([7cedc3d](https://github.com/legitnewoob/driving_bot/commit/7cedc3d57b0f966ee4a1c9a5895a200daf8797ae))
* add payment model, lesson completion endpoint, and payment CRUD ([91779f8](https://github.com/legitnewoob/driving_bot/commit/91779f8eed0d5f83d62050f6138806a854c26528))
* add pickup and drop-off location support to booking system ([db2e6c2](https://github.com/legitnewoob/driving_bot/commit/db2e6c254d13ca1531a1e4fd52527b4ade73056f))
* add Raj Agrawal and Josh Yarwood to seed data ([d4ddc69](https://github.com/legitnewoob/driving_bot/commit/d4ddc694118663c0bba704af160207d4efbc7f3a))
* add WhatsApp mock server with UI for local bot development ([73f270d](https://github.com/legitnewoob/driving_bot/commit/73f270da9fb817030b758cb9f94a6b59e727f0a3))
* align portal add forms with backend models, add booking endpoint ([60d85b1](https://github.com/legitnewoob/driving_bot/commit/60d85b1783d794484d32e148a254d6cabe1c33c2))
* create Google Calendar events for bookings and block time ([33cc16e](https://github.com/legitnewoob/driving_bot/commit/33cc16e74eaa3a3abf7760d639aae29de8b1799f))
* geocode postal code to lat/long when adding learner via portal API ([6050fab](https://github.com/legitnewoob/driving_bot/commit/6050fab9e280be8644fd4ee34f841e60018ece42))
* Google OAuth, Stripe integration, phone number pool, rate limiting ([8b98c9e](https://github.com/legitnewoob/driving_bot/commit/8b98c9e37ed5369abe4ffeb2d7be505fd1b3667f))
* improve server startup output and simplify root endpoint response ([a28b2d7](https://github.com/legitnewoob/driving_bot/commit/a28b2d7061c713f25b735ddc00aeca0fba91cdfa))
* learners + lesson types API, dashboard Google Calendar connect, remove Sheets ([170741e](https://github.com/legitnewoob/driving_bot/commit/170741ea8570ed23e762b9a89aca317f1b811bd9))
* re-enable WhatsApp token refresh with env fallback ([9e62afc](https://github.com/legitnewoob/driving_bot/commit/9e62afcd296c887be43a8fa70a7b8cfa6e673ca7))
* route optimisation, Donna settings, bot reliability and booking fixes ([f411213](https://github.com/legitnewoob/driving_bot/commit/f41121379feff4909bf4799e40403121b21ff21f))
* **seed:** give the first dev instructor the real WhatsApp number ([60aad8c](https://github.com/legitnewoob/driving_bot/commit/60aad8c13bbb1806d45d713cd5241335ba3965a8))
* setup checklist before a number, Donna on/off switch, safer numbers ([9c7b16e](https://github.com/legitnewoob/driving_bot/commit/9c7b16ed538d10b1f28fb27360939fdb32d16a38))
* tap-to-pick menus, 12-hour times, never offer already-booked slots ([61d8b00](https://github.com/legitnewoob/driving_bot/commit/61d8b004a2963558e99f243dca8824d2c2ad97ee))


### Performance Improvements

* faster bot replies (skip/parse dates locally, Gemini Flash) ([0557503](https://github.com/legitnewoob/driving_bot/commit/0557503f544fed5b284fc4d75417b2063a326b96))

# [1.1.0](https://github.com/legitnewoob/driving_bot/compare/v1.0.0...v1.1.0) (2026-03-04)


### Features

* enhance health metrics and dashboard rendering for improved system monitoring ([c746fd9](https://github.com/legitnewoob/driving_bot/commit/c746fd9ecef12ccf4a9fc520432f555c29c5cc27))

# 1.0.0 (2026-03-04)


### Bug Fixes

* clean up auto promotion workflow by removing quotes and improving PR body messages ([24506be](https://github.com/legitnewoob/driving_bot/commit/24506be3c14cca418d0de9df04dfc0646d5a6437))
* replace openai with gemin && add integration test for gemini ([a522a75](https://github.com/legitnewoob/driving_bot/commit/a522a758b24eeeee0d4fa47468bd25cc080f50d9))
* update branch name from 'main' to 'Master' in CI/CD workflows ([6a5b297](https://github.com/legitnewoob/driving_bot/commit/6a5b297a0d04ae59c1cbfceda7c6174a5ddb9859))
* update branch name from 'Master' to 'main' in CI/CD workflow ([b0b00ca](https://github.com/legitnewoob/driving_bot/commit/b0b00ca39dd8575c9380461d720e919de4494d48))
* update branch name to 'main' and upgrade Node.js version to 20 in release workflow ([97850e0](https://github.com/legitnewoob/driving_bot/commit/97850e0e9a1e0f61e2f0895d990fe1fbc243f7c3))
* update environment variable loading and correct dbUrl reference ([d09140a](https://github.com/legitnewoob/driving_bot/commit/d09140a03f9a31b6454a757fc6543cd382dd7a4a))
* update environment variable loading and correct dbUrl reference ([18315a3](https://github.com/legitnewoob/driving_bot/commit/18315a3b362ea53c2dfeebcd46e24ccc774e10f0))
* update environment variable logging and improve date handling in calendar service ([2b8f640](https://github.com/legitnewoob/driving_bot/commit/2b8f640a64bc18153291916860fbe09212ab8281))
* update environment variable logging and improve date handling in calendar service ([a026f86](https://github.com/legitnewoob/driving_bot/commit/a026f8665ebeb3846ad97ea3233bd8ddf2514a2f))
* update instructor details and correct environment variable usage ([9f00802](https://github.com/legitnewoob/driving_bot/commit/9f0080269ca99d344c291a57d9be83dd6b1614ed))
* update Node.js version to 22 in release workflow ([f69eebb](https://github.com/legitnewoob/driving_bot/commit/f69eebb49d2e4fef43a115670b2ae41febb54af5))
* update PR body messages for auto promotion workflow ([1f81bc0](https://github.com/legitnewoob/driving_bot/commit/1f81bc0ee973efbab2c8bd108368d4799d130dc4))


### Features

* add auto promotion workflow for Development and UAT branches ([116058b](https://github.com/legitnewoob/driving_bot/commit/116058b0b12ac80f96beaf14261272fae9d1dc28))
* enhance user interaction by adding urgency detection for earliest lesson requests and clear conversation history ([e8fa514](https://github.com/legitnewoob/driving_bot/commit/e8fa51470df41ad100b344e0af64bb12bc2c2602))
* enhance user interaction by adding urgency detection for earliest lesson requests and clear conversation history ([1833e3f](https://github.com/legitnewoob/driving_bot/commit/1833e3feaa7d47647d8ef98ec2f2c87684f07b35))
* implement Gemini integration and add functionality to find earliest available slots ([6aa3ee9](https://github.com/legitnewoob/driving_bot/commit/6aa3ee9e93068962e997852d889408b610b3c2c8))
* Implement user model and services for managing user details and location ([dab5d4f](https://github.com/legitnewoob/driving_bot/commit/dab5d4f31fc0f9f3e550cea1a3df2172997e8c6d))
