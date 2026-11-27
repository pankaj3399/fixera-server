import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/emailService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/emailService')>()),
  generateOTP: vi.fn(() => '654321'),
  sendOTPEmail: vi.fn(async () => true),
}));
vi.mock('../../utils/viesApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/viesApi')>()),
  validateVATNumber: vi.fn(async () => ({ valid: true })),
}));

import User from '../../models/user';
import { getSignupContact, updateSignupContact } from '../../handlers/User/signupContact';

const uri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = uri && /test/i.test(uri) ? describe : describe.skip;

const call = async (handler: typeof updateSignupContact, userId: string, body?: Record<string, unknown>) => {
  const res = {
    statusCode: 200, body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  await handler({ user: { id: userId }, body } as any, res as any);
  return res;
};

describeDb('FT2-6C signup edit against MongoDB', () => {
  let userId: string;

  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName: `ft2_6c_signup_edit_${process.pid}_${Date.now().toString(36)}` });
    await User.init();
  });
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

  beforeEach(async () => {
    await User.deleteMany({});
    // What SignUp stores for an individual customer (code issued > 1 minute ago).
    const user = await User.create({
      name: 'New Customer', email: 'typo@exmaple.com', phone: '+32470123456', role: 'customer',
      password: await bcrypt.hash('original-pass', 4),
      isEmailVerified: false, isPhoneVerified: false,
      verificationCode: '111111', verificationCodeExpires: new Date(Date.now() + 8 * 60 * 1000),
      customerType: 'individual',
      location: { type: 'Point', coordinates: [4.35, 50.85], address: 'Rue Neuve 1', city: 'Brussels', country: 'Belgium', postalCode: '1000' },
    });
    userId = String(user._id);
  });

  it('updates the same account from the full form, then reverts business data, never creating a second one', async () => {
    const prefill = await call(getSignupContact, userId);
    expect(prefill.statusCode).toBe(200);
    expect(prefill.body.data).toMatchObject({ name: 'New Customer', customerType: 'individual', location: { city: 'Brussels', latitude: 50.85, longitude: 4.35 } });

    const res = await call(updateSignupContact, userId, {
      ...prefill.body.data,
      name: 'Jane Doe', email: 'right@example.com', phone: '+32470123456', password: 'brand-new-pass',
      customerType: 'business', companyName: 'Doe BV', vatNumber: 'BE0123456789',
      address: 'Meir 10', city: 'Antwerp', country: 'Belgium', postalCode: '2000', latitude: 51.2194, longitude: 4.4025,
      marketingOptIn: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ emailChanged: true, phoneChanged: false, passwordChanged: true, emailOtpSent: true });
    expect(await User.countDocuments({})).toBe(1);

    const stored = await User.findById(userId).select('+password +verificationCode').lean();
    expect(stored).toMatchObject({
      name: 'Jane Doe', email: 'right@example.com', phone: '+32470123456', isEmailVerified: false,
      verificationCode: '654321', customerType: 'business', vatNumber: 'BE0123456789', isVatVerified: true,
      businessInfo: { companyName: 'Doe BV' }, marketingOptInPending: true,
      location: { type: 'Point', coordinates: [4.4025, 51.2194], address: 'Meir 10', city: 'Antwerp', postalCode: '2000', country: 'Belgium' },
    });
    expect(await bcrypt.compare('brand-new-pass', stored!.password)).toBe(true);

    const back = await call(updateSignupContact, userId, { customerType: 'individual', password: '' });
    expect(back.statusCode).toBe(200);
    const individual = await User.findById(userId).select('+password').lean();
    expect(individual!.customerType).toBe('individual');
    expect(individual!.vatNumber).toBeUndefined();
    expect(individual!.businessInfo?.companyName).toBeUndefined();
    expect(individual!.password).toBe(stored!.password);
  });

  it('misses with 409 once the account was verified meanwhile and stays closed afterwards', async () => {
    await User.updateOne({ _id: userId }, { $set: { isEmailVerified: true, isPhoneVerified: true } });
    expect((await call(updateSignupContact, userId, { name: 'Late' })).statusCode).toBe(409);
    expect((await call(getSignupContact, userId)).statusCode).toBe(409);
    expect((await User.findById(userId).lean())!.name).toBe('New Customer');
  });
});
