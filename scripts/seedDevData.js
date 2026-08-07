/**
 * Dev Database Seed / Reset Script
 *
 * Drops Bookings, Payments, Users, and ChatLogs collections,
 * then inserts clean dev seed data so the development environment
 * always starts in a usable state.
 *
 * Usage:
 *   node scripts/seedDevData.js          # interactive confirmation
 *   node scripts/seedDevData.js --force  # skip confirmation
 *
 * NOTE: This does NOT touch the Instructors collection.
 *       Use `npm run instructor:add` for that.
 */

require("../src/config/env");
const mongoose = require("mongoose");
const Booking = require("../src/models/bookingModel");
const Payment = require("../src/models/paymentModel");
const User = require("../src/models/userModel");
const Instructor = require("../src/models/instructorSchema");

// ─── Seed Data (functions so instructorId is injected at runtime) ────────────

function getUsers(INSTRUCTOR_ID) { return [
  { phone: "447411223344", instructorId: INSTRUCTOR_ID, name: "Aarav Sharma", age: 22, dob: "2004-03-12", postalCode: "SW1A 1AA", detailsCompleted: true, location: { latitude: 51.5014, longitude: -0.1419 } },
  { phone: "447422334455", instructorId: INSTRUCTOR_ID, name: "Emily Carter", age: 19, dob: "2007-06-08", postalCode: "E1 6AN", detailsCompleted: true, location: { latitude: 51.5155, longitude: -0.0722 } },
  { phone: "447433445566", instructorId: INSTRUCTOR_ID, name: "Rohan Mehta", age: 24, dob: "2002-01-20", postalCode: "N1 9GU", detailsCompleted: true, location: { latitude: 51.5362, longitude: -0.1033 } },
  { phone: "447444556677", instructorId: INSTRUCTOR_ID, name: "Olivia Johnson", age: 20, dob: "2006-09-15", postalCode: "SE1 7PB", detailsCompleted: true, location: { latitude: 51.5045, longitude: -0.0865 } },
  { phone: "447455667788", instructorId: INSTRUCTOR_ID, name: "Priya Patel", age: 17, dob: "2009-04-03", postalCode: "W1D 3AF", detailsCompleted: true, location: { latitude: 51.5134, longitude: -0.1312 } },
  { phone: "447466778899", instructorId: INSTRUCTOR_ID, name: "Michael Anderson", age: 25, dob: "2001-11-28", postalCode: "EC2R 8AH", detailsCompleted: true, location: { latitude: 51.5139, longitude: -0.0831 } },
  { phone: "447477889900", instructorId: INSTRUCTOR_ID, name: "Raj Agrawal", age: 21, dob: "2005-07-22", postalCode: "NW1 8TQ", detailsCompleted: true, location: { latitude: 51.5274, longitude: -0.1339 } },
  { phone: "447488990011", instructorId: INSTRUCTOR_ID, name: "Josh Yarwood", age: 18, dob: "2008-02-14", postalCode: "W2 1JB", detailsCompleted: true, location: { latitude: 51.5154, longitude: -0.1755 } },
]; }

function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

function pastDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function getBookings(INSTRUCTOR_ID) { return [
  // ── Aarav Sharma (447411223344) — 8 completed, 3 upcoming ─────────────
  { bookingId: "DL-A001", userPhone: "447411223344", instructorId: INSTRUCTOR_ID, date: pastDate(42), time: "09:00", status: "completed", postalCode: "SW1A 1AA", pickupLocation: { address: "Buckingham Palace Rd" }, dropoffLocation: { address: "Victoria Station" }, topicsCovered: ["Cockpit drill", "Moving off"], rating: 3, progressNotes: "First lesson. Nervous but got moving by end.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 42 * 86400000) },
  { bookingId: "DL-A002", userPhone: "447411223344", instructorId: INSTRUCTOR_ID, date: pastDate(35), time: "09:00", status: "completed", postalCode: "SW1A 1AA", pickupLocation: { address: "Buckingham Palace Rd" }, dropoffLocation: { address: "Pimlico Rd" }, topicsCovered: ["Steering", "Clutch control"], rating: 3, progressNotes: "Much calmer this week. Steering still jerky.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 35 * 86400000) },
  { bookingId: "DL-A003", userPhone: "447411223344", instructorId: INSTRUCTOR_ID, date: pastDate(28), time: "09:00", status: "completed", postalCode: "SW1A 1AA", pickupLocation: { address: "Buckingham Palace Rd" }, dropoffLocation: { address: "Sloane Square" }, topicsCovered: ["Junctions", "Emerging"], rating: 4, progressNotes: "Good junction observation. Needs mirror checks.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 28 * 86400000) },
  { bookingId: "DL-A004", userPhone: "447411223344", instructorId: INSTRUCTOR_ID, date: pastDate(21), time: "09:00", status: "completed", postalCode: "SW1A 1AA", pickupLocation: { address: "Buckingham Palace Rd" }, dropoffLocation: { address: "Chelsea Bridge" }, topicsCovered: ["Roundabouts", "Lane discipline"], rating: 4, progressNotes: "Roundabouts clicking. Lane changes improved.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 21 * 86400000) },
  { bookingId: "DL-A005", userPhone: "447411223344", instructorId: INSTRUCTOR_ID, date: pastDate(14), time: "09:00", status: "completed", postalCode: "SW1A 1AA", pickupLocation: { address: "Buckingham Palace Rd" }, dropoffLocation: { address: "Victoria Station" }, topicsCovered: ["Junctions", "Roundabouts"], rating: 4, progressNotes: "Excellent progress on roundabouts.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 14 * 86400000) },
  { bookingId: "DL-A006", userPhone: "447411223344", instructorId: INSTRUCTOR_ID, date: pastDate(7), time: "09:00", status: "completed", postalCode: "SW1A 1AA", pickupLocation: { address: "Buckingham Palace Rd" }, dropoffLocation: { address: "Hyde Park Corner" }, topicsCovered: ["Motorway", "Lane discipline"], rating: 4, progressNotes: "First motorway lesson. Handled merging well.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 7 * 86400000) },
  { bookingId: "DL-A007", userPhone: "447411223344", instructorId: INSTRUCTOR_ID, date: pastDate(4), time: "14:00", status: "completed", postalCode: "SW1A 1AA", pickupLocation: { address: "Buckingham Palace Rd" }, dropoffLocation: { address: "Knightsbridge" }, topicsCovered: ["Dual carriageway", "Overtaking"], rating: 5, progressNotes: "Confident overtaking. Very composed.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 4 * 86400000) },
  { bookingId: "DL-A008", userPhone: "447411223344", instructorId: INSTRUCTOR_ID, date: pastDate(1), time: "09:00", status: "completed", postalCode: "SW1A 1AA", pickupLocation: { address: "Buckingham Palace Rd" }, dropoffLocation: { address: "Vauxhall Bridge" }, topicsCovered: ["Independent driving", "Sat nav"], rating: 4, progressNotes: "Good with sat nav. Minor hesitation at unfamiliar junctions.", paymentReceived: false, paymentAmount: 0, completedAt: new Date(Date.now() - 1 * 86400000) },
  { bookingId: "DL-A009", userPhone: "447411223344", instructorId: INSTRUCTOR_ID, date: futureDate(1), time: "09:00", status: "confirmed", postalCode: "SW1A 1AA", pickupLocation: { address: "Buckingham Palace Rd" }, dropoffLocation: { address: "Trafalgar Square" } },
  { bookingId: "DL-A010", userPhone: "447411223344", instructorId: INSTRUCTOR_ID, date: futureDate(5), time: "09:00", status: "confirmed", postalCode: "SW1A 1AA", pickupLocation: { address: "Buckingham Palace Rd" }, dropoffLocation: { address: "Waterloo Bridge" } },
  { bookingId: "DL-A011", userPhone: "447411223344", instructorId: INSTRUCTOR_ID, date: futureDate(12), time: "14:00", status: "confirmed", postalCode: "SW1A 1AA", pickupLocation: { address: "Buckingham Palace Rd" }, dropoffLocation: { address: "Westminster Bridge" } },

  // ── Emily Carter (447422334455) — 5 completed, 2 upcoming, 1 cancelled ─
  { bookingId: "DL-E001", userPhone: "447422334455", instructorId: INSTRUCTOR_ID, date: pastDate(30), time: "10:00", status: "completed", postalCode: "E1 6AN", pickupLocation: { address: "Whitechapel Rd" }, dropoffLocation: { address: "Mile End Rd" }, topicsCovered: ["Cockpit drill", "Moving off"], rating: 3, progressNotes: "Intro lesson. Keen learner.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 30 * 86400000) },
  { bookingId: "DL-E002", userPhone: "447422334455", instructorId: INSTRUCTOR_ID, date: pastDate(23), time: "10:00", status: "completed", postalCode: "E1 6AN", pickupLocation: { address: "Whitechapel Rd" }, dropoffLocation: { address: "Bow Rd" }, topicsCovered: ["Clutch control", "Hill starts"], rating: 3, progressNotes: "Clutch control improving. Hill starts still hesitant.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 23 * 86400000) },
  { bookingId: "DL-E003", userPhone: "447422334455", instructorId: INSTRUCTOR_ID, date: pastDate(16), time: "10:00", status: "completed", postalCode: "E1 6AN", pickupLocation: { address: "Whitechapel Rd" }, dropoffLocation: { address: "Stepney Green" }, topicsCovered: ["Junctions", "Emerging"], rating: 4, progressNotes: "Good progress at junctions. Mirror checks solid.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 16 * 86400000) },
  { bookingId: "DL-E004", userPhone: "447422334455", instructorId: INSTRUCTOR_ID, date: pastDate(10), time: "10:00", status: "completed", postalCode: "E1 6AN", pickupLocation: { address: "Whitechapel Rd" }, dropoffLocation: { address: "Bethnal Green" }, topicsCovered: ["Roundabouts", "Road positioning"], rating: 3, progressNotes: "Needs more roundabout practice. Positioning OK.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 10 * 86400000) },
  { bookingId: "DL-E005", userPhone: "447422334455", instructorId: INSTRUCTOR_ID, date: pastDate(3), time: "10:00", status: "completed", postalCode: "E1 6AN", pickupLocation: { address: "Whitechapel Rd" }, dropoffLocation: { address: "Limehouse" }, topicsCovered: ["Dual carriageway", "Lane discipline"], rating: 4, progressNotes: "Confident on A-roads. Great lane changes.", paymentReceived: false, paymentAmount: 0, completedAt: new Date(Date.now() - 3 * 86400000) },
  { bookingId: "DL-E006", userPhone: "447422334455", instructorId: INSTRUCTOR_ID, date: pastDate(6), time: "14:00", status: "cancelled", postalCode: "E1 6AN", pickupLocation: { address: "Whitechapel Rd" }, dropoffLocation: { address: "Canary Wharf" } },
  { bookingId: "DL-E007", userPhone: "447422334455", instructorId: INSTRUCTOR_ID, date: futureDate(2), time: "10:00", status: "confirmed", postalCode: "E1 6AN", pickupLocation: { address: "Whitechapel Rd" }, dropoffLocation: { address: "Stratford" } },
  { bookingId: "DL-E008", userPhone: "447422334455", instructorId: INSTRUCTOR_ID, date: futureDate(9), time: "10:00", status: "confirmed", postalCode: "E1 6AN", pickupLocation: { address: "Whitechapel Rd" }, dropoffLocation: { address: "Victoria Park" } },

  // ── Rohan Mehta (447433445566) — 7 completed, 2 upcoming ──────────────
  { bookingId: "DL-R001", userPhone: "447433445566", instructorId: INSTRUCTOR_ID, date: pastDate(45), time: "11:00", status: "completed", postalCode: "N1 9GU", pickupLocation: { address: "Upper St" }, dropoffLocation: { address: "Highbury Corner" }, topicsCovered: ["Cockpit drill", "Moving off"], rating: 4, progressNotes: "Smooth start. Previous cycling helps.", paymentReceived: true, paymentAmount: 48, completedAt: new Date(Date.now() - 45 * 86400000) },
  { bookingId: "DL-R002", userPhone: "447433445566", instructorId: INSTRUCTOR_ID, date: pastDate(38), time: "11:00", status: "completed", postalCode: "N1 9GU", pickupLocation: { address: "Upper St" }, dropoffLocation: { address: "Canonbury" }, topicsCovered: ["Steering", "Road positioning"], rating: 4, progressNotes: "Good awareness. Slight speed management issue.", paymentReceived: true, paymentAmount: 48, completedAt: new Date(Date.now() - 38 * 86400000) },
  { bookingId: "DL-R003", userPhone: "447433445566", instructorId: INSTRUCTOR_ID, date: pastDate(31), time: "11:00", status: "completed", postalCode: "N1 9GU", pickupLocation: { address: "Upper St" }, dropoffLocation: { address: "Holloway Rd" }, topicsCovered: ["Roundabouts", "Mini roundabouts"], rating: 5, progressNotes: "Nailed mini roundabouts straight away.", paymentReceived: true, paymentAmount: 48, completedAt: new Date(Date.now() - 31 * 86400000) },
  { bookingId: "DL-R004", userPhone: "447433445566", instructorId: INSTRUCTOR_ID, date: pastDate(24), time: "11:00", status: "completed", postalCode: "N1 9GU", pickupLocation: { address: "Upper St" }, dropoffLocation: { address: "Finsbury Park" }, topicsCovered: ["Parallel parking", "Bay parking"], rating: 4, progressNotes: "Parallel solid. Bay needs one more go.", paymentReceived: true, paymentAmount: 48, completedAt: new Date(Date.now() - 24 * 86400000) },
  { bookingId: "DL-R005", userPhone: "447433445566", instructorId: INSTRUCTOR_ID, date: pastDate(21), time: "10:00", status: "completed", postalCode: "N1 9GU", pickupLocation: { address: "Upper St" }, dropoffLocation: { address: "Angel Station" }, topicsCovered: ["Test prep", "Manoeuvres"], rating: 5, progressNotes: "All manoeuvres clean. Nearly test-ready.", paymentReceived: true, paymentAmount: 48, completedAt: new Date(Date.now() - 21 * 86400000) },
  { bookingId: "DL-R006", userPhone: "447433445566", instructorId: INSTRUCTOR_ID, date: pastDate(14), time: "11:00", status: "completed", postalCode: "N1 9GU", pickupLocation: { address: "Upper St" }, dropoffLocation: { address: "Kings Cross" }, topicsCovered: ["Independent driving", "Sat nav"], rating: 5, progressNotes: "Mock test route — only 2 minors.", paymentReceived: true, paymentAmount: 48, completedAt: new Date(Date.now() - 14 * 86400000) },
  { bookingId: "DL-R007", userPhone: "447433445566", instructorId: INSTRUCTOR_ID, date: pastDate(7), time: "11:00", status: "completed", postalCode: "N1 9GU", pickupLocation: { address: "Upper St" }, dropoffLocation: { address: "Archway" }, topicsCovered: ["Test prep", "Show-me tell-me"], rating: 5, progressNotes: "Test ready. Final polish session.", paymentReceived: true, paymentAmount: 48, completedAt: new Date(Date.now() - 7 * 86400000) },
  { bookingId: "DL-R008", userPhone: "447433445566", instructorId: INSTRUCTOR_ID, date: futureDate(1), time: "11:00", status: "confirmed", postalCode: "N1 9GU", pickupLocation: { address: "Upper St" }, dropoffLocation: { address: "Highbury Corner" } },
  { bookingId: "DL-R009", userPhone: "447433445566", instructorId: INSTRUCTOR_ID, date: futureDate(8), time: "11:00", status: "confirmed", postalCode: "N1 9GU", pickupLocation: { address: "Upper St" }, dropoffLocation: { address: "Finsbury Park" } },

  // ── Olivia Johnson (447444556677) — 4 completed, 2 upcoming, 2 cancelled
  { bookingId: "DL-O001", userPhone: "447444556677", instructorId: INSTRUCTOR_ID, date: pastDate(25), time: "08:30", status: "completed", postalCode: "SE1 7PB", pickupLocation: { address: "Borough High St" }, dropoffLocation: { address: "Elephant & Castle" }, topicsCovered: ["Cockpit drill", "Moving off"], rating: 3, progressNotes: "Intro session. Very cautious, needs confidence.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 25 * 86400000) },
  { bookingId: "DL-O002", userPhone: "447444556677", instructorId: INSTRUCTOR_ID, date: pastDate(18), time: "08:30", status: "completed", postalCode: "SE1 7PB", pickupLocation: { address: "Borough High St" }, dropoffLocation: { address: "Bermondsey" }, topicsCovered: ["Clutch control", "Steering"], rating: 3, progressNotes: "Better confidence. Clutch still rough.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 18 * 86400000) },
  { bookingId: "DL-O003", userPhone: "447444556677", instructorId: INSTRUCTOR_ID, date: pastDate(11), time: "15:00", status: "cancelled", postalCode: "SE1 7PB", pickupLocation: { address: "Borough High St" }, dropoffLocation: { address: "Peckham" } },
  { bookingId: "DL-O004", userPhone: "447444556677", instructorId: INSTRUCTOR_ID, date: pastDate(5), time: "08:30", status: "completed", postalCode: "SE1 7PB", pickupLocation: { address: "Borough High St" }, dropoffLocation: { address: "London Bridge" }, topicsCovered: ["Town driving", "Roundabouts"], rating: 3, progressNotes: "Roundabouts improving. Stalled once — nerves.", paymentReceived: false, paymentAmount: 0, completedAt: new Date(Date.now() - 5 * 86400000) },
  { bookingId: "DL-O005", userPhone: "447444556677", instructorId: INSTRUCTOR_ID, date: pastDate(3), time: "14:00", status: "cancelled", postalCode: "SE1 7PB", pickupLocation: { address: "Borough High St" }, dropoffLocation: { address: "Bermondsey" } },
  { bookingId: "DL-O006", userPhone: "447444556677", instructorId: INSTRUCTOR_ID, date: pastDate(2), time: "08:30", status: "completed", postalCode: "SE1 7PB", pickupLocation: { address: "Borough High St" }, dropoffLocation: { address: "Walworth Rd" }, topicsCovered: ["Junctions", "Emerging"], rating: 4, progressNotes: "Big improvement! Junctions much smoother.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 2 * 86400000) },
  { bookingId: "DL-O007", userPhone: "447444556677", instructorId: INSTRUCTOR_ID, date: futureDate(3), time: "08:30", status: "confirmed", postalCode: "SE1 7PB", pickupLocation: { address: "Borough High St" }, dropoffLocation: { address: "Elephant & Castle" } },
  { bookingId: "DL-O008", userPhone: "447444556677", instructorId: INSTRUCTOR_ID, date: futureDate(10), time: "08:30", status: "confirmed", postalCode: "SE1 7PB", pickupLocation: { address: "Borough High St" }, dropoffLocation: { address: "Camberwell" } },

  // ── Priya Patel (447455667788) — 3 completed, 3 upcoming ──────────────
  { bookingId: "DL-P001", userPhone: "447455667788", instructorId: INSTRUCTOR_ID, date: pastDate(15), time: "09:00", status: "completed", postalCode: "W1D 3AF", pickupLocation: { address: "Oxford St" }, dropoffLocation: { address: "Regent St" }, topicsCovered: ["Cockpit drill", "Moving off"], rating: 4, progressNotes: "Confident from the start. Great attitude.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 15 * 86400000) },
  { bookingId: "DL-P002", userPhone: "447455667788", instructorId: INSTRUCTOR_ID, date: pastDate(8), time: "09:00", status: "completed", postalCode: "W1D 3AF", pickupLocation: { address: "Oxford St" }, dropoffLocation: { address: "Soho Square" }, topicsCovered: ["Clutch control", "Road positioning"], rating: 3, progressNotes: "City traffic tricky but handled it well.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 8 * 86400000) },
  { bookingId: "DL-P003", userPhone: "447455667788", instructorId: INSTRUCTOR_ID, date: pastDate(2), time: "15:00", status: "completed", postalCode: "W1D 3AF", pickupLocation: { address: "Oxford St" }, dropoffLocation: { address: "Marylebone" }, topicsCovered: ["Junctions", "Traffic lights"], rating: 4, progressNotes: "Traffic lights timing good. Junction approach solid.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 2 * 86400000) },
  { bookingId: "DL-P004", userPhone: "447455667788", instructorId: INSTRUCTOR_ID, date: futureDate(1), time: "15:00", status: "confirmed", postalCode: "W1D 3AF", pickupLocation: { address: "Oxford St" }, dropoffLocation: { address: "Tottenham Court Rd" } },
  { bookingId: "DL-P005", userPhone: "447455667788", instructorId: INSTRUCTOR_ID, date: futureDate(6), time: "09:00", status: "confirmed", postalCode: "W1D 3AF", pickupLocation: { address: "Oxford St" }, dropoffLocation: { address: "Baker St" } },
  { bookingId: "DL-P006", userPhone: "447455667788", instructorId: INSTRUCTOR_ID, date: futureDate(13), time: "09:00", status: "confirmed", postalCode: "W1D 3AF", pickupLocation: { address: "Oxford St" }, dropoffLocation: { address: "Fitzrovia" } },

  // ── Michael Anderson (447466778899) — 6 completed, 3 upcoming ─────────
  { bookingId: "DL-M001", userPhone: "447466778899", instructorId: INSTRUCTOR_ID, date: pastDate(40), time: "09:00", status: "completed", postalCode: "EC2R 8AH", pickupLocation: { address: "Moorgate" }, dropoffLocation: { address: "Old St" }, topicsCovered: ["Cockpit drill", "Moving off"], rating: 4, progressNotes: "Previously drove abroad. Good foundation.", paymentReceived: true, paymentAmount: 48, completedAt: new Date(Date.now() - 40 * 86400000) },
  { bookingId: "DL-M002", userPhone: "447466778899", instructorId: INSTRUCTOR_ID, date: pastDate(33), time: "09:00", status: "completed", postalCode: "EC2R 8AH", pickupLocation: { address: "Moorgate" }, dropoffLocation: { address: "Shoreditch High St" }, topicsCovered: ["Junctions", "Roundabouts"], rating: 4, progressNotes: "Adjusting to UK roads well. Roundabouts need work.", paymentReceived: true, paymentAmount: 48, completedAt: new Date(Date.now() - 33 * 86400000) },
  { bookingId: "DL-M003", userPhone: "447466778899", instructorId: INSTRUCTOR_ID, date: pastDate(26), time: "09:00", status: "completed", postalCode: "EC2R 8AH", pickupLocation: { address: "Moorgate" }, dropoffLocation: { address: "Bank" }, topicsCovered: ["Town driving", "Bus lanes"], rating: 3, progressNotes: "Bus lane rules tricky. Town driving OK.", paymentReceived: true, paymentAmount: 48, completedAt: new Date(Date.now() - 26 * 86400000) },
  { bookingId: "DL-M004", userPhone: "447466778899", instructorId: INSTRUCTOR_ID, date: pastDate(19), time: "09:00", status: "completed", postalCode: "EC2R 8AH", pickupLocation: { address: "Moorgate" }, dropoffLocation: { address: "Clerkenwell" }, topicsCovered: ["Parallel parking", "Bay parking"], rating: 3, progressNotes: "Bay parking solid. Parallel needs work.", paymentReceived: true, paymentAmount: 48, completedAt: new Date(Date.now() - 19 * 86400000) },
  { bookingId: "DL-M005", userPhone: "447466778899", instructorId: INSTRUCTOR_ID, date: pastDate(12), time: "09:00", status: "completed", postalCode: "EC2R 8AH", pickupLocation: { address: "Moorgate" }, dropoffLocation: { address: "Barbican" }, topicsCovered: ["Motorway", "Lane discipline"], rating: 4, progressNotes: "Motorway driving strong. Good mirror use.", paymentReceived: true, paymentAmount: 48, completedAt: new Date(Date.now() - 12 * 86400000) },
  { bookingId: "DL-M006", userPhone: "447466778899", instructorId: INSTRUCTOR_ID, date: pastDate(5), time: "11:30", status: "completed", postalCode: "EC2R 8AH", pickupLocation: { address: "Moorgate" }, dropoffLocation: { address: "Liverpool St" }, topicsCovered: ["Independent driving", "Test prep"], rating: 4, progressNotes: "Test route practice. 4 minors — needs polish.", paymentReceived: false, paymentAmount: 0, completedAt: new Date(Date.now() - 5 * 86400000) },
  { bookingId: "DL-M007", userPhone: "447466778899", instructorId: INSTRUCTOR_ID, date: futureDate(2), time: "09:00", status: "confirmed", postalCode: "EC2R 8AH", pickupLocation: { address: "Moorgate" }, dropoffLocation: { address: "Farringdon" } },
  { bookingId: "DL-M008", userPhone: "447466778899", instructorId: INSTRUCTOR_ID, date: futureDate(7), time: "11:30", status: "confirmed", postalCode: "EC2R 8AH", pickupLocation: { address: "Moorgate" }, dropoffLocation: { address: "Barbican" } },
  { bookingId: "DL-M009", userPhone: "447466778899", instructorId: INSTRUCTOR_ID, date: futureDate(14), time: "09:00", status: "confirmed", postalCode: "EC2R 8AH", pickupLocation: { address: "Moorgate" }, dropoffLocation: { address: "Liverpool St" } },

  // ── Raj Agrawal (447477889900) — 5 completed, 3 upcoming, 1 cancelled ──
  { bookingId: "DL-RJ01", userPhone: "447477889900", instructorId: INSTRUCTOR_ID, date: pastDate(35), time: "13:00", status: "completed", postalCode: "NW1 8TQ", pickupLocation: { address: "Camden High St" }, dropoffLocation: { address: "Regent's Park" }, topicsCovered: ["Cockpit drill", "Moving off"], rating: 4, progressNotes: "Confident from the start. Good spatial awareness.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 35 * 86400000) },
  { bookingId: "DL-RJ02", userPhone: "447477889900", instructorId: INSTRUCTOR_ID, date: pastDate(28), time: "13:00", status: "completed", postalCode: "NW1 8TQ", pickupLocation: { address: "Camden High St" }, dropoffLocation: { address: "Primrose Hill" }, topicsCovered: ["Steering", "Road positioning"], rating: 4, progressNotes: "Smooth steering. Positioning on narrow roads needs work.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 28 * 86400000) },
  { bookingId: "DL-RJ03", userPhone: "447477889900", instructorId: INSTRUCTOR_ID, date: pastDate(21), time: "13:00", status: "completed", postalCode: "NW1 8TQ", pickupLocation: { address: "Camden High St" }, dropoffLocation: { address: "Kentish Town" }, topicsCovered: ["Junctions", "Roundabouts"], rating: 5, progressNotes: "Excellent junction work. Picks things up fast.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 21 * 86400000) },
  { bookingId: "DL-RJ04", userPhone: "447477889900", instructorId: INSTRUCTOR_ID, date: pastDate(14), time: "13:00", status: "completed", postalCode: "NW1 8TQ", pickupLocation: { address: "Camden High St" }, dropoffLocation: { address: "Swiss Cottage" }, topicsCovered: ["Dual carriageway", "Lane discipline"], rating: 4, progressNotes: "A11 practice. Good lane changes, mirror checks solid.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 14 * 86400000) },
  { bookingId: "DL-RJ05", userPhone: "447477889900", instructorId: INSTRUCTOR_ID, date: pastDate(7), time: "13:00", status: "completed", postalCode: "NW1 8TQ", pickupLocation: { address: "Camden High St" }, dropoffLocation: { address: "Hampstead" }, topicsCovered: ["Parallel parking", "Bay parking"], rating: 4, progressNotes: "Parallel solid first try. Bay needs one more session.", paymentReceived: false, paymentAmount: 0, completedAt: new Date(Date.now() - 7 * 86400000) },
  { bookingId: "DL-RJ06", userPhone: "447477889900", instructorId: INSTRUCTOR_ID, date: pastDate(10), time: "15:00", status: "cancelled", postalCode: "NW1 8TQ", pickupLocation: { address: "Camden High St" }, dropoffLocation: { address: "Chalk Farm" } },
  { bookingId: "DL-RJ07", userPhone: "447477889900", instructorId: INSTRUCTOR_ID, date: futureDate(1), time: "13:00", status: "confirmed", postalCode: "NW1 8TQ", pickupLocation: { address: "Camden High St" }, dropoffLocation: { address: "King's Cross" } },
  { bookingId: "DL-RJ08", userPhone: "447477889900", instructorId: INSTRUCTOR_ID, date: futureDate(4), time: "13:00", status: "confirmed", postalCode: "NW1 8TQ", pickupLocation: { address: "Camden High St" }, dropoffLocation: { address: "Holloway Rd" } },
  { bookingId: "DL-RJ09", userPhone: "447477889900", instructorId: INSTRUCTOR_ID, date: futureDate(11), time: "13:00", status: "confirmed", postalCode: "NW1 8TQ", pickupLocation: { address: "Camden High St" }, dropoffLocation: { address: "Finchley Rd" } },

  // ── Josh Williams (447488990011) — 4 completed, 2 upcoming ────────────
  { bookingId: "DL-JW01", userPhone: "447488990011", instructorId: INSTRUCTOR_ID, date: pastDate(22), time: "16:00", status: "completed", postalCode: "W2 1JB", pickupLocation: { address: "Paddington Station" }, dropoffLocation: { address: "Bayswater" }, topicsCovered: ["Cockpit drill", "Moving off"], rating: 3, progressNotes: "Brand new driver. Nervous but listened well.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 22 * 86400000) },
  { bookingId: "DL-JW02", userPhone: "447488990011", instructorId: INSTRUCTOR_ID, date: pastDate(15), time: "16:00", status: "completed", postalCode: "W2 1JB", pickupLocation: { address: "Paddington Station" }, dropoffLocation: { address: "Queensway" }, topicsCovered: ["Clutch control", "Hill starts"], rating: 3, progressNotes: "Hill starts shaky. Stalled twice but recovered.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 15 * 86400000) },
  { bookingId: "DL-JW03", userPhone: "447488990011", instructorId: INSTRUCTOR_ID, date: pastDate(8), time: "16:00", status: "completed", postalCode: "W2 1JB", pickupLocation: { address: "Paddington Station" }, dropoffLocation: { address: "Marble Arch" }, topicsCovered: ["Junctions", "Traffic lights"], rating: 4, progressNotes: "Big leap forward! Junctions much better.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 8 * 86400000) },
  { bookingId: "DL-JW04", userPhone: "447488990011", instructorId: INSTRUCTOR_ID, date: pastDate(2), time: "16:00", status: "completed", postalCode: "W2 1JB", pickupLocation: { address: "Paddington Station" }, dropoffLocation: { address: "Lancaster Gate" }, topicsCovered: ["Roundabouts", "Road positioning"], rating: 3, progressNotes: "Roundabouts need more practice. Positioning improving.", paymentReceived: false, paymentAmount: 0, completedAt: new Date(Date.now() - 2 * 86400000) },
  { bookingId: "DL-JW05", userPhone: "447488990011", instructorId: INSTRUCTOR_ID, date: futureDate(3), time: "16:00", status: "confirmed", postalCode: "W2 1JB", pickupLocation: { address: "Paddington Station" }, dropoffLocation: { address: "Notting Hill Gate" } },
  { bookingId: "DL-JW06", userPhone: "447488990011", instructorId: INSTRUCTOR_ID, date: futureDate(10), time: "16:00", status: "confirmed", postalCode: "W2 1JB", pickupLocation: { address: "Paddington Station" }, dropoffLocation: { address: "Shepherd's Bush" } },
]; }

function getPayments(INSTRUCTOR_ID) { return [
  // ── Aarav — block payment + per-lesson payments ──
  { paymentId: "PAY-A-BLK1", instructorId: INSTRUCTOR_ID, userPhone: "447411223344", bookingId: null, amount: 180, method: "bank", date: pastDate(43), note: "Block of 4 lessons upfront" },
  { paymentId: "PAY-A001", instructorId: INSTRUCTOR_ID, userPhone: "447411223344", bookingId: "DL-A001", amount: 45, method: "cash", date: pastDate(42), note: "Received at lesson" },
  { paymentId: "PAY-A002", instructorId: INSTRUCTOR_ID, userPhone: "447411223344", bookingId: "DL-A002", amount: 45, method: "cash", date: pastDate(35), note: "Received at lesson" },
  { paymentId: "PAY-A003", instructorId: INSTRUCTOR_ID, userPhone: "447411223344", bookingId: "DL-A003", amount: 45, method: "cash", date: pastDate(28), note: "Received at lesson" },
  { paymentId: "PAY-A004", instructorId: INSTRUCTOR_ID, userPhone: "447411223344", bookingId: "DL-A004", amount: 45, method: "bank", date: pastDate(21), note: "Received at lesson" },
  { paymentId: "PAY-A005", instructorId: INSTRUCTOR_ID, userPhone: "447411223344", bookingId: "DL-A005", amount: 45, method: "cash", date: pastDate(14), note: "Received at lesson" },
  { paymentId: "PAY-A006", instructorId: INSTRUCTOR_ID, userPhone: "447411223344", bookingId: "DL-A006", amount: 45, method: "bank", date: pastDate(7), note: "Received at lesson" },
  { paymentId: "PAY-A007", instructorId: INSTRUCTOR_ID, userPhone: "447411223344", bookingId: "DL-A007", amount: 45, method: "cash", date: pastDate(4), note: "Received at lesson" },

  // ── Emily — per-lesson payments ──
  { paymentId: "PAY-E001", instructorId: INSTRUCTOR_ID, userPhone: "447422334455", bookingId: "DL-E001", amount: 45, method: "cash", date: pastDate(30), note: "Received at lesson" },
  { paymentId: "PAY-E002", instructorId: INSTRUCTOR_ID, userPhone: "447422334455", bookingId: "DL-E002", amount: 45, method: "cash", date: pastDate(23), note: "Received at lesson" },
  { paymentId: "PAY-E003", instructorId: INSTRUCTOR_ID, userPhone: "447422334455", bookingId: "DL-E003", amount: 45, method: "bank", date: pastDate(16), note: "Received at lesson" },
  { paymentId: "PAY-E004", instructorId: INSTRUCTOR_ID, userPhone: "447422334455", bookingId: "DL-E004", amount: 45, method: "cash", date: pastDate(10), note: "Received at lesson" },

  // ── Rohan — block payment + per-lesson ──
  { paymentId: "PAY-R-BLK1", instructorId: INSTRUCTOR_ID, userPhone: "447433445566", bookingId: null, amount: 240, method: "bank", date: pastDate(46), note: "Block of 5 lessons" },
  { paymentId: "PAY-R001", instructorId: INSTRUCTOR_ID, userPhone: "447433445566", bookingId: "DL-R001", amount: 48, method: "cash", date: pastDate(45), note: "Received at lesson" },
  { paymentId: "PAY-R002", instructorId: INSTRUCTOR_ID, userPhone: "447433445566", bookingId: "DL-R002", amount: 48, method: "cash", date: pastDate(38), note: "Received at lesson" },
  { paymentId: "PAY-R003", instructorId: INSTRUCTOR_ID, userPhone: "447433445566", bookingId: "DL-R003", amount: 48, method: "bank", date: pastDate(31), note: "Received at lesson" },
  { paymentId: "PAY-R004", instructorId: INSTRUCTOR_ID, userPhone: "447433445566", bookingId: "DL-R004", amount: 48, method: "cash", date: pastDate(24), note: "Received at lesson" },
  { paymentId: "PAY-R005", instructorId: INSTRUCTOR_ID, userPhone: "447433445566", bookingId: "DL-R005", amount: 48, method: "bank", date: pastDate(21), note: "Received at lesson" },
  { paymentId: "PAY-R006", instructorId: INSTRUCTOR_ID, userPhone: "447433445566", bookingId: "DL-R006", amount: 48, method: "cash", date: pastDate(14), note: "Received at lesson" },
  { paymentId: "PAY-R007", instructorId: INSTRUCTOR_ID, userPhone: "447433445566", bookingId: "DL-R007", amount: 48, method: "bank", date: pastDate(7), note: "Received at lesson" },

  // ── Olivia — per-lesson payments ──
  { paymentId: "PAY-O001", instructorId: INSTRUCTOR_ID, userPhone: "447444556677", bookingId: "DL-O001", amount: 45, method: "cash", date: pastDate(25), note: "Received at lesson" },
  { paymentId: "PAY-O002", instructorId: INSTRUCTOR_ID, userPhone: "447444556677", bookingId: "DL-O002", amount: 45, method: "cash", date: pastDate(18), note: "Received at lesson" },
  { paymentId: "PAY-O006", instructorId: INSTRUCTOR_ID, userPhone: "447444556677", bookingId: "DL-O006", amount: 45, method: "bank", date: pastDate(2), note: "Received at lesson" },

  // ── Priya — per-lesson payments ──
  { paymentId: "PAY-P001", instructorId: INSTRUCTOR_ID, userPhone: "447455667788", bookingId: "DL-P001", amount: 45, method: "cash", date: pastDate(15), note: "Received at lesson" },
  { paymentId: "PAY-P002", instructorId: INSTRUCTOR_ID, userPhone: "447455667788", bookingId: "DL-P002", amount: 45, method: "cash", date: pastDate(8), note: "Received at lesson" },
  { paymentId: "PAY-P003", instructorId: INSTRUCTOR_ID, userPhone: "447455667788", bookingId: "DL-P003", amount: 45, method: "bank", date: pastDate(2), note: "Received at lesson" },

  // ── Michael — block payment + per-lesson ──
  { paymentId: "PAY-M-BLK1", instructorId: INSTRUCTOR_ID, userPhone: "447466778899", bookingId: null, amount: 192, method: "bank", date: pastDate(41), note: "Block of 4 lessons" },
  { paymentId: "PAY-M001", instructorId: INSTRUCTOR_ID, userPhone: "447466778899", bookingId: "DL-M001", amount: 48, method: "cash", date: pastDate(40), note: "Received at lesson" },
  { paymentId: "PAY-M002", instructorId: INSTRUCTOR_ID, userPhone: "447466778899", bookingId: "DL-M002", amount: 48, method: "cash", date: pastDate(33), note: "Received at lesson" },
  { paymentId: "PAY-M003", instructorId: INSTRUCTOR_ID, userPhone: "447466778899", bookingId: "DL-M003", amount: 48, method: "bank", date: pastDate(26), note: "Received at lesson" },
  { paymentId: "PAY-M004", instructorId: INSTRUCTOR_ID, userPhone: "447466778899", bookingId: "DL-M004", amount: 48, method: "cash", date: pastDate(19), note: "Received at lesson" },
  { paymentId: "PAY-M005", instructorId: INSTRUCTOR_ID, userPhone: "447466778899", bookingId: "DL-M005", amount: 48, method: "bank", date: pastDate(12), note: "Received at lesson" },

  // ── Raj — block payment + per-lesson ──
  { paymentId: "PAY-RJ-BLK", instructorId: INSTRUCTOR_ID, userPhone: "447477889900", bookingId: null, amount: 180, method: "bank", date: pastDate(36), note: "Block of 4 lessons" },
  { paymentId: "PAY-RJ01", instructorId: INSTRUCTOR_ID, userPhone: "447477889900", bookingId: "DL-RJ01", amount: 45, method: "cash", date: pastDate(35), note: "Received at lesson" },
  { paymentId: "PAY-RJ02", instructorId: INSTRUCTOR_ID, userPhone: "447477889900", bookingId: "DL-RJ02", amount: 45, method: "cash", date: pastDate(28), note: "Received at lesson" },
  { paymentId: "PAY-RJ03", instructorId: INSTRUCTOR_ID, userPhone: "447477889900", bookingId: "DL-RJ03", amount: 45, method: "bank", date: pastDate(21), note: "Received at lesson" },
  { paymentId: "PAY-RJ04", instructorId: INSTRUCTOR_ID, userPhone: "447477889900", bookingId: "DL-RJ04", amount: 45, method: "cash", date: pastDate(14), note: "Received at lesson" },

  // ── Josh — per-lesson payments ──
  { paymentId: "PAY-JW01", instructorId: INSTRUCTOR_ID, userPhone: "447488990011", bookingId: "DL-JW01", amount: 45, method: "cash", date: pastDate(22), note: "Received at lesson" },
  { paymentId: "PAY-JW02", instructorId: INSTRUCTOR_ID, userPhone: "447488990011", bookingId: "DL-JW02", amount: 45, method: "cash", date: pastDate(15), note: "Received at lesson" },
  { paymentId: "PAY-JW03", instructorId: INSTRUCTOR_ID, userPhone: "447488990011", bookingId: "DL-JW03", amount: 45, method: "bank", date: pastDate(8), note: "Received at lesson" },
]; }

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const force = process.argv.includes("--force");

  if (!force) {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => {
      rl.question("⚠️  This will DROP Bookings, Payments, Users & ChatLogs collections. Continue? (y/N) ", resolve);
    });
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("❌ MONGO_URI not set in .env");
    process.exit(1);
  }

  const opts = {};
  if (process.env.DB_NAME) opts.dbName = process.env.DB_NAME;

  await mongoose.connect(uri, opts);
  console.log("✅ Connected to MongoDB");
  console.log(`   URI: ${uri.replace(/\/\/.*@/, "//***:***@")}`);
  console.log(`   Database: ${mongoose.connection.name}`);
  console.log(`   Host: ${mongoose.connection.host}`);

  // Look up the instructor from DB to get the real phoneNumberId
  const instructor = await Instructor.findOne({ active: true }).lean();
  if (!instructor) {
    console.error("❌ No active instructor found in DB. Run 'npm run instructor:add' first.");
    await mongoose.disconnect();
    process.exit(1);
  }
  const INSTRUCTOR_ID = instructor.phoneNumberId;
  console.log(`   Instructor: ${instructor.name} (${INSTRUCTOR_ID})`);

  // Build seed data with the real instructor ID
  const USERS = getUsers(INSTRUCTOR_ID);
  const BOOKINGS = getBookings(INSTRUCTOR_ID);
  const PAYMENTS = getPayments(INSTRUCTOR_ID);

  // Drop collections (ignore errors if they don't exist)
  const drops = ["bookings", "payments", "users", "chatlogs"];
  for (const name of drops) {
    try {
      await mongoose.connection.db.dropCollection(name);
      console.log(`   🗑️  Dropped ${name}`);
    } catch {
      console.log(`   ⏭️  ${name} — doesn't exist, skipping`);
    }
  }

  // Insert seed data
  await User.insertMany(USERS);
  console.log(`   ✅ Inserted ${USERS.length} users`);

  await Booking.insertMany(BOOKINGS);
  console.log(`   ✅ Inserted ${BOOKINGS.length} bookings`);

  await Payment.insertMany(PAYMENTS);
  console.log(`   ✅ Inserted ${PAYMENTS.length} payments`);

  console.log("\n🎉 Dev database seeded successfully!");
  console.log(`   Instructor: ${instructor.name} (${INSTRUCTOR_ID})`);
  console.log(`   Users: ${USERS.length} | Bookings: ${BOOKINGS.length} | Payments: ${PAYMENTS.length}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error("❌ Seed script failed:", err.message);
  process.exit(1);
});
