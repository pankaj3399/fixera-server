import connectDB from '../config/db';
import Project from '../models/project';

async function fixBuffer() {
  await connectDB();

  // Update both test projects to have explicit buffer: { value: 0, unit: 'days' }
  const result1 = await Project.updateOne(
    { _id: '696288a696293654e32a6a56' },
    { $set: { 'subprojects.0.buffer': { value: 0, unit: 'days' } } }
  );
  console.log('Updated Project 1 buffer:', result1.modifiedCount > 0 ? '✅' : 'no change');

  const result2 = await Project.updateOne(
    { _id: '696288a696293654e32a6a5e' },
    { $set: { 'subprojects.0.buffer': { value: 0, unit: 'days' } } }
  );
  console.log('Updated Project 2 buffer:', result2.modifiedCount > 0 ? '✅' : 'no change');

  // Verify
  const p1 = await Project.findById('696288a696293654e32a6a56').select('subprojects');
  const p2 = await Project.findById('696288a696293654e32a6a5e').select('subprojects');

  console.log('\nProject 1 subproject:', JSON.stringify(p1?.subprojects?.[0], null, 2));
  console.log('\nProject 2 subproject:', JSON.stringify(p2?.subprojects?.[0], null, 2));

  process.exit(0);
}

fixBuffer().catch(e => { console.error(e); process.exit(1); });
