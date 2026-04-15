import mongoose from 'mongoose';

type SupportedSequenceField = 'bookingNumber' | 'quotationNumber';

interface SequenceConfig {
  field: SupportedSequenceField;
  collection: 'bookings';
}

const getSequenceConfig = (key: string): SequenceConfig => {
  if (key.startsWith('bookingNumber')) {
    return { field: 'bookingNumber', collection: 'bookings' };
  }

  if (key.startsWith('quotationNumber')) {
    return { field: 'quotationNumber', collection: 'bookings' };
  }

  throw new Error(`Unsupported sequence key: ${key}`);
};

const formatSequenceValue = (prefix: string, seq: number): string =>
  `${prefix}-${String(seq).padStart(6, '0')}`;

export const getNextSequence = async (key: string, prefix: string): Promise<string> => {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error(`Database unavailable: cannot generate ${key}`);
  }

  const { field, collection } = getSequenceConfig(key);
  const countersCollection = db.collection<{ _id: string; seq: number }>('counters');
  const sourceCollection = db.collection(collection);
  const counterId = `${field}:${prefix}`;
  const maxAttempts = 10000;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const counter = await countersCollection.findOneAndUpdate(
      { _id: counterId },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    );

    const nextSeq = counter?.seq;
    if (!Number.isInteger(nextSeq) || nextSeq == null || nextSeq < 1) {
      throw new Error(`Failed to generate ${key}: counter upsert returned ${JSON.stringify(counter)}`);
    }

    const candidate = formatSequenceValue(prefix, nextSeq);
    const existing = await sourceCollection.findOne(
      { [field]: candidate },
      { projection: { _id: 1 } }
    );

    if (!existing) {
      return candidate;
    }
  }

  throw new Error(`Failed to generate ${key}: exhausted ${maxAttempts} attempts for prefix ${prefix}`);
};
