// Fix Solar PV & Battery Storage Duplicates
// This script merges the 3 duplicate "Solar PV & Battery Storage" services

const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

async function fixSolarDuplicates() {
  console.log("🔧 Starting Solar PV & Battery Storage duplicates fix...");
  
  if (!process.env.MONGODB_URI) {
    console.error("❌ MONGODB_URI not found in environment variables");
    return;
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB");
    
    const db = client.db();
    
    // 1. Find all Solar PV & Battery Storage duplicates
    const duplicates = await db.collection('serviceconfigurations').find({
      service: "Solar PV & Battery Storage"
    }).toArray();
    
    console.log(`\n📋 Found ${duplicates.length} duplicate services:`);
    duplicates.forEach(dup => {
      console.log(`  - ${dup._id}: "${dup.service}" (Area: ${dup.areaOfWork || 'None'})`);
    });
    
    if (duplicates.length <= 1) {
      console.log("✅ No duplicates to merge!");
      return;
    }
    
    // 2. Choose the primary service (keep the one with most complete data or first one)
    const primary = duplicates[0]; // Keep the first one
    const toRemove = duplicates.slice(1); // Remove the rest
    
    console.log(`\n🎯 Primary service to keep: ${primary._id}`);
    console.log(`🗑️  Services to remove: ${toRemove.map(d => d._id).join(', ')}`);
    
    // 3. Collect all unique areas of work
    const allAreasOfWork = [...new Set(duplicates
      .map(d => d.areaOfWork)
      .filter(area => area && area.trim())
    )];
    
    console.log(`\n📝 Merging areas of work: ${allAreasOfWork.join(', ')}`);
    
    // 4. Update primary service with merged data
    const updateData = {
      $set: {
        // Keep all unique areas of work as an array or comma-separated string
        areaOfWork: allAreasOfWork.length > 1 ? allAreasOfWork.join(', ') : allAreasOfWork[0] || null,
        updatedAt: new Date(),
        mergedFrom: toRemove.map(d => d._id.toString()),
        mergedAt: new Date()
      }
    };
    
    console.log("\n🔄 Updating primary service...");
    const updateResult = await db.collection('serviceconfigurations').updateOne(
      { _id: primary._id },
      updateData
    );
    console.log(`✅ Primary service updated: ${updateResult.modifiedCount} document(s)`);
    
    // 5. Find and update projects that reference the duplicate services
    console.log("\n🔍 Checking for projects using duplicate services...");
    
    const duplicateIds = toRemove.map(d => d._id.toString());
    
    // Update projects with serviceConfigurationId references
    const projectsWithConfigId = await db.collection('projects').find({
      serviceConfigurationId: { $in: duplicateIds }
    }).toArray();
    
    if (projectsWithConfigId.length > 0) {
      console.log(`📋 Found ${projectsWithConfigId.length} projects with serviceConfigurationId references`);
      
      const configUpdateResult = await db.collection('projects').updateMany(
        { serviceConfigurationId: { $in: duplicateIds } },
        { 
          $set: { 
            serviceConfigurationId: primary._id.toString(),
            updatedAt: new Date()
          } 
        }
      );
      console.log(`✅ Updated ${configUpdateResult.modifiedCount} projects with new serviceConfigurationId`);
    }
    
    // Update projects with service name references
    const projectsWithServiceName = await db.collection('projects').find({
      service: "Solar PV & Battery Storage"
    }).toArray();
    
    if (projectsWithServiceName.length > 0) {
      console.log(`📋 Found ${projectsWithServiceName.length} projects with service name references`);
      // These don't need updating since they already have the correct service name
    }
    
    // 6. Remove duplicate service configurations
    console.log("\n🗑️  Removing duplicate service configurations...");
    const deleteResult = await db.collection('serviceconfigurations').deleteMany({
      _id: { $in: toRemove.map(d => d._id) }
    });
    console.log(`✅ Removed ${deleteResult.deletedCount} duplicate service configurations`);
    
    // 7. Verify the fix
    console.log("\n✅ Verification:");
    const remaining = await db.collection('serviceconfigurations').find({
      service: "Solar PV & Battery Storage"
    }).toArray();
    
    console.log(`📊 Remaining "Solar PV & Battery Storage" services: ${remaining.length}`);
    remaining.forEach(service => {
      console.log(`  - ${service._id}: "${service.service}" (Area: ${service.areaOfWork || 'None'})`);
    });
    
    console.log("\n🎉 Solar duplicates fix completed successfully!");
    console.log("\n📋 Summary:");
    console.log(`  - Kept 1 primary service: ${primary._id}`);
    console.log(`  - Removed ${deleteResult.deletedCount} duplicates`);
    console.log(`  - Updated ${projectsWithConfigId.length} project references`);
    console.log(`  - Merged areas of work: ${allAreasOfWork.join(', ') || 'None'}`);
    
  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await client.close();
    console.log("\n🔌 Disconnected from MongoDB");
  }
}

// Run the script
if (require.main === module) {
  fixSolarDuplicates().catch(console.error);
}

module.exports = { fixSolarDuplicates };
