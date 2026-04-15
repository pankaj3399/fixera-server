import mongoose from 'mongoose';

const resolveField = (key: string): string | null => {
  if (key.startsWith('bookingNumber')) return 'bookingNumber';
  if (key.startsWith('quotationNumber')) return 'quotationNumber';
  return null;
};

const getMaxExistingSeq = async (
  db: mongoose.mongo.Db,
  field: string,
  prefix: string
): Promise<number> => {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regexPattern = `^${escapedPrefix}-(\\d+)$`;

  const [result] = await db.collection('bookings').aggregate([
    { $match: { [field]: { $regex: regexPattern } } },
    {
      $project: {
        numericSeq: {
          $toInt: {
            $arrayElemAt: [
              { $getField: { field: 'captures', input: { $regexFind: { input: `$${field}`, regex: regexPattern } } } },
              0,
            ],
          },
        },
      },
    },
    { $sort: { numericSeq: -1 } },
    { $limit: 1 },
  ]).toArray();

  return result?.numericSeq ?? 0;
};

export const getNextSequence = async (key: string, prefix: string): Promise<string> => {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error(`Database unavailable: cannot generate ${key}`);
  }

  const countersCollection = db.collection<{ _id: string; seq: number }>('counters');
  const existing = await countersCollection.findOne({ _id: key });

  if (!existing) {
    const field = resolveField(key);
    const floor = field ? await getMaxExistingSeq(db, field, prefix) : 0;

    await countersCollection.updateOne(
      { _id: key },
      { $max: { seq: floor } },
      { upsert: true }
    );
  }

  const counter = await countersCollection.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  if (!counter?.seq) {
    throw new Error(`Failed to generate ${key}: counter upsert returned ${JSON.stringify(counter)}`);
  }
  return `${prefix}-${String(counter.seq).padStart(6, '0')}`;
};
