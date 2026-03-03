// route_optimizer_test.js - CLI Route Optimization Tester
const config = require("./src/config/env");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const RouteOptimizer = require("./src/services/routeOptimizer");
const getCoordinatesFromPostalCode = require("./src/services/mapsService").getCoordinatesFromPostalCode;
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

class RouteOptimizationTester {
  constructor() {
    this.testResults = {
      passed: 0,
      failed: 0,
      total: 0,
      simulations: [],
    };
    this.setupLogging();
  }

  setupLogging() {
    const timestamp = new Date().toISOString().replace(/:/g, "-").split(".")[0];
    const logDir = path.join(__dirname, "logs", "route_optimization");
    
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Clean up old log files - keep only last 5
    this.cleanupOldLogs(logDir);

    this.logFile = path.join(logDir, `route_test_${timestamp}.txt`);
    this.logStream = fs.createWriteStream(this.logFile, { flags: "a" });

    // Override console.log
    const originalLog = console.log;
    console.log = (...args) => {
      const message = args.join(" ");
      const cleanMessage = message.replace(/\x1b\[[0-9;]*m/g, "");

      if (!this.logStream.writableEnded) {
        this.logStream.write(cleanMessage + "\n", (err) => {
          if (err) originalLog("Error writing to log:", err);
        });
      }
      originalLog.apply(console, args);
    };
  }

  cleanupOldLogs(logDir) {
    try {
      const files = fs.readdirSync(logDir);
      
      // Separate log files and result files
      const logFiles = files
        .filter(f => f.startsWith('route_test_') && f.endsWith('.txt'))
        .map(f => ({
          name: f,
          path: path.join(logDir, f),
          time: fs.statSync(path.join(logDir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);

      const resultFiles = files
        .filter(f => f.startsWith('results_') && f.endsWith('.json'))
        .map(f => ({
          name: f,
          path: path.join(logDir, f),
          time: fs.statSync(path.join(logDir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);

      // Keep only last 5 log files
      if (logFiles.length > 5) {
        const filesToDelete = logFiles.slice(5);
        filesToDelete.forEach(file => {
          fs.unlinkSync(file.path);
          console.log(`🗑️  Deleted old log: ${file.name}`);
        });
      }

      // Keep only last 5 result files
      if (resultFiles.length > 5) {
        const filesToDelete = resultFiles.slice(5);
        filesToDelete.forEach(file => {
          fs.unlinkSync(file.path);
          console.log(`🗑️  Deleted old result: ${file.name}`);
        });
      }
    } catch (error) {
      console.log(`⚠️  Warning: Could not cleanup old logs: ${error.message}`);
    }
  }

  log(message, color = "reset") {
    console.log(`${colors[color]}${message}${colors.reset}`);
  }

  // Mock function - Replace with your actual implementation
  async getCoordinatesFromPostalCode(postalCode) {
    // Simulate API call delay
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Mock coordinates for UK postal codes (London area)
    const mockCoords = {
      "SW1A 1AA": { lat: 51.5014, lng: -0.1419 }, // Westminster
      "EC1A 1BB": { lat: 51.5174, lng: -0.0933 }, // City of London
      "W1A 0AX": { lat: 51.5158, lng: -0.1442 }, // Oxford Street
      "NW1 6XE": { lat: 51.5355, lng: -0.1565 }, // Regent's Park
      "SE1 9SG": { lat: 51.5045, lng: -0.0865 }, // Southwark
      "E1 6AN": { lat: 51.5154, lng: -0.0649 }, // Whitechapel
      "WC2N 5DU": { lat: 51.5089, lng: -0.1283 }, // Trafalgar Square
    };

    return (
      mockCoords[postalCode.toUpperCase()] || {
        lat: 51.5 + Math.random() * 0.05,
        lng: -0.1 + Math.random() * 0.1,
      }
    );
  }

  // Mock function for slot availability - Replace with your actual implementation
  getAvailableSlots(postalCode, bookedSlots , bookings , coordinates) {
    const allSlots = ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'];
    
     const routeOptimizer = new RouteOptimizer();
     const availableSlotsForDate = allSlots.filter((slot) => !bookedSlots.includes(slot));

    //  const filteredAvailableSlots =  routeOptimizer.filterAvailableSlotsByLocationTest(
    //     availableSlotsForDate,
    //     bookings,
    //     coordinates[postalCode]
    //   );

      return availableSlotsForDate;
    
  }
/*
1 2 3
1 3 2
2 1 3
2 3 1
3 1 2
3 2 1

permuations of [1,2,3] = 6
3 ! = 3x2x1 = 6
5 ! = 5x4x3x2x1 = 120
*/
  // Generate all permutations of postal codes
  generatePermutations(arr) {
    if (arr.length <= 1) return [arr];

    const result = [];
    for (let i = 0; i < arr.length; i++) {
      const current = arr[i];
      const remaining = arr.slice(0, i).concat(arr.slice(i + 1));
      const remainingPerms = this.generatePermutations(remaining);

      for (const perm of remainingPerms) {
        result.push([current, ...perm]);
      }
    }
    console.log(result)
    return result;
  }

  // Calculate distance between two coordinates (Haversine formula)
  calculateDistance(coord1, coord2) {
    const R = 6371; // Earth's radius in km
    const dLat = ((coord2.lat - coord1.lat) * Math.PI) / 180;
    const dLng = ((coord2.lng - coord1.lng) * Math.PI) / 180;

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((coord1.lat * Math.PI) / 180) *
        Math.cos((coord2.lat * Math.PI) / 180) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // Run simulation for a single sequence
  async runSimulation(sequence, coordinates, simulationNumber) {
    const bookedSlots = [];
    const bookings = [];
    let totalDistance = 0;
    let previousCoord = null;

    // Check if this sequence matches expected order
    const isExpectedSequence = this.expectedOrder && 
      sequence.join(" → ") === this.expectedOrder.join(" → ");

    this.log(
      `\n📍 Simulation #${simulationNumber}: ${sequence.join(" → ")}${isExpectedSequence ? " ⭐ (EXPECTED ORDER)" : ""}`,
      isExpectedSequence ? "magenta" : "cyan"
    );

    for (let i = 0; i < sequence.length; i++) {
      const postalCode = sequence[i];
      const availableSlots = this.getAvailableSlots(postalCode, bookedSlots , bookings , coordinates);

      // Check if current position matches expected order
      const positionMatch = this.expectedOrder && 
        this.expectedOrder[i] === postalCode;

      if (availableSlots.length > 0) {
        const selectedSlot = availableSlots[0]; // Always pick first available
        bookedSlots.push(selectedSlot);

        const coord = coordinates[postalCode];
        let distance = 0;

        if (previousCoord) {
          distance = this.calculateDistance(previousCoord, coord);
          totalDistance += distance;
        }

        bookings.push({
          step: i + 1,
          postalCode,
          slot: selectedSlot,
          coordinates: coord,
          distance: distance.toFixed(2),
          matchesExpected: positionMatch,
        });

        const matchIndicator = this.expectedOrder ? 
          (positionMatch ? " ✓" : " ✗") : "";

        this.log(
          `  ${i + 1}. ${postalCode} → ${selectedSlot} ${
            distance > 0 ? `(+${distance.toFixed(2)} km)` : ""
          }${matchIndicator}`,
          positionMatch ? "green" : (this.expectedOrder && !positionMatch ? "yellow" : "green")
        );

        previousCoord = coord;
      } else {
        bookings.push({
          step: i + 1,
          postalCode,
          slot: "NO_SLOT_AVAILABLE",
          coordinates: coordinates[postalCode],
          distance: 0,
          matchesExpected: positionMatch,
        });

        const matchIndicator = this.expectedOrder ? 
          (positionMatch ? " ✓" : " ✗") : "";

        this.log(`  ${i + 1}. ${postalCode} → NO SLOTS AVAILABLE${matchIndicator}`, "red");
        
    }

    }

    // Calculate how many positions match the expected order
    let positionMatches = 0;
    if (this.expectedOrder) {
      for (let i = 0; i < bookings.length; i++) {
        if (bookings[i].postalCode === this.expectedOrder[i]) {
          positionMatches++;
        }
      }
    }

    const result = {
      simulationNumber,
      sequence: sequence.join(" → "),
      bookings,
      totalDistance: totalDistance.toFixed(2),
      successfulBookings: bookings.filter((b) => b.slot !== "NO_SLOT_AVAILABLE")
        .length,
      isExpectedSequence,
      positionMatches: this.expectedOrder ? positionMatches : null,
      positionMatchPercentage: this.expectedOrder ? 
        ((positionMatches / this.expectedOrder.length) * 100).toFixed(1) : null,
    };

    this.log(`  📊 Total Distance: ${totalDistance.toFixed(2)} km`, "yellow");
    this.log(
      `  ✅ Successful Bookings: ${result.successfulBookings}/${bookings.length}`,
      "yellow"
    );

    if (this.expectedOrder) {
      this.log(
        `  🎯 Position Matches: ${positionMatches}/${this.expectedOrder.length} (${result.positionMatchPercentage}%)`,
        positionMatches === this.expectedOrder.length ? "green" : "yellow"
      );
    }

    return result;
  }

  // Main test execution
  async runTests(postalCodes, expectedOrder = null) {
    this.log("\n🚀 Starting Route Optimization Tests", "cyan");
    this.log("=".repeat(60), "cyan");
    this.log(`📮 Postal Codes: ${postalCodes.join(", ")}`, "bright");
    
    if (expectedOrder) {
      this.log(`🎯 Expected Optimal Order: ${expectedOrder.join(" → ")}`, "magenta");
      this.expectedOrder = expectedOrder.map(c => c.toUpperCase());
    }

    try {
      // Step 1: Fetch all coordinates
      this.log("\n📍 Step 1: Fetching coordinates...", "yellow");
      const coordinates = {};
      for (const code of postalCodes) {
        const upperCode = code.toUpperCase();
        console.log(`  • Fetching coordinates for ${upperCode}...`);
        coordinates[upperCode] = await getCoordinatesFromPostalCode(
          upperCode
        );
        this.log(
          `  ✓ ${upperCode}: (${coordinates[upperCode].lat.toFixed(
            4
          )}, ${coordinates[upperCode].lng.toFixed(4)})`,
          "green"
        );
      }

      // Step 2: Generate all permutations
      this.log("\n🔄 Step 2: Generating route permutations...", "yellow");
      const permutations = this.generatePermutations(
        postalCodes.map((c) => c.toUpperCase())
      );
      this.log(`  ✓ Generated ${permutations.length} permutations`, "green");

      if (permutations.length > 20) {
        this.log(
          `  ⚠️  Warning: ${permutations.length} simulations may take time`,
          "yellow"
        );
      }

      // Step 3: Run simulations for each permutation
      this.log("\n🎯 Step 3: Running simulations...", "yellow");
      this.log("-".repeat(60), "yellow");

      const simulationResults = [];
      for (let i = 0; i < permutations.length; i++) {
        const result = await this.runSimulation(
          permutations[i],
          coordinates,
          i + 1
        );
        simulationResults.push(result);
        this.testResults.total++;

        // Small delay to prevent overwhelming logs
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // Sort by total distance (optimal routes first)
      simulationResults.sort(
        (a, b) => parseFloat(a.totalDistance) - parseFloat(b.totalDistance)
      );

      this.testResults.simulations = simulationResults;
      this.testResults.passed = simulationResults.length;

      // Check if optimal route matches expected order
      if (this.expectedOrder) {
        const optimalRoute = simulationResults[0].sequence.split(" → ");
        const expectedSequence = this.expectedOrder.join(" → ");
        const actualSequence = optimalRoute.join(" → ");
        
        if (expectedSequence === actualSequence) {
          this.log("\n✅ OPTIMAL ROUTE MATCHES EXPECTED ORDER!", "green");
          this.testResults.orderMatch = true;
        } else {
          this.log("\n❌ OPTIMAL ROUTE DOES NOT MATCH EXPECTED ORDER", "red");
          this.log(`   Expected: ${expectedSequence}`, "yellow");
          this.log(`   Got:      ${actualSequence}`, "yellow");
          this.testResults.orderMatch = false;
        }
      }

      await this.printSummary(simulationResults);
      await this.saveResults(simulationResults);
    } catch (error) {
      this.log(`❌ Error running tests: ${error.message}`, "red");
      this.testResults.failed++;
    }
  }

  async printSummary(results) {
    return new Promise((resolve) => {
      this.log("\n" + "=".repeat(60), "cyan");
      this.log("📊 OPTIMIZATION RESULTS", "cyan");
      this.log("=".repeat(60), "cyan");

      // Show expected vs actual if expected order was provided
      if (this.expectedOrder) {
        this.log("\n🎯 Expected vs Actual Comparison:", "bright");
        this.log("-".repeat(60), "yellow");
        this.log(`  Expected Order:  ${this.expectedOrder.join(" → ")}`, "magenta");
        this.log(`  Optimal Result:  ${results[0].sequence}`, "cyan");
        
        if (this.testResults.orderMatch) {
          this.log(`  Match Status:    ✅ MATCHED`, "green");
        } else {
          this.log(`  Match Status:    ❌ DID NOT MATCH`, "red");
          
          // Find where expected order ranks
          const expectedSequence = this.expectedOrder.join(" → ");
          const expectedRank = results.findIndex(r => r.sequence === expectedSequence);
          
          if (expectedRank !== -1) {
            this.log(`  Expected Rank:   #${expectedRank + 1} out of ${results.length}`, "yellow");
            this.log(`  Expected Dist:   ${results[expectedRank].totalDistance} km`, "yellow");
            this.log(`  Optimal Dist:    ${results[0].totalDistance} km`, "green");
            const difference = (parseFloat(results[expectedRank].totalDistance) - parseFloat(results[0].totalDistance)).toFixed(2);
            this.log(`  Difference:      +${difference} km (${((difference / parseFloat(results[0].totalDistance)) * 100).toFixed(1)}% more)`, "red");
          }
        }
        this.log("-".repeat(60), "yellow");
      }

      // Show top 3 optimal routes
      this.log("\n🏆 Top 3 Optimal Routes:", "green");
      for (let i = 0; i < Math.min(3, results.length); i++) {
        const result = results[i];
        const isExpected = result.isExpectedSequence;
        this.log(
          `\n  #${i + 1} - Distance: ${result.totalDistance} km ${isExpected ? "⭐ (EXPECTED)" : ""}`,
          isExpected ? "magenta" : "bright"
        );
        this.log(`      Route: ${result.sequence}`, "cyan");
        this.log(
          `      Bookings: ${result.successfulBookings}/${result.bookings.length}`,
          "green"
        );
        
        if (this.expectedOrder) {
          this.log(
            `      Position Matches: ${result.positionMatches}/${this.expectedOrder.length} (${result.positionMatchPercentage}%)`,
            result.positionMatches === this.expectedOrder.length ? "green" : "yellow"
          );
          
          // Show step-by-step comparison
          this.log(`      Step-by-Step:`, "bright");
          for (let j = 0; j < result.bookings.length; j++) {
            const booking = result.bookings[j];
            const expected = this.expectedOrder[j];
            const match = booking.postalCode === expected;
            this.log(
              `        ${j + 1}. ${booking.postalCode} ${match ? "✓" : "✗ (expected: " + expected + ")"}`,
              match ? "green" : "red"
            );
          }
        }
      }

      // Show worst route for comparison
      if (results.length > 1) {
        const worst = results[results.length - 1];
        this.log("\n📉 Least Optimal Route:", "red");
        this.log(`      Distance: ${worst.totalDistance} km`, "bright");
        this.log(`      Route: ${worst.sequence}`, "cyan");
      }

      // Statistics
      const distances = results.map((r) => parseFloat(r.totalDistance));
      const avgDistance = (
        distances.reduce((a, b) => a + b, 0) / distances.length
      ).toFixed(2);
      const improvement = (
        ((parseFloat(worst.totalDistance) - parseFloat(results[0].totalDistance)) /
          parseFloat(worst.totalDistance)) *
        100
      ).toFixed(1);

      this.log("\n📈 Statistics:", "yellow");
      this.log(`  • Total Simulations: ${results.length}`, "bright");
      this.log(`  • Best Distance: ${results[0].totalDistance} km`, "green");
      this.log(
        `  • Worst Distance: ${results[results.length - 1].totalDistance} km`,
        "red"
      );
      this.log(`  • Average Distance: ${avgDistance} km`, "bright");
      this.log(
        `  • Optimization Gain: ${improvement}% reduction`,
        "green"
      );

      if (this.expectedOrder) {
        this.log(
          `  • Expected Order Match: ${this.testResults.orderMatch ? "✅ YES" : "❌ NO"}`,
          this.testResults.orderMatch ? "green" : "red"
        );
      }

      this.log(`\n📝 Full logs saved to: ${this.logFile}`, "cyan");
      this.log(`📄 Results saved to: ${this.resultsFile}`, "cyan");

      this.logStream.end(resolve);
    });
  }

  async saveResults(results) {
    const timestamp = new Date().toISOString().replace(/:/g, "-").split(".")[0];
    const resultsDir = path.join(__dirname, "logs", "route_optimization");
    this.resultsFile = path.join(
      resultsDir,
      `results_${timestamp}.json`
    );

    const output = {
      timestamp: new Date().toISOString(),
      totalSimulations: results.length,
      expectedOrder: this.expectedOrder || null,
      orderMatch: this.testResults.orderMatch || null,
      optimalRoute: results[0],
      allResults: results,
      statistics: {
        bestDistance: results[0].totalDistance,
        worstDistance: results[results.length - 1].totalDistance,
        averageDistance: (
          results.reduce((sum, r) => sum + parseFloat(r.totalDistance), 0) /
          results.length
        ).toFixed(2),
      },
    };

    // If expected order was provided, add comparison data
    if (this.expectedOrder) {
      const expectedSequence = this.expectedOrder.join(" → ");
      const expectedResult = results.find(r => r.sequence === expectedSequence);
      
      if (expectedResult) {
        output.expectedOrderAnalysis = {
          sequence: expectedSequence,
          rank: results.indexOf(expectedResult) + 1,
          distance: expectedResult.totalDistance,
          distanceDifference: (parseFloat(expectedResult.totalDistance) - parseFloat(results[0].totalDistance)).toFixed(2),
          percentageWorse: (((parseFloat(expectedResult.totalDistance) - parseFloat(results[0].totalDistance)) / parseFloat(results[0].totalDistance)) * 100).toFixed(1),
          positionMatches: expectedResult.positionMatches,
          positionMatchPercentage: expectedResult.positionMatchPercentage,
          stepByStepComparison: expectedResult.bookings.map((booking, idx) => ({
            step: idx + 1,
            actual: booking.postalCode,
            expected: this.expectedOrder[idx],
            match: booking.postalCode === this.expectedOrder[idx],
            slot: booking.slot,
            distance: booking.distance,
          })),
        };
      }
    }

    fs.writeFileSync(this.resultsFile, JSON.stringify(output, null, 2));
  }
}

// Interactive CLI
async function interactiveMode() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (query) =>
    new Promise((resolve) => rl.question(query, resolve));

  console.log(`${colors.cyan}
╔═══════════════════════════════════════════════╗
║   Route Optimization Tester - Interactive    ║
╚═══════════════════════════════════════════════╝
${colors.reset}`);

  const input = await question(
    "\nEnter postal codes (comma-separated, e.g., SW1A 1AA, EC1A 1BB):\n> "
  );

  const postalCodes = input
    .split(",")
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code.length > 0);

  if (postalCodes.length === 0) {
    console.log(`${colors.red}No postal codes provided. Exiting.${colors.reset}`);
    rl.close();
    return;
  }

  // Ask for expected order (optional)
  const expectedInput = await question(
    "\nEnter expected optimal order (optional, comma-separated, press Enter to skip):\n> "
  );

  let expectedOrder = null;
  if (expectedInput.trim()) {
    expectedOrder = expectedInput
      .split(",")
      .map((code) => code.trim().toUpperCase())
      .filter((code) => code.length > 0);
    
    // Validate that expected order contains same codes
    const sortedCodes = [...postalCodes].sort().join(",");
    const sortedExpected = [...expectedOrder].sort().join(",");
    
    if (sortedCodes !== sortedExpected) {
      console.log(`${colors.red}Error: Expected order must contain the same postal codes.${colors.reset}`);
      rl.close();
      return;
    }
  }

  const factorial = (n) => (n <= 1 ? 1 : n * factorial(n - 1));
  const permCount = factorial(postalCodes.length);

  console.log(`\n${colors.yellow}Will generate ${permCount} simulations.${colors.reset}`);

  const confirm = await question("Continue? (y/n): ");

  rl.close();

  if (confirm.toLowerCase() === "y") {
    const tester = new RouteOptimizationTester();
    await tester.runTests(postalCodes, expectedOrder);
  } else {
    console.log(`${colors.yellow}Test cancelled.${colors.reset}`);
  }
}

// Predefined test cases
async function runPredefinedTests() {
  const testCases = [
    {
      name: "Small Test (3 locations)",
      postalCodes: ["SW1A 1AA", "EC1A 1BB", "W1A 0AX"],
      expectedOrder: ["SW1A 1AA", "W1A 0AX", "EC1A 1BB"],
    },
    {
      name: "Medium Test (4 locations)",
      postalCodes: ["SW1A 1AA", "EC1A 1BB", "W1A 0AX", "NW1 6XE"],
      expectedOrder: ["SW1A 1AA", "W1A 0AX", "NW1 6XE", "EC1A 1BB"],
    },
    {
      name: "Large Test (5 locations)",
      postalCodes: ["SW1A 1AA", "EC1A 1BB", "W1A 0AX", "NW1 6XE", "SE1 9SG"],
      expectedOrder: null, // No expected order for this test
    },
  ];

  console.log(`${colors.cyan}
╔═══════════════════════════════════════════════╗
║   Route Optimization Tester - Predefined     ║
╚═══════════════════════════════════════════════╝
${colors.reset}`);

  for (const testCase of testCases) {
    console.log(`\n${colors.magenta}Running: ${testCase.name}${colors.reset}`);
    const tester = new RouteOptimizationTester();
    await tester.runTests(testCase.postalCodes, testCase.expectedOrder);
    console.log("\n" + "=".repeat(60) + "\n");
  }
}

// Command line execution
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);

    if (args.includes("--help") || args.includes("-h")) {
      console.log(`
${colors.cyan}Route Optimization Tester${colors.reset}

Usage:
  node route_optimizer_test.js [options]

Options:
  --interactive, -i    Interactive mode (enter postal codes manually)
  --predefined, -p     Run predefined test cases
  --postal "CODE1,CODE2,..."  Run with specific postal codes
  --expected "CODE1,CODE2,..."  Expected optimal order (use with --postal)
  --help, -h           Show this help message

Examples:
  node route_optimizer_test.js --interactive
  node route_optimizer_test.js --postal "SW1A 1AA,EC1A 1BB,W1A 0AX"
  node route_optimizer_test.js --postal "SW1A 1AA,EC1A 1BB,W1A 0AX" --expected "SW1A 1AA,W1A 0AX,EC1A 1BB"
  node route_optimizer_test.js --predefined
      `);
      return;
    }

    if (args.includes("--interactive") || args.includes("-i")) {
      await interactiveMode();
    } else if (args.includes("--predefined") || args.includes("-p")) {
      await runPredefinedTests();
    } else if (args.includes("--postal")) {
      const postalIndex = args.findIndex((arg) => arg === "--postal");
      const expectedIndex = args.findIndex((arg) => arg === "--expected");
      
      if (postalIndex !== -1 && args[postalIndex + 1]) {
        const postalCodes = args[postalIndex + 1]
          .split(",")
          .map((code) => code.trim().toUpperCase());
        
        let expectedOrder = null;
        if (expectedIndex !== -1 && args[expectedIndex + 1]) {
          expectedOrder = args[expectedIndex + 1]
            .split(",")
            .map((code) => code.trim().toUpperCase());
          
          // Validate that expected order contains same codes
          const sortedCodes = [...postalCodes].sort().join(",");
          const sortedExpected = [...expectedOrder].sort().join(",");
          
          if (sortedCodes !== sortedExpected) {
            console.log(`${colors.red}Error: Expected order must contain the same postal codes${colors.reset}`);
            return;
          }
        }
        
        const tester = new RouteOptimizationTester();
        await tester.runTests(postalCodes, expectedOrder);
      } else {
        console.log(`${colors.red}Error: --postal requires postal codes${colors.reset}`);
      }
    } else {
      // Default to interactive mode
      await interactiveMode();
    }
  })();
}

module.exports = RouteOptimizationTester;