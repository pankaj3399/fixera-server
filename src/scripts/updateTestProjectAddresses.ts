import connectDB from '../config/db';
import Project from '../models/project';

async function updateAddresses() {
  await connectDB();

  const existingProject = await Project.findById('696237d929f7f2ce27c9a2f3').select('distance');
  console.log('Existing project distance:', JSON.stringify(existingProject?.distance, null, 2));

  const result1 = await Project.updateOne(
    { _id: '696288a696293654e32a6a56' },
    { $set: { distance: existingProject?.distance } }
  );
  console.log('Updated Project 1 (Anafariya):', result1.modifiedCount > 0 ? '✅' : 'no change');

  const result2 = await Project.updateOne(
    { _id: '696288a696293654e32a6a5e' },
    { $set: { distance: existingProject?.distance } }
  );
  console.log('Updated Project 2 (Ana):', result2.modifiedCount > 0 ? '✅' : 'no change');

  console.log('\n✅ Both test projects now have the same address as the existing project');
  process.exit(0);
}

updateAddresses().catch(e => { console.error(e); process.exit(1); });
