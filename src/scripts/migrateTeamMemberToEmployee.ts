import mongoose from "mongoose";
import User from "../models/user";
import Meeting from "../models/meeting";
import { config } from "dotenv";

config();

/**
 * Migration script to fix role inconsistency.
 * Changes all occurrences of "team_member" role to "employee".
 *
 * Affects:
 * 1. User.role field
 * 2. Meeting.attendees[].role field
 */
async function migrateTeamMemberToEmployee() {
  try {
    console.log("Starting team_member -> employee migration...");

    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error(
        "MONGO_URI or MONGODB_URI not found in environment variables",
      );
    }

    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB");

    let usersMigrated = 0;
    let meetingsMigrated = 0;

    // =====================
    // 1. Migrate Users
    // =====================
    console.log("\n--- Migrating Users ---");

    // Find all users with role "team_member"
    const usersWithTeamMemberRole = await User.find({ role: "team_member" });
    console.log(
      `Found ${usersWithTeamMemberRole.length} users with role "team_member"`,
    );

    if (usersWithTeamMemberRole.length > 0) {
      // Update all users with team_member role to employee
      const userUpdateResult = await User.updateMany(
        { role: "team_member" },
        { $set: { role: "employee" } },
      );
      usersMigrated = userUpdateResult.modifiedCount;
      console.log(
        `Updated ${usersMigrated} users from "team_member" to "employee"`,
      );

      // Log affected user IDs for audit
      console.log("Affected user IDs:");
      usersWithTeamMemberRole.forEach((user) => {
        console.log(`  - ${user._id} (${user.email})`);
      });
    } else {
      console.log("No users found with role 'team_member'");
    }

    // =====================
    // 2. Migrate Meetings
    // =====================
    console.log("\n--- Migrating Meeting Attendees ---");

    // Find all meetings that have attendees with role "team_member"
    const meetingsWithTeamMember = await Meeting.find({
      "attendees.role": "team_member",
    });
    console.log(
      `Found ${meetingsWithTeamMember.length} meetings with "team_member" attendees`,
    );

    if (meetingsWithTeamMember.length > 0) {
      // Update all meeting attendees with team_member role to employee
      const meetingUpdateResult = await Meeting.updateMany(
        { "attendees.role": "team_member" },
        { $set: { "attendees.$[elem].role": "employee" } },
        { arrayFilters: [{ "elem.role": "team_member" }] },
      );
      meetingsMigrated = meetingUpdateResult.modifiedCount;
      console.log(`Updated ${meetingsMigrated} meetings`);

      // Log affected meeting IDs for audit
      console.log("Affected meeting IDs:");
      meetingsWithTeamMember.forEach((meeting) => {
        const teamMemberAttendees = meeting.attendees.filter(
          (a) => (a.role as string) === "team_member",
        );
        console.log(
          `  - Meeting ${meeting._id}: ${teamMemberAttendees.length} attendees updated`,
        );
      });
    } else {
      console.log("No meetings found with 'team_member' attendees");
    }

    // =====================
    // Summary
    // =====================
    console.log("\n--- Migration Summary ---");
    console.log(`  Users migrated: ${usersMigrated}`);
    console.log(`  Meetings migrated: ${meetingsMigrated}`);

    if (usersMigrated === 0 && meetingsMigrated === 0) {
      console.log(
        "\nNo data needed migration. Database is already consistent.",
      );
    } else {
      console.log("\nMigration completed successfully!");
    }

    // Verify no team_member roles remain
    console.log("\n--- Verification ---");
    const remainingUsers = await User.countDocuments({ role: "team_member" });
    const remainingMeetings = await Meeting.countDocuments({
      "attendees.role": "team_member",
    });

    if (remainingUsers === 0 && remainingMeetings === 0) {
      console.log(
        "Verification passed: No 'team_member' roles remaining in database",
      );
    } else {
      console.log(
        `WARNING: Found ${remainingUsers} users and ${remainingMeetings} meetings still with 'team_member' role`,
      );
    }

    // Disconnect
    await mongoose.disconnect();
    console.log("\nDisconnected from MongoDB");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
}

// Run migration if this file is executed directly
if (require.main === module) {
  migrateTeamMemberToEmployee()
    .then(() => {
      console.log("\nMigration script completed");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Migration script failed:", error);
      process.exit(1);
    });
}

export { migrateTeamMemberToEmployee };
