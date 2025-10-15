// Comprehensive Solar Services Merger for fixera-server
// This script finds and merges duplicate solar services across all possible collections

const { MongoClient } = require('mongodb');
require('dotenv').config();

async function findAndMergeSolarDuplicates() {
  console.log("🔍 Starting comprehensive solar duplicates search...");
  console.log("MongoDB URI:", process.env.MONGODB_URI ? "✅ Found" : "❌ Missing");
  
  if (!process.env.MONGODB_URI) {
    console.error("❌ MONGODB_URI not found in environment variables");
    console.log("Make sure your .env file contains MONGODB_URI");
    return;
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB");
    
    const db = client.db();
    
    console.log("\n🔍 Searching for solar service duplicates...\n");
    
    // Get all collections
    const collections = await db.listCollections().toArray();
    console.log(`Found ${collections.length} collections:`, collections.map(c => c.name).join(', '));
    
    let foundDuplicates = [];
    let totalSolarServices = 0;
    
    // 1. Check ServiceConfiguration collection
    console.log("\n1. Checking ServiceConfiguration collection...");
    try {
      const serviceConfigs = await db.collection('serviceconfigurations').find({
        $or: [
          { service: { $regex: /solar/i } },
          { service: { $regex: /battery/i } },
          { service: { $regex: /pv/i } },
          { name: { $regex: /solar/i } },
          { name: { $regex: /battery/i } }
        ]
      }).toArray();
      
      console.log(`Found ${serviceConfigs.length} solar-related service configurations:`);
      serviceConfigs.forEach(config => {
        console.log(`  - ${config._id}: "${config.service || config.name}" (Category: ${config.category || 'N/A'})`);
        totalSolarServices++;
      });
      
      // Find duplicates
      const duplicates = findDuplicateServices(serviceConfigs);
      if (duplicates.length > 0) {
        foundDuplicates.push({ collection: 'serviceconfigurations', duplicates });
      }
    } catch (error) {
      console.log("❌ ServiceConfiguration collection error:", error.message);
    }
    
    // 2. Check Services collection
    console.log("\n2. Checking Services collection...");
    try {
      const services = await db.collection('services').find({
        $or: [
          { service: { $regex: /solar/i } },
          { name: { $regex: /solar/i } },
          { service: { $regex: /battery/i } },
          { name: { $regex: /battery/i } }
        ]
      }).toArray();
      
      console.log(`Found ${services.length} solar-related services:`);
      services.forEach(service => {
        console.log(`  - ${service._id}: "${service.service || service.name}" (Category: ${service.category || 'N/A'})`);
        totalSolarServices++;
      });
      
      const duplicates = findDuplicateServices(services);
      if (duplicates.length > 0) {
        foundDuplicates.push({ collection: 'services', duplicates });
      }
    } catch (error) {
      console.log("❌ Services collection error:", error.message);
    }
    
    // 3. Check Categories collection
    console.log("\n3. Checking Categories collection...");
    try {
      const categories = await db.collection('categories').find({}).toArray();
      console.log(`Found ${categories.length} categories`);
      
      categories.forEach(category => {
        if (category.services && Array.isArray(category.services)) {
          const solarServices = category.services.filter(service => {
            const serviceName = typeof service === 'string' ? service : (service.name || service.service);
            return serviceName && /solar|battery|pv/i.test(serviceName);
          });
          
          if (solarServices.length > 0) {
            console.log(`Category "${category.name}" has ${solarServices.length} solar services:`);
            solarServices.forEach(service => {
              const serviceName = typeof service === 'string' ? service : (service.name || service.service);
              console.log(`  - "${serviceName}"`);
              totalSolarServices++;
            });
          }
        }
      });
    } catch (error) {
      console.log("❌ Categories collection error:", error.message);
    }
    
    // 4. Manual search for exact duplicates in ALL collections
    console.log("\n4. Searching for specific duplicate patterns in ALL collections...");
    const exactSearches = [
      "Solar PV & battery storage",
      "Solar panel & battery",
      "Solar PV battery storage", 
      "Solar panel battery",
      "Solar PV and battery storage",
      "Solar panel and battery",
      "Solar PV & battery",
      "Solar panel & battery storage"
    ];
    
    for (const searchTerm of exactSearches) {
      console.log(`\n🔍 Searching for: "${searchTerm}"`);
      let foundInAnyCollection = false;
      
      // Search in all collections
      for (const collectionInfo of collections) {
        const collectionName = collectionInfo.name;
        if (collectionName.startsWith('system.')) continue;
        
        try {
          const results = await db.collection(collectionName).find({
            $or: [
              { service: { $regex: new RegExp(escapeRegex(searchTerm), 'i') } },
              { name: { $regex: new RegExp(escapeRegex(searchTerm), 'i') } },
              { title: { $regex: new RegExp(escapeRegex(searchTerm), 'i') } }
            ]
          }).toArray();
          
          if (results.length > 0) {
            console.log(`  ✅ Found ${results.length} matches in ${collectionName}:`);
            results.forEach(result => {
              console.log(`    - ${result._id}: "${result.service || result.name || result.title}"`);
            });
            foundInAnyCollection = true;
          }
        } catch (error) {
          // Skip collections that can't be queried
        }
      }
      
      if (!foundInAnyCollection) {
        console.log(`  ❌ No matches found`);
      }
    }
    
    // 5. Broad search for any solar-related entries
    console.log("\n5. Broad search for ANY solar-related entries...");
    for (const collectionInfo of collections) {
      const collectionName = collectionInfo.name;
      if (collectionName.startsWith('system.')) continue;
      
      try {
        const results = await db.collection(collectionName).find({
          $or: [
            { service: { $regex: /solar/i } },
            { name: { $regex: /solar/i } },
            { title: { $regex: /solar/i } },
            { service: { $regex: /battery/i } },
            { name: { $regex: /battery/i } },
            { title: { $regex: /battery/i } }
          ]
        }).limit(10).toArray();
        
        if (results.length > 0) {
          console.log(`\n📋 Collection "${collectionName}" has ${results.length} solar-related entries:`);
          results.forEach(result => {
            const fields = Object.keys(result).filter(key => 
              key !== '_id' && typeof result[key] === 'string' && 
              /solar|battery|pv/i.test(result[key])
            );
            console.log(`  - ${result._id}:`);
            fields.forEach(field => {
              console.log(`    ${field}: "${result[field]}"`);
            });
          });
        }
      } catch (error) {
        // Skip collections that can't be queried
      }
    }
    
    // 6. Summary and recommendations
    console.log("\n" + "=".repeat(60));
    console.log("📊 SUMMARY:");
    console.log(`Total solar services found: ${totalSolarServices}`);
    
    if (foundDuplicates.length === 0) {
      console.log("❌ No duplicate solar services found using standard duplicate detection.");
      console.log("\n💡 Possible reasons:");
      console.log("   - Duplicates might be in different collections");
      console.log("   - Different field names are used");
      console.log("   - Duplicates are in nested objects/arrays");
      console.log("   - Data structure is different than expected");
      console.log("   - Duplicates were already cleaned up");
      
      if (totalSolarServices > 0) {
        console.log("\n🔧 Next steps:");
        console.log("   1. Review the solar services found above");
        console.log("   2. Check if any look like duplicates manually");
        console.log("   3. Verify the exact field names and structure");
        console.log("   4. Check the frontend API endpoints to see what data they return");
      }
    } else {
      console.log("✅ Found duplicates! Ready to merge:");
      foundDuplicates.forEach(({ collection, duplicates }) => {
        console.log(`\n${collection}:`);
        duplicates.forEach(group => {
          console.log(`  Merge group: ${group.map(d => `"${d.service || d.name}"`).join(' + ')}`);
        });
      });
    }
    
  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await client.close();
    console.log("\n🔌 Disconnected from MongoDB");
  }
}

function findDuplicateServices(services) {
  const duplicateGroups = [];
  const processed = new Set();
  
  for (let i = 0; i < services.length; i++) {
    if (processed.has(i)) continue;
    
    const service1 = services[i];
    const name1 = (service1.service || service1.name || '').toLowerCase();
    
    if (!name1.includes('solar') && !name1.includes('battery')) continue;
    
    const group = [service1];
    processed.add(i);
    
    for (let j = i + 1; j < services.length; j++) {
      if (processed.has(j)) continue;
      
      const service2 = services[j];
      const name2 = (service2.service || service2.name || '').toLowerCase();
      
      // Check if they're similar solar/battery services
      if (areSimilarSolarServices(name1, name2)) {
        group.push(service2);
        processed.add(j);
      }
    }
    
    if (group.length > 1) {
      duplicateGroups.push(group);
    }
  }
  
  return duplicateGroups;
}

function areSimilarSolarServices(name1, name2) {
  // Normalize names
  const normalize = (name) => name
    .replace(/[&+]/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
  
  const n1 = normalize(name1);
  const n2 = normalize(name2);
  
  // Check if both contain solar/pv and battery
  const hasSolar1 = /solar|pv/i.test(n1);
  const hasBattery1 = /battery|storage/i.test(n1);
  const hasSolar2 = /solar|pv/i.test(n2);
  const hasBattery2 = /battery|storage/i.test(n2);
  
  return hasSolar1 && hasBattery1 && hasSolar2 && hasBattery2;
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Run the script
if (require.main === module) {
  findAndMergeSolarDuplicates().catch(console.error);
}

module.exports = { findAndMergeSolarDuplicates };
