import mongoose from 'mongoose';
import User from '../models/user';
import Project from '../models/project';
import connectDB from '../config/db';

/**
 * Script to set up multi-resource overlap testing:
 *
 * 1. Find user IDs for anafariya@gmail.com and ana@auraehealth.com
 * 2. Find existing project with both as resources
 * 3. Update existing project: minResources=2, minOverlapPercentage=75
 * 4. Create 2 new test projects (one per user) for blocking
 *
 * Test scenario:
 * - Book Project 1 (anafariya) for Feb 1
 * - Book Project 2 (ana) for Feb 2
 * - Existing project (4 days, minResources=2, 75% overlap):
 *   - Feb 1 start: BLOCKED (50% overlap < 75%)
 *   - Feb 2 start: AVAILABLE (75% overlap = 75%)
 *   - Feb 3+ start: AVAILABLE (100% overlap)
 */

const seedOverlapTestProjects = async () => {
  try {
    console.log('🌱 Starting overlap test setup...\n');

    // Connect to database
    await connectDB();
    console.log('✅ Connected to database\n');

    // Step 1: Find user IDs
    console.log('📧 Looking up users...');

    const anafariya = await User.findOne({ email: 'anafariya@gmail.com' });
    const ana = await User.findOne({ email: 'ana@auraehealth.com' });

    if (!anafariya) {
      console.error('❌ User anafariya@gmail.com not found');
      process.exit(1);
    }
    if (!ana) {
      console.error('❌ User ana@auraehealth.com not found');
      process.exit(1);
    }

    const anafariyaDoc = anafariya as any;
    const anaDoc = ana as any;

    console.log(`   anafariya@gmail.com: ${anafariyaDoc._id}`);
    console.log(`   ana@auraehealth.com: ${anaDoc._id}\n`);

    const anafariyaId = anafariyaDoc._id.toString();
    const anaId = anaDoc._id.toString();

    // Step 2: Find existing project with both as resources
    console.log('🔍 Looking for existing project with both users as resources...');

    const existingProject = await Project.findOne({
      resources: { $all: [anafariyaId, anaId] },
      status: 'published'
    });

    if (!existingProject) {
      console.log('⚠️  No published project found with both users as resources.');
      console.log('   Searching for any project with both users...');

      const anyProject = await Project.findOne({
        resources: { $all: [anafariyaId, anaId] }
      });

      if (anyProject) {
        console.log(`   Found project: ${anyProject._id} (status: ${anyProject.status})`);
        console.log(`   Title: ${anyProject.title}`);
      } else {
        console.log('   No project found with both users as resources.');
        console.log('\n   Listing all projects with resources...');
        const projectsWithResources = await Project.find({
          resources: { $exists: true, $ne: [] }
        }).select('_id title status resources professionalId');

        projectsWithResources.forEach(p => {
          console.log(`   - ${p._id}: ${p.title} (status: ${p.status})`);
          console.log(`     Resources: ${p.resources.join(', ')}`);
        });
      }
      process.exit(1);
    }

    console.log(`   Found: ${existingProject._id}`);
    console.log(`   Title: ${existingProject.title}`);
    console.log(`   Current resources: ${existingProject.resources.join(', ')}`);
    console.log(`   Current minResources: ${existingProject.minResources || 'not set (default 1)'}`);
    console.log(`   Current minOverlapPercentage: ${existingProject.minOverlapPercentage || 'not set (default 90)'}`);

    // Step 3: Update existing project
    console.log('\n📝 Updating existing project...');

    await Project.updateOne(
      { _id: existingProject._id },
      {
        $set: {
          minResources: 2,
          minOverlapPercentage: 75
        }
      }
    );

    console.log('   ✅ Set minResources = 2');
    console.log('   ✅ Set minOverlapPercentage = 75');

    // Step 4: Create 2 new test projects
    console.log('\n🏗️  Creating test projects...\n');

    // Get professional ID from existing project
    const professionalId = existingProject.professionalId;

    // Delete existing test projects if they exist
    const deletedCount = await Project.deleteMany({
      title: { $in: [
        '[TEST] Overlap Blocker - Anafariya',
        '[TEST] Overlap Blocker - Ana',
        '[TEST] Overlap Blocker - Ana Aurae'
      ]}
    });
    if (deletedCount.deletedCount > 0) {
      console.log(`   🗑️  Deleted ${deletedCount.deletedCount} existing test projects`);
    }

    // Create Project 1: anafariya only
    const project1 = await Project.create({
      professionalId,
      title: '[TEST] Overlap Blocker - Anafariya',
      description: 'Test project for blocking anafariya@gmail.com on specific dates. This project is used to test multi-resource overlap scheduling.',
      category: existingProject.category,
      service: existingProject.service,
      priceModel: 'fixed',
      keywords: ['test', 'overlap'],
      resources: [anafariyaId],
      minResources: 1,
      distance: {
        address: 'Test Address, Brussels, Belgium',
        useCompanyAddress: false,
        maxKmRange: 50,
        noBorders: false,
        location: {
          type: 'Point',
          coordinates: [4.3517, 50.8503] // Brussels coordinates
        }
      },
      media: {
        images: []
      },
      subprojects: [{
        name: 'Test Subproject',
        description: 'Test subproject for overlap testing',
        projectType: ['test'],
        pricing: { type: 'fixed', amount: 100 },
        included: [],
        materialsIncluded: false,
        preparationDuration: { value: 1, unit: 'days' },
        executionDuration: { value: 1, unit: 'days' },
        // No buffer
        warrantyPeriod: { value: 0, unit: 'years' }
      }],
      extraOptions: [],
      termsConditions: [],
      faq: [],
      rfqQuestions: [],
      postBookingQuestions: [],
      status: 'published',
      currentStep: 8
    });

    console.log(`   ✅ Created Project 1: ${project1._id}`);
    console.log(`      Title: ${project1.title}`);
    console.log(`      Resource: anafariya@gmail.com (${anafariyaId})`);
    console.log(`      Execution: 1 day, Prep: 1 day, Buffer: 0`);

    // Create Project 2: ana only
    const project2 = await Project.create({
      professionalId,
      title: '[TEST] Overlap Blocker - Ana Aurae',
      description: 'Test project for blocking ana@auraehealth.com on specific dates. This project is used to test multi-resource overlap scheduling.',
      category: existingProject.category,
      service: existingProject.service,
      priceModel: 'fixed',
      keywords: ['test', 'overlap'],
      resources: [anaId],
      minResources: 1,
      distance: {
        address: 'Test Address, Brussels, Belgium',
        useCompanyAddress: false,
        maxKmRange: 50,
        noBorders: false,
        location: {
          type: 'Point',
          coordinates: [4.3517, 50.8503] // Brussels coordinates
        }
      },
      media: {
        images: []
      },
      subprojects: [{
        name: 'Test Subproject',
        description: 'Test subproject for overlap testing',
        projectType: ['test'],
        pricing: { type: 'fixed', amount: 100 },
        included: [],
        materialsIncluded: false,
        preparationDuration: { value: 1, unit: 'days' },
        executionDuration: { value: 1, unit: 'days' },
        // No buffer
        warrantyPeriod: { value: 0, unit: 'years' }
      }],
      extraOptions: [],
      termsConditions: [],
      faq: [],
      rfqQuestions: [],
      postBookingQuestions: [],
      status: 'published',
      currentStep: 8
    });

    console.log(`\n   ✅ Created Project 2: ${project2._id}`);
    console.log(`      Title: ${project2.title}`);
    console.log(`      Resource: ana@auraehealth.com (${anaId})`);
    console.log(`      Execution: 1 day, Prep: 1 day, Buffer: 0`);

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 SUMMARY');
    console.log('='.repeat(60));
    console.log('\n📌 Existing Project (to test):');
    console.log(`   ID: ${existingProject._id}`);
    console.log(`   Title: ${existingProject.title}`);
    console.log(`   Execution: ${existingProject.subprojects?.[0]?.executionDuration?.value || '?'} ${existingProject.subprojects?.[0]?.executionDuration?.unit || 'days'}`);
    console.log(`   Resources: [anafariya, ana]`);
    console.log(`   minResources: 2`);
    console.log(`   minOverlapPercentage: 75%`);

    console.log('\n📌 Test Project 1 (blocker):');
    console.log(`   ID: ${project1._id}`);
    console.log(`   Resource: anafariya@gmail.com`);
    console.log(`   → Book this for Feb 1 to block anafariya`);

    console.log('\n📌 Test Project 2 (blocker):');
    console.log(`   ID: ${project2._id}`);
    console.log(`   Resource: ana@auraehealth.com`);
    console.log(`   → Book this for Feb 2 to block ana`);

    console.log('\n📋 EXPECTED RESULTS for existing project:');
    console.log('   After booking Project 1 for Feb 1 and Project 2 for Feb 2:');
    console.log('');
    console.log('   | Start Date | Overlap % | Result    |');
    console.log('   |------------|-----------|-----------|');
    console.log('   | Feb 1      | 50%       | ❌ BLOCKED |');
    console.log('   | Feb 2      | 75%       | ✅ AVAILABLE |');
    console.log('   | Feb 3      | 100%      | ✅ AVAILABLE |');
    console.log('   | Feb 4      | 100%      | ✅ AVAILABLE |');
    console.log('');
    console.log('   Feb 1 start (4 days: Feb 1,2,3,4):');
    console.log('   - Feb 1: only ana (anafariya blocked) → 1 < 2 ❌');
    console.log('   - Feb 2: only anafariya (ana blocked) → 1 < 2 ❌');
    console.log('   - Feb 3: both available → 2 ≥ 2 ✅');
    console.log('   - Feb 4: both available → 2 ≥ 2 ✅');
    console.log('   - Result: 2/4 = 50% < 75% → BLOCKED');
    console.log('');
    console.log('   Feb 2 start (4 days: Feb 2,3,4,5):');
    console.log('   - Feb 2: only anafariya (ana blocked) → 1 < 2 ❌');
    console.log('   - Feb 3: both available → 2 ≥ 2 ✅');
    console.log('   - Feb 4: both available → 2 ≥ 2 ✅');
    console.log('   - Feb 5: both available → 2 ≥ 2 ✅');
    console.log('   - Result: 3/4 = 75% = 75% → AVAILABLE');

    console.log('\n✅ Setup complete! Now create bookings to test.\n');

    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
};

// Run if called directly
if (require.main === module) {
  seedOverlapTestProjects();
}

export default seedOverlapTestProjects;
