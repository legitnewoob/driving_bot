// test_gemini.js - Complete test file for your Gemini migration
const config = require("./src/config/env");
const timezoneUtils = require("./src/utils/timezoneUtils");
const e = require("express");
const fs = require("fs");
const path = require("path");

const dateStamp = timezoneUtils.formatDate(
  timezoneUtils.getCurrentDate(),
  "YYYY-MM-DD"
);
// Create logs directory if not exists
const logDir = path.join(__dirname, `logs/${dateStamp}_logs`);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true }); // Use recursive true for safety
}

// File with timestamp
const timestamp = timezoneUtils.formatDate(
  timezoneUtils.getCurrentDate(),
  "hh-mm-ss_A"
);
const logFile = path.join(logDir, `log_${timestamp}.txt`);
const logStream = fs.createWriteStream(logFile, { flags: "a" });

const AIService = require("./src/services/gemini/aiService");
const DateTimeService = require("./src/services/gemini/dateTimeService");

const originalLog = console.log;
console.log = (...args) => {
  const message = args.join(" ");
  // Cleans up the color codes for the log file
  const cleanMessage = message.replace(/\x1b\[[0-9;]*m/g, "");

  // Check if the stream is still writable before attempting to write
  if (!logStream.writableEnded) {
    logStream.write(cleanMessage + "\n", (err) => {
      if (err) {
        originalLog("Error writing to log stream:", err);
      }
    });
  }

  originalLog.apply(console, args);
};

// Color coding for console output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

class GeminiTester {
  constructor() {
    this.testResults = {
      passed: 0,
      failed: 0,
      total: 0,
    };
  }

  log(message, color = "reset") {
    console.log(`${colors[color]}${message}${colors.reset}`);
  }

  async runAllTests() {
    this.log("\n🚀 Starting Gemini Integration Tests", "cyan");
    this.log("=".repeat(50), "cyan");

    await this.testBasicResponses();
    await this.testBookingScenarios();
    await this.testDateTimeExtraction();
    await this.testActionExtraction();
    await this.testErrorHandling();

    // The summary is now called only once at the end of all tests.
    await this.printSummary();
  }

  async testBasicResponses() {
    this.log("\n📝 Testing Basic AI Responses", "yellow");
    this.log("-".repeat(30), "yellow");

    const basicTests = [
      {
        message: "Hello",
        expectContains: ["hello", "help", "driving"],
        expectAction: "NULL",
      },
      {
        message: "What can you do?",
        expectContains: ["book", "lesson", "driving"],
        expectAction: "NULL",
      },
      {
        message: "Show my bookings",
        expectContains: ["booking"],
        expectAction: "SHOW_BOOKINGS",
      },
      {
        message: "What services do you provide?",
        expectContains: ["driving", "lesson", "book", "cancel", "update"],
        expectAction: "NULL",
      },
      {
        message:
          "Can you provide me with information on how to tackle roundabouts?",
        expectContains: ["roundabout"],
        expectAction: "NULL",
      },
      {
        message: "What's the earliest available slot?",
        expectContains: ["availabl", "checking"],
        expectAction: "NEXT_AVAILABLE_SLOT",
      },
      {
        message: "What's the earliest availability?",
        expectContains: ["checking", "availabl"],
        expectAction: "NEXT_AVAILABLE_SLOT",
      },
      {
        message: "Can you check the earliest slot?",
        expectContains: ["checking", "availabl"],
        expectAction: "NEXT_AVAILABLE_SLOT",
      },
      {
        message: "When’s the soonest time I can book?",
        expectContains: ["checking", "availabl"],
        expectAction: "NEXT_AVAILABLE_SLOT",
      },
      {
        message: "Find me the first available appointment",
        expectContains: ["checking", "availabl"],
        expectAction: "NEXT_AVAILABLE_SLOT",
      },
      {
        message: "What's the next open slot?",
        expectContains: ["checking", "availabl"],
        expectAction: "NEXT_AVAILABLE_SLOT",
      },
      {
        message: "Do you have anything earlier?",
        expectContains: ["checking", "availabl"],
        expectAction: "NEXT_AVAILABLE_SLOT",
      },
      {
        message: "Tell me the earliest date I can book",
        expectContains: ["checking", "availabl"],
        expectAction: "NEXT_AVAILABLE_SLOT",
      },
      {
        message: "Show me the next availability",
        expectContains: ["checking", "availabl"],
        expectAction: "NEXT_AVAILABLE_SLOT",
      },
      {
        message: "What’s the first slot you’ve got?",
        expectContains: ["checking", "availabl"],
        expectAction: "NEXT_AVAILABLE_SLOT",
      },
    ];

    for (const test of basicTests) {
      await this.runSingleTest("Basic Response", test);
    }
  }

  async testBookingScenarios() {
    this.log("\n📅 Testing Booking Scenarios", "yellow");
    this.log("-".repeat(30), "yellow");

    const bookingTests = [
      // {
      //   message: "I want to book a lesson tomorrow at 2 PM",
      //   expectAction: "BOOK",
      //   expectContains: ["tomorrow", "2", "pm"],
      //   description: "Complete booking request"
      // },
      {
        message: "Book lesson for Friday",
        expectAction: "NULL",
        expectContains: ["time", "what", "slots"],
        description: "Incomplete booking (missing time)",
      },
      {
        message: "I want to cancel my lesson",
        expectAction: "NULL",
        expectContains: ["cancel", "booking", "id", "provide"],
        description: "Cancel request without booking ID",
      },
      {
        message: "Book a lesson for 25th October at 10 AM",
        expectAction: "NULL",
        expectContains: ["available"],
        description:
          "User requests a lesson on a Saturday, which is outside of the Mon-Fri working days.",
      },
      {
        message: "Book a lesson for 23rd",
        expectAction: "NULL",
        expectContains: ["23", "time"],
        description: "Booking without time",
      },
      {
        message: "Book a lesson for 25th 3pm",
        expectAction: "BOOK",
        expectContains: ["25th"],
        description: "Booking with time and date",
      },
    ];

    for (const test of bookingTests) {
      await this.runSingleTest("Booking", test);
    }
  }

  async testDateTimeExtraction() {
    this.log("\n⏰ Testing DateTime Extraction", "yellow");
    this.log("-".repeat(30), "yellow");

    // Next Week Availability
    //
    const dateTimeTests = [
      {
        message: "rechedule my lesson to tomorrow at 3 PM",
        expectDateTime: true,
        expectTime: "15:00",
      },
      {
        message: "rechedule my lesson to 3rd October at 3 PM",
        expectDateTime: true,
        expectTime: "15:00",
      },
      {
        message: "rechedule my lesson to 3rd October",
        expectDateTime: true,
        expectTime: null,
      },
      {
        message: "Cancel my bookings",
        expectDateTime: false,
        expectTime: null,
      },
      {
        message: "What's the earliest available slot?",
        expectDateTime: false,
        expectTime: null,
      },
      {
        message: "What's the earliest availability?",
        expectDateTime: false,
        expectTime: null,
      },
      {
        message: "tomorrow at 3 PM",
        expectDateTime: true,
        expectTime: "15:00",
      },
      {
        message: "Show my bookings",
        expectDateTime: false,
        expectTime: null,
      },
      {
        message: "Friday morning",
        expectDateTime: true,
        expectTime: "09:00",
      },
      {
        message: "next Monday at 2:30 PM",
        expectDateTime: true,
        expectTime: "14:30",
      },
      {
        message: "the 25th at noon",
        expectDateTime: true,
        expectTime: "12:00",
      },
      {
        message: "What’s your availability for 15th",
        expectDate: "2025-09-15",
        expectDateTime: true,
        expectTime: null,
      },
      {
        message: "What’s your availability for 23rd",
        expectDate: "2025-09-23",
        expectDateTime: true,
        expectTime: null,
      },
      {
        message: "What’s your availability for 1st",
        expectDate: "2025-10-01",
        expectDateTime: true,
        expectTime: null,
      },
      {
        message: "What’s your availability for 2nd",
        expectDate: "2025-10-02",
        expectDateTime: true,
        expectTime: null,
      },
      {
        message: "What’s your availability for 29th",
        expectDate: "2025-09-29",
        expectDateTime: true,
        expectTime: null,
      },
      {
        message: "random message",
        expectDateTime: false,
      },
    ];

    for (const test of dateTimeTests) {
      await this.runDateTimeTest(test);
    }
    // FIX: Removed the call to printSummary() from here.
    // It was causing the log stream to close prematurely.
  }

  async testActionExtraction() {
    this.log("\n🎯 Testing Action Extraction", "yellow");
    this.log("-".repeat(30), "yellow");

    const actionTests = [
      {
        response:
          'I\'m processing your booking now... [ACTION:BOOK]\n{"date": "2024-03-15", "time": "14:00"}',
        expectAction: "book",
        expectData: { date: "2024-03-15", time: "14:00" },
      },
      {
        response: "Let me show your bookings. [ACTION:SHOW_BOOKINGS]\n{}",
        expectAction: "show_bookings",
        expectData: {},
      },
      {
        response: "I need more information. [ACTION:NULL]\n{}",
        expectAction: "null",
        expectData: {},
      },
    ];

    for (const test of actionTests) {
      this.runActionExtractionTest(test);
    }
  }

  async testErrorHandling() {
    this.log("\n❌ Testing Error Handling", "yellow");
    this.log("-".repeat(30), "yellow");
    this.testResults.total++;

    // Test with invalid input
    try {
      const response = await AIService.getResponse("", [], "+1234567890");
      this.log(
        `✅ Empty message handled gracefully: ${response.substring(0, 50)}...`,
        "green"
      );
      this.testResults.passed++;
    } catch (error) {
      this.log(`❌ Empty message test failed: ${error.message}`, "red");
      this.testResults.failed++;
    }
  }

  async runSingleTest(category, test) {
    this.testResults.total++;

    try {
      this.log(`\n🧪 Testing ${category}: "${test.message}"`, "blue");

      const response = await AIService.getResponse(
        test.message,
        [],
        "+1234567890"
      );

      this.log(`📤 Response: ${response}`, "bright");

      // Extract actions
      const actions = AIService.extractActions(response);
      this.log(`🎯 Action: ${actions.actionType || "none"}`, "bright");
      if (actions.bookingData) {
        this.log(`📊 Data: ${JSON.stringify(actions.bookingData)}`, "bright");
      }

      // Validate expectations
      let passed = true;

      // Check expected action
      if (test.expectAction) {
        const expectedAction = test.expectAction.toLowerCase();
        const actualAction = (actions.actionType || "null").toLowerCase();
        if (actualAction !== expectedAction) {
          this.log(
            `❌ Expected action: ${expectedAction}, got: ${actualAction}`,
            "red"
          );
          passed = false;
        } else {
          this.log(`✅ Action matches: ${expectedAction}`, "green");
        }
      }

      // Check expected content
      if (test.expectContains) {
        for (const keyword of test.expectContains) {
          if (!response.toLowerCase().includes(keyword.toLowerCase())) {
            this.log(`❌ Missing keyword: "${keyword}"`, "red");
            passed = false;
          } else {
            this.log(`✅ Contains keyword: "${keyword}"`, "green");
          }
        }
      }

      if (passed) {
        this.log(`✅ ${category} test PASSED`, "green");
        this.testResults.passed++;
      } else {
        this.log(`❌ ${category} test FAILED`, "red");
        this.testResults.failed++;
      }
    } catch (error) {
      this.log(`❌ ${category} test ERROR: ${error.message}`, "red");
      this.testResults.failed++;
    }
  }

  async runDateTimeTest(test) {
    this.testResults.total++;

    try {
      this.log(`\n🧪 Testing DateTime: "${test.message}"`, "blue");

      const result = await DateTimeService.extractDateTimeFromMessage(
        test.message
      );

      this.log(`📊 Result: ${JSON.stringify(result, null, 2)}`, "bright");

      let passed = true;

      // Check if datetime was expected
      if (test.expectDateTime !== result.hasDateTime) {
        this.log(
          `❌ Expected hasDateTime: ${test.expectDateTime}, got: ${result.hasDateTime}`,
          "red"
        );
        passed = false;
      } else {
        this.log(`✅ DateTime detection: ${result.hasDateTime}`, "green");
      }

      // Check expected time
      if (test.expectTime && result.time !== test.expectTime) {
        this.log(
          `❌ Expected time: ${test.expectTime}, got: ${result.time}`,
          "red"
        );
        passed = false;
      } else if (test.expectTime) {
        this.log(`✅ Time matches: ${test.expectTime}`, "green");
      }

      //Check expected date
      if (test.expectDate && result.date !== test.expectDate) {
        this.log(
          `❌ Expected date: ${test.expectDate}, got: ${result.date}`,
          "red"
        );
        passed = false;
      } else if (test.expectDate) {
        this.log(`✅ Date matches: ${test.expectDate}`, "green");
      }

      if (passed) {
        this.log(`✅ DateTime test PASSED`, "green");
        this.testResults.passed++;
      } else {
        this.log(`❌ DateTime test FAILED`, "red");
        this.testResults.failed++;
      }
    } catch (error) {
      this.log(`❌ DateTime test ERROR: ${error.message}`, "red");
      this.testResults.failed++;
    }
  }

  runActionExtractionTest(test) {
    this.testResults.total++;

    try {
      this.log(`\n🧪 Testing Action Extraction`, "blue");
      this.log(`📤 Response: ${test.response}`, "bright");

      const result = AIService.extractActions(test.response);

      this.log(`🎯 Extracted: ${JSON.stringify(result, null, 2)}`, "bright");

      let passed = true;

      // Check action type
      if (result.actionType !== test.expectAction) {
        this.log(
          `❌ Expected action: ${test.expectAction}, got: ${result.actionType}`,
          "red"
        );
        passed = false;
      } else {
        this.log(`✅ Action matches: ${test.expectAction}`, "green");
      }

      // Check data if provided
      if (
        test.expectData &&
        JSON.stringify(result.bookingData) !== JSON.stringify(test.expectData)
      ) {
        this.log(`❌ Data mismatch`, "red");
        this.log(`   Expected: ${JSON.stringify(test.expectData)}`, "red");
        this.log(`   Got: ${JSON.stringify(result.bookingData)}`, "red");
        passed = false;
      } else if (test.expectData) {
        this.log(`✅ Data matches`, "green");
      }

      if (passed) {
        this.log(`✅ Action extraction test PASSED`, "green");
        this.testResults.passed++;
      } else {
        this.log(`❌ Action extraction test FAILED`, "red");
        this.testResults.failed++;
      }
    } catch (error) {
      this.log(`❌ Action extraction test ERROR: ${error.message}`, "red");
      this.testResults.failed++;
    }
  }

  async printSummary() {
    return new Promise((resolve) => {
      this.log("\n" + "=".repeat(50), "cyan");
      this.log("📊 TEST SUMMARY", "cyan");
      this.log("=".repeat(50), "cyan");

      this.log(`Total Tests: ${this.testResults.total}`, "bright");
      this.log(`✅ Passed: ${this.testResults.passed}`, "green");
      this.log(`❌ Failed: ${this.testResults.failed}`, "red");

      const successRate =
        this.testResults.total > 0
          ? ((this.testResults.passed / this.testResults.total) * 100).toFixed(
              1
            )
          : "0.0";
      this.log(
        `📈 Success Rate: ${successRate}%`,
        successRate >= 80 ? "green" : "red"
      );

      if (this.testResults.failed === 0) {
        this.log(
          "\n🎉 All tests passed! Your Gemini integration is working perfectly!",
          "green"
        );
      } else {
        this.log(
          `\n⚠️  ${this.testResults.failed} test(s) failed. Check the output above for details.`,
          "yellow"
        );
      }
      console.log(`📝 Logs written to ${logFile}`);
      logStream.end(resolve);
    });
  }
}

// Individual test functions for quick testing
async function quickTest() {
  console.log("🚀 Quick Test - Single Message");

  try {
    const response = await AIService.getResponse(
      "I want to book a lesson tomorrow at 2 PM",
      [],
      "+1234567890"
    );

    console.log("📤 Response:", response);

    const actions = AIService.extractActions(response);
    console.log("🎯 Actions:", actions);
  } catch (error) {
    console.error("❌ Quick test failed:", error.message);
  } finally {
    logStream.end();
  }
}

async function testDateTime() {
  console.log("⏰ Quick DateTime Test");

  const testMessages = [
    "tomorrow at 3 PM",
    "Friday morning",
    "next Monday",
    "the 25th at 2:30",
  ];

  for (const message of testMessages) {
    try {
      console.log(`\n🧪 Testing: "${message}"`);
      const result = await DateTimeService.extractDateTimeFromMessage(message);
      console.log("📊 Result:", result);
    } catch (error) {
      console.error("❌ Error:", error.message);
    }
  }
  logStream.end();
}

// Export for different usage patterns
module.exports = {
  GeminiTester,
  quickTest,
  testDateTime,
};

// Command line execution
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const tester = new GeminiTester();

    if (args.includes("--quick")) {
      await quickTest();
    } else if (args.includes("--datetime")) {
      await testDateTime();
    } else if (args.includes("--basic")) {
      await tester.testBasicResponses();
      await tester.printSummary();
    } else if (args.includes("--booking")) {
      await tester.testBookingScenarios();
      await tester.printSummary();
    } else if (args.includes("--extraction")) {
      await tester.testDateTimeExtraction();
      await tester.printSummary();
    } else if (args.includes("--actions")) {
      await tester.testActionExtraction();
      await tester.printSummary();
    } else if (args.includes("--errors")) {
      await tester.testErrorHandling();
      await tester.printSummary();
    } else {
      // Run full test suite
      await tester.runAllTests();
    }
  })();
}
