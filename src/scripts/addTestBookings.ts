/**
 * Script to add test bookings for multi-resource availability testing
 *
 * Usage: npx tsx src/scripts/addTestBookings.ts
 *
 * This creates bookings that block most of March 2026 for one resource,
 * allowing you to test the multi-resource availability bug fix.
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/user";
import Booking from "../models/booking";
import Project from "../models/project";

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/fixera";

// Test configuration
const PROJECT_ID = "69725e17668c218a4677df53";
const PROFESSIONAL_EMAILS = ["anafariya@gmail.com", "ana@auraehealth.com"];
const CUSTOMER_EMAIL = "test2026@gmail.com";

async function main() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB");

    // Find the professionals
    const professionals = await User.find({ email: { $in: PROFESSIONAL_EMAILS } }).select("_id email name");
    console.log("\nFound professionals:");
    professionals.forEach(p => console.log(`  - ${p.email}: ${p._id}`));

    if (professionals.length < 2) {
      console.error("ERROR: Could not find both professionals. Found:", professionals.length);
      process.exit(1);
    }

    // Find the customer
    const customer = await User.findOne({ email: CUSTOMER_EMAIL }).select("_id email");
    if (!customer) {
      console.error(`ERROR: Could not find customer with email ${CUSTOMER_EMAIL}`);
      process.exit(1);
    }
    console.log(`\nFound customer: ${customer.email}: ${customer._id}`);

    // Find the project
    const project = await Project.findById(PROJECT_ID).select("_id title resources minResources minOverlapPercentage");
    if (!project) {
      console.error(`ERROR: Could not find project with ID ${PROJECT_ID}`);
      process.exit(1);
    }
    console.log(`\nFound project: ${project._id}`);
    console.log(`  - Title: ${(project as any).title || "N/A"}`);
    console.log(`  - Resources: ${project.resources?.length || 0}`);
    console.log(`  - minResources: ${(project as any).minResources || "N/A"}`);
    console.log(`  - minOverlapPercentage: ${(project as any).minOverlapPercentage || "N/A"}`);

    // Choose which professional to block (the first one)
    const professionalToBlock = professionals[0];
    const otherProfessional = professionals[1];

    console.log(`\n--- Creating test bookings to block ${professionalToBlock.email} for most of March 2026 ---`);

    // Create bookings for March 2-20, 2026 (blocking most of March for one resource)
    // This will test the scenario: minResources=2, totalResources=2, 1 resource blocked
    const bookingsToCreate = [
      {
        name: "March Week 1 Block",
        startDate: new Date("2026-03-02T09:00:00Z"),
        endDate: new Date("2026-03-06T17:00:00Z"),
      },
      {
        name: "March Week 2 Block",
        startDate: new Date("2026-03-09T09:00:00Z"),
        endDate: new Date("2026-03-13T17:00:00Z"),
      },
      {
        name: "March Week 3 Block",
        startDate: new Date("2026-03-16T09:00:00Z"),
        endDate: new Date("2026-03-20T17:00:00Z"),
      },
    ];

    const createdBookings: string[] = [];

    for (const bookingData of bookingsToCreate) {
      // Check if booking already exists
      const existingBooking = await Booking.findOne({
        assignedTeamMembers: professionalToBlock._id,
        scheduledStartDate: bookingData.startDate,
        status: { $nin: ["completed", "cancelled", "refunded"] },
      });

      if (existingBooking) {
        console.log(`  Booking "${bookingData.name}" already exists: ${existingBooking._id}`);
        createdBookings.push(String(existingBooking._id));
        continue;
      }

      const booking = new Booking({
        customer: customer._id,
        bookingType: "project",
        project: project._id,
        professional: professionalToBlock._id,
        status: "booked",
        rfqData: {
          serviceType: "Test Service",
          description: `Test booking to block ${professionalToBlock.email} - ${bookingData.name}`,
          answers: [],
        },
        quote: {
          amount: 1000,
          currency: "EUR",
          description: "Test booking quote",
          submittedAt: new Date(),
          submittedBy: professionalToBlock._id,
        },
        location: {
          type: "Point",
          coordinates: [0, 0],
          address: "Test Address",
        },
        scheduledStartDate: bookingData.startDate,
        scheduledExecutionEndDate: bookingData.endDate,
        scheduledBufferStartDate: bookingData.endDate,
        scheduledBufferEndDate: bookingData.endDate,
        assignedTeamMembers: [professionalToBlock._id],
      });

      await booking.save();
      console.log(`  Created booking "${bookingData.name}": ${booking._id}`);
      console.log(`    - Start: ${bookingData.startDate.toISOString()}`);
      console.log(`    - End: ${bookingData.endDate.toISOString()}`);
      console.log(`    - Assigned to: ${professionalToBlock.email}`);
      createdBookings.push(String(booking._id));
    }

    console.log("\n=== TEST SETUP COMPLETE ===\n");
    console.log("Summary:");
    console.log(`  - Project ID: ${PROJECT_ID}`);
    console.log(`  - Blocked Resource: ${professionalToBlock.email} (${professionalToBlock._id})`);
    console.log(`  - Available Resource: ${otherProfessional.email} (${otherProfessional._id})`);
    console.log(`  - Blocked dates: March 2-6, 9-13, 16-20, 2026`);
    console.log(`  - Created ${createdBookings.length} bookings`);

    console.log("\n=== HOW TO TEST ===\n");
    console.log("1. Start the server: npm run dev");
    console.log("2. Login as test2026@gmail.com");
    console.log(`3. Open project ${PROJECT_ID} booking form`);
    console.log("4. Check the calendar for March 2026");
    console.log("\nEXPECTED RESULTS:");
    console.log("  - If minResources=2 and totalResources=2:");
    console.log("    March 2-6, 9-13, 16-20 should be BLOCKED (only 1 resource available)");
    console.log("  - March 23-27, 30-31 should be AVAILABLE (both resources free)");
    console.log("  - Weekends should be BLOCKED");
    console.log("  - Shortest throughput should NOT show a Sunday");
    console.log("\n5. Check server console for debug logs:");
    console.log("   [getProjectTeamAvailability] Project ...");
    console.log("   [getProjectTeamAvailability] Date 2026-03-02: 1/2 available (need 2)");
    console.log("");

    // Cleanup instructions
    console.log("=== TO CLEANUP TEST DATA ===\n");
    console.log("Run this in MongoDB shell or Compass:");
    console.log(`db.bookings.deleteMany({ _id: { $in: [${createdBookings.map(id => `ObjectId("${id}")`).join(", ")}] } })`);

  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("\nDisconnected from MongoDB");
  }
}

main();
