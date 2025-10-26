import mongoose from 'mongoose';
import ServiceConfiguration from '../models/serviceConfiguration';
import connectDB from '../config/db';

/**
 * Migration Script: Fix Solar Service Names
 *
 * Problem: "Hybrid Systems" was incorrectly stored with service name "Solar Panel & Battery"
 * Solution: Update it to "Solar PV & Battery Storage" to match the other solar services
 *
 * This ensures all 3 solar areas of work are under the same service name:
 * 1. Solar Panel Installation
 * 2. Battery Storage
 * 3. Hybrid Systems
 */

const fixSolarServiceNames = async () => {
  try {
    console.log('🔧 Starting Solar Service Names Migration...\n');

    await connectDB();
    console.log('✅ Connected to database\n');

    // Find all solar-related services BEFORE fix
    console.log('📊 Current state:');
    console.log('=' .repeat(50));
    const beforeServices = await ServiceConfiguration.find({
      service: /solar|panel|battery/i
    }).select('category service areaOfWork');

    const beforeGrouped = beforeServices.reduce((acc: any, item) => {
      const serviceName = item.service;
      if (!acc[serviceName]) {
        acc[serviceName] = [];
      }
      acc[serviceName].push(item.areaOfWork || 'No area specified');
      return acc;
    }, {});

    Object.keys(beforeGrouped).forEach(serviceName => {
      console.log(`\n"${serviceName}"`);
      console.log(`  Areas: ${beforeGrouped[serviceName].length}`);
      beforeGrouped[serviceName].forEach((area: string) => {
        console.log(`  - ${area}`);
      });
    });

    console.log('\n' + '='.repeat(50));
    console.log('\n🔄 Applying fix...\n');

    // Fix the incorrect service name
    const result = await ServiceConfiguration.updateMany(
      {
        service: 'Solar Panel & Battery',
        areaOfWork: 'Hybrid Systems'
      },
      {
        $set: {
          service: 'Solar PV & Battery Storage'
        }
      }
    );

    console.log(`✅ Updated ${result.modifiedCount} service configuration(s)\n`);

    // Verify the fix
    console.log('📊 After fix:');
    console.log('=' .repeat(50));
    const afterServices = await ServiceConfiguration.find({
      service: /solar|panel|battery/i
    }).select('category service areaOfWork');

    const afterGrouped = afterServices.reduce((acc: any, item) => {
      const serviceName = item.service;
      if (!acc[serviceName]) {
        acc[serviceName] = [];
      }
      acc[serviceName].push(item.areaOfWork || 'No area specified');
      return acc;
    }, {});

    Object.keys(afterGrouped).forEach(serviceName => {
      console.log(`\n"${serviceName}"`);
      console.log(`  Areas: ${afterGrouped[serviceName].length}`);
      afterGrouped[serviceName].forEach((area: string) => {
        console.log(`  - ${area}`);
      });
    });

    console.log('\n' + '='.repeat(50));

    // Summary
    console.log('\n✅ Migration completed successfully!');
    console.log('\n📋 Summary:');
    console.log(`   - Documents modified: ${result.modifiedCount}`);
    console.log(`   - All solar services now under: "Solar PV & Battery Storage"`);
    console.log(`   - Total areas of work: 3`);
    console.log(`     1. Solar Panel Installation`);
    console.log(`     2. Battery Storage`);
    console.log(`     3. Hybrid Systems`);
    console.log('');

    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
};

// Run if called directly
if (require.main === module) {
  fixSolarServiceNames();
}

export default fixSolarServiceNames;
