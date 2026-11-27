import { beforeEach, describe, expect, it, vi } from 'vitest';

const { userFindById, userFindOne, userFindOneAndUpdate, sendOTPEmail, twilioCreate, bcryptHash, validateVATNumber } = vi.hoisted(() => ({
  userFindById: vi.fn(),
  userFindOne: vi.fn(),
  userFindOneAndUpdate: vi.fn(),
  sendOTPEmail: vi.fn(),
  twilioCreate: vi.fn(),
  bcryptHash: vi.fn(),
  validateVATNumber: vi.fn(),
}));

vi.mock('../../../models/user', () => ({
  default: { findById: userFindById, findOne: userFindOne, findOneAndUpdate: userFindOneAndUpdate },
}));
vi.mock('../../../config/db', () => ({ default: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../utils/emailService', () => ({
  generateOTP: vi.fn(() => '654321'),
  sendOTPEmail,
}));
vi.mock('../../../utils/support/accountGuard', () => ({
  withAnonymizationWriteFence: (_ids: unknown, write: (session: undefined) => Promise<unknown>) => write(undefined),
}));
vi.mock('bcrypt', () => ({ default: { hash: bcryptHash } }));
vi.mock('../../../utils/viesApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/viesApi')>()),
  validateVATNumber,
}));
vi.mock('twilio', () => ({
  default: vi.fn(() => ({
    verify: { v2: { services: () => ({ verifications: { create: twilioCreate } }) } },
  })),
}));

import { getSignupContact, normalizeSignupPhone, updateSignupContact } from '../../../handlers/User/signupContact';

function resMock() {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as any;
}

const call = async (body: Record<string, unknown>, userId: string | null = 'user-1') => {
  const res = resMock();
  await updateSignupContact({ body, user: userId ? { id: userId } : undefined } as any, res);
  return res;
};

const callGet = async (userId: string | null = 'user-1') => {
  const res = resMock();
  await getSignupContact({ user: userId ? { id: userId } : undefined } as any, res);
  return res;
};

const takenQuery = (result: unknown) => ({ select: () => ({ lean: async () => result }) });

/**
 * findById stand-in that hides select:false fields like the real schema:
 * verificationCodeExpires is only returned when explicitly selected.
 */
const HIDDEN_FIELDS = ['verificationCodeExpires', 'signupEmailChangedAt'];
function findByIdQuery(load: () => Record<string, any> | null) {
  const project = (selection: string) => {
    const doc = load();
    if (!doc) return doc;
    const out = { ...doc };
    for (const field of HIDDEN_FIELDS) {
      if (!selection.split(/\s+/).includes(`+${field}`)) delete out[field];
    }
    return out;
  };
  return {
    select: async (selection: string) => project(selection),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve().then(() => project('')).then(resolve, reject),
  };
}

/**
 * In-memory stand-in for the stored user: findOneAndUpdate applies $set only
 * when every filter field still matches, like MongoDB does.
 */
function storedUserWrites(stored: Record<string, any>) {
  userFindOneAndUpdate.mockImplementation((filter: Record<string, any>, update: { $set: Record<string, unknown>; $unset?: Record<string, unknown> }) => ({
    lean: async () => {
      const matches = Object.entries(filter).every(([key, value]) => {
        const actual = stored[key];
        if (value instanceof Date || actual instanceof Date) {
          return new Date(actual ?? 0).getTime() === new Date(value ?? 0).getTime() && (actual == null) === (value == null);
        }
        return (actual ?? null) === (value ?? null);
      });
      if (!matches) return null;
      for (const [path, value] of Object.entries(update.$set)) {
        const [head, tail] = path.split('.');
        if (tail) stored[head] = { ...(stored[head] ?? {}), [tail]: value };
        else stored[head] = value;
      }
      for (const path of Object.keys(update.$unset ?? {})) {
        const [head, tail] = path.split('.');
        if (tail) { if (stored[head]) delete stored[head][tail]; } else delete stored[head];
      }
      return { ...stored };
    },
  }));
}

describe('updateSignupContact (FT2-6C back from the OTP step to the signup form)', () => {
  let user: Record<string, any>;
  let stored: Record<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TWILIO_ACCOUNT_SID = 'AC';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    process.env.TWILIO_VERIFY_SERVICE_SID = 'VA';
    sendOTPEmail.mockResolvedValue(true);
    twilioCreate.mockResolvedValue({});
    bcryptHash.mockImplementation(async (value: string, rounds: number) => `hashed(${value},${rounds})`);
    validateVATNumber.mockResolvedValue({ valid: true });
    user = {
      _id: 'user-1',
      name: 'New Customer',
      role: 'customer',
      email: 'typo@exmaple.com',
      phone: '+32470123456',
      isEmailVerified: false,
      isPhoneVerified: false,
      verificationCode: '111111',
      password: 'old-hash',
      customerType: 'individual',
      location: { type: 'Point', coordinates: [4.35, 50.85], address: 'Rue Neuve 1', city: 'Brussels', country: 'Belgium', postalCode: '1000' },
      marketingOptInPending: false,
    };
    stored = { ...user };
    userFindById.mockImplementation(() => findByIdQuery(() => ({ ...stored })));
    userFindOne.mockReturnValue(takenQuery(null));
    storedUserWrites(stored);
  });

  it('corrects the email of the signed-in unverified account and sends a fresh code', async () => {
    const res = await call({ email: ' Right@Example.com ', phone: '+32470123456' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(stored.email).toBe('right@example.com');
    expect(stored.isEmailVerified).toBe(false);
    expect(stored.verificationCode).toBe('654321');
    expect(stored.verificationCodeExpires).toBeInstanceOf(Date);
    expect(userFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(userFindOneAndUpdate.mock.calls[0][0]).toMatchObject({ _id: 'user-1', email: 'typo@exmaple.com', isEmailVerified: false });
    expect(sendOTPEmail).toHaveBeenCalledWith('right@example.com', '654321', 'New Customer');
    // Phone unchanged: no new SMS.
    expect(twilioCreate).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].data).toMatchObject({ email: 'right@example.com', emailChanged: true, phoneChanged: false, emailOtpSent: true });
  });

  it('changes the phone to E.164 and texts a new code, leaving a verified email alone', async () => {
    stored.isEmailVerified = true;
    const res = await call({ email: 'typo@exmaple.com', phone: '+32 471 23 45 67' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(stored.phone).toBe('+32471234567');
    expect(stored.isPhoneVerified).toBe(false);
    expect(userFindOneAndUpdate.mock.calls[0][0]).toMatchObject({ phone: '+32470123456', isPhoneVerified: false });
    expect(twilioCreate).toHaveBeenCalledWith({ channel: 'sms', to: '+32471234567' });
    expect(sendOTPEmail).not.toHaveBeenCalled();
  });

  it('rate-limits repeated email changes so it cannot mail addresses in a loop', async () => {
    stored.signupEmailChangedAt = new Date(Date.now() - 5_000);
    const res = await call({ email: 'other@example.com' });
    expect(res.status).toHaveBeenCalledWith(429);
    expect(stored.email).not.toBe('other@example.com');
    expect(sendOTPEmail).not.toHaveBeenCalled();
    expect(userFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('corrects the email right after signup, while the signup code is still fresh', async () => {
    // Signup just sent a code (select:false expiry), but no edit happened yet.
    stored.verificationCodeExpires = new Date(Date.now() + 10 * 60 * 1000 - 5_000);
    const res = await call({ email: 'second@example.com' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(stored.email).toBe('second@example.com');
    expect(sendOTPEmail).toHaveBeenCalledTimes(1);
    expect(stored.signupEmailChangedAt).toBeInstanceOf(Date);
  });

  it('allows another email change once the cooldown since the last edit has passed', async () => {
    stored.signupEmailChangedAt = new Date(Date.now() - 2 * 60 * 1000);
    const res = await call({ email: 'third@example.com' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(stored.email).toBe('third@example.com');
  });

  it('refuses an email that belongs to another account', async () => {
    userFindOne.mockReturnValue(takenQuery({ _id: 'other' }));
    const res = await call({ email: 'taken@example.com' });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(userFindOneAndUpdate).not.toHaveBeenCalled();
    expect(userFindOne).toHaveBeenCalledWith({ email: 'taken@example.com', _id: { $ne: 'user-1' } });
  });

  it('never changes a channel that is already verified', async () => {
    stored.isEmailVerified = true;
    const res = await call({ email: 'other@example.com' });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(stored.email).toBe('typo@exmaple.com');
  });

  it('is closed once the account is fully verified, and for staff roles', async () => {
    stored.isEmailVerified = true;
    stored.isPhoneVerified = true;
    expect((await call({ email: 'x@example.com' })).status).toHaveBeenCalledWith(409);
    stored.isEmailVerified = false;
    stored.role = 'admin';
    expect((await call({ email: 'x@example.com' })).status).toHaveBeenCalledWith(403);
  });

  it('validates input and requires a session', async () => {
    expect((await call({ email: 'x@example.com' }, null)).status).toHaveBeenCalledWith(401);
    expect((await call({})).status).toHaveBeenCalledWith(400);
    expect((await call({ email: 'not-an-email' })).status).toHaveBeenCalledWith(400);
    expect((await call({ phone: '0470123456' })).status).toHaveBeenCalledWith(400);
    expect(userFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses with 409 when the email is verified between the read and the write', async () => {
    // 1. updateSignupContact reads the unverified user; 2. verifyEmailOTP
    // verifies the old address before the uniqueness check returns; 3. the
    // contact write must miss instead of moving the verified flag to the new email.
    userFindOne.mockImplementation(() => {
      stored.isEmailVerified = true;
      return takenQuery(null);
    });
    const res = await call({ email: 'new@example.com' });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].msg).toBe('Your details changed meanwhile. Please reload and try again.');
    expect(stored).toMatchObject({ email: 'typo@exmaple.com', isEmailVerified: true, verificationCode: '111111' });
    expect(sendOTPEmail).not.toHaveBeenCalled();
    expect(twilioCreate).not.toHaveBeenCalled();
  });

  it('refuses with 409 when the phone is verified between the read and the write', async () => {
    userFindById.mockImplementation(() => findByIdQuery(() => {
      const snapshot = { ...stored };
      stored.isPhoneVerified = true;
      return snapshot;
    }));
    const res = await call({ phone: '+32471234567' });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(stored).toMatchObject({ phone: '+32470123456', isPhoneVerified: true });
    expect(twilioCreate).not.toHaveBeenCalled();
  });

  it('updates every field the customer signup form collected in one conditional write', async () => {
    const res = await call({
      name: '  Jane Doe ',
      email: 'typo@exmaple.com',
      phone: '+32470123456',
      password: '',
      customerType: 'business',
      address: 'Meir 10', city: 'Antwerp', country: 'Belgium', postalCode: '2000',
      latitude: 51.2194, longitude: 4.4025,
      companyName: ' Doe BV ',
      vatNumber: 'be 0123 456 789',
      marketingOptIn: true,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(userFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(userFindOneAndUpdate.mock.calls[0][0]).toEqual({ _id: 'user-1', isEmailVerified: false, isPhoneVerified: false });
    expect(stored).toMatchObject({
      name: 'Jane Doe',
      customerType: 'business',
      businessInfo: { companyName: 'Doe BV' },
      vatNumber: 'BE0123456789',
      isVatVerified: true,
      marketingOptInPending: true,
      location: { type: 'Point', coordinates: [4.4025, 51.2194], address: 'Meir 10', city: 'Antwerp', country: 'Belgium', postalCode: '2000' },
      // Blank password keeps the current one; unchanged channels keep their codes.
      password: 'old-hash',
      verificationCode: '111111',
    });
    expect(bcryptHash).not.toHaveBeenCalled();
    expect(validateVATNumber).toHaveBeenCalledWith('BE0123456789');
    expect(sendOTPEmail).not.toHaveBeenCalled();
    expect(twilioCreate).not.toHaveBeenCalled();
    const data = res.json.mock.calls[0][0].data;
    expect(data).toMatchObject({
      name: 'Jane Doe', customerType: 'business', companyName: 'Doe BV', vatNumber: 'BE0123456789',
      marketingOptIn: true, emailChanged: false, phoneChanged: false, passwordChanged: false,
      location: { address: 'Meir 10', city: 'Antwerp', postalCode: '2000', country: 'Belgium', latitude: 51.2194, longitude: 4.4025 },
    });
  });

  it('hashes a new password the way signup does and enforces the same strength rule', async () => {
    const weak = await call({ password: '123' });
    expect(weak.status).toHaveBeenCalledWith(400);
    expect(weak.json.mock.calls[0][0].msg).toBe('Password must be at least 6 characters long');
    expect(userFindOneAndUpdate).not.toHaveBeenCalled();

    const res = await call({ password: 'longer-secret' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(bcryptHash).toHaveBeenCalledWith('longer-secret', 12);
    expect(stored.password).toBe('hashed(longer-secret,12)');
    expect(res.json.mock.calls[0][0].data.passwordChanged).toBe(true);
    // The hash never goes back to the client.
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('hashed(');
  });

  it('validates the form fields like signup does', async () => {
    const msg = async (body: Record<string, unknown>) => {
      const res = await call(body);
      expect(res.status).toHaveBeenCalledWith(400);
      return res.json.mock.calls[0][0].msg;
    };
    expect(await msg({ name: '   ' })).toBe('Please provide your full name');
    expect(await msg({ customerType: 'company' })).toBe('Please choose an individual or business account');
    expect(await msg({ address: 'Meir 10', city: 'Antwerp', country: 'Belgium' })).toBe('Please provide your full address: street, city, postal code and country');
    expect(await msg({ customerType: 'business', vatNumber: 'BE0123456789' })).toBe('Company name is required for business customers');
    expect(await msg({ customerType: 'business', companyName: 'Doe BV' })).toBe('VAT number is required for business customers');
    expect(await msg({ customerType: 'business', companyName: 'Doe BV', vatNumber: '12' })).toBe('Invalid VAT number format');
    expect(userFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('switching a business customer back to individual drops the company data', async () => {
    Object.assign(stored, { customerType: 'business', vatNumber: 'BE0123456789', isVatVerified: true, businessInfo: { companyName: 'Doe BV' } });
    const res = await call({ customerType: 'individual' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(stored.customerType).toBe('individual');
    expect(stored.vatNumber).toBeUndefined();
    expect(stored.businessInfo.companyName).toBeUndefined();
    expect(stored.isVatVerified).toBe(false);
    expect(res.json.mock.calls[0][0].data).toMatchObject({ customerType: 'individual', companyName: '', vatNumber: '' });
  });

  it('keeps the stored VIES result when the VAT number did not change', async () => {
    Object.assign(stored, { customerType: 'business', vatNumber: 'BE0123456789', isVatVerified: true, businessInfo: { companyName: 'Doe BV' } });
    const res = await call({ customerType: 'business', companyName: 'Doe & Co', vatNumber: 'BE 0123456789' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(validateVATNumber).not.toHaveBeenCalled();
    expect(stored).toMatchObject({ isVatVerified: true, businessInfo: { companyName: 'Doe & Co' } });
  });

  it('ignores customer-only fields for a professional, like signup does', async () => {
    stored.role = 'professional';
    delete stored.customerType;
    delete stored.location;
    const res = await call({ name: 'Pro Name', customerType: 'business', companyName: 'X', address: 'A', marketingOptIn: true });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(userFindOneAndUpdate.mock.calls[0][1].$set).toEqual({ name: 'Pro Name', marketingOptInPending: true });
    expect(res.json.mock.calls[0][0].data).toMatchObject({ role: 'professional', name: 'Pro Name', customerType: null, location: null });
  });

  it('leaves the marketing opt-in alone once the email is verified', async () => {
    stored.isEmailVerified = true;
    const res = await call({ name: 'Renamed', marketingOptIn: true });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(userFindOneAndUpdate.mock.calls[0][1].$set).toEqual({ name: 'Renamed' });
    expect(userFindOneAndUpdate.mock.calls[0][0]).toMatchObject({ isEmailVerified: true, isPhoneVerified: false });
    expect(res.json.mock.calls[0][0].data.marketingOptInEditable).toBe(false);
  });

  it('only the changed channel gets a new code when the whole form is resubmitted', async () => {
    stored.verificationCodeExpires = new Date(Date.now() + 10 * 60 * 1000 - 2 * 60 * 1000);
    const res = await call({ name: 'New Customer', email: 'typo@exmaple.com', phone: '+32 471 23 45 67', password: '' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(twilioCreate).toHaveBeenCalledTimes(1);
    expect(sendOTPEmail).not.toHaveBeenCalled();
    expect(stored.verificationCode).toBe('111111');
    expect(res.json.mock.calls[0][0].data).toMatchObject({ emailChanged: false, phoneChanged: true, phoneOtpSent: true, emailOtpSent: false });
  });

  it('mails the new code under the corrected name', async () => {
    const res = await call({ name: 'Corrected Name', email: 'right@example.com' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(sendOTPEmail).toHaveBeenCalledWith('right@example.com', '654321', 'Corrected Name');
  });

  it('refuses with 409 when the account becomes fully verified between the read and the write', async () => {
    stored.isEmailVerified = true;
    userFindById.mockImplementation(() => findByIdQuery(() => {
      const snapshot = { ...stored };
      stored.isPhoneVerified = true;
      return snapshot;
    }));
    const res = await call({ name: 'Too Late' });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(stored.name).toBe('New Customer');
  });

  it('writes nothing when nothing changed and reports no new codes', async () => {
    const res = await call({ email: 'typo@exmaple.com', phone: '+32470123456' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(userFindOneAndUpdate).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].data).toMatchObject({ emailChanged: false, phoneChanged: false, emailOtpSent: false, phoneOtpSent: false });
  });
});

describe('getSignupContact (FT2-6C prefill from the server)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the signup form values of the signed-in unverified account', async () => {
    const stored = {
      _id: 'user-1', role: 'customer', name: 'Jane', email: 'jane@example.com', phone: '+32470123456',
      isEmailVerified: false, isPhoneVerified: true, password: 'hash', verificationCode: '111111',
      customerType: 'business', businessInfo: { companyName: 'Doe BV' }, vatNumber: 'BE0123456789', isVatVerified: true,
      location: { type: 'Point', coordinates: [4.4, 51.2], address: 'Meir 10', city: 'Antwerp', country: 'Belgium', postalCode: '2000' },
      marketingOptInPending: true,
    };
    userFindById.mockImplementation(() => findByIdQuery(() => ({ ...stored })));
    const res = await callGet();
    expect(res.status).toHaveBeenCalledWith(200);
    const data = res.json.mock.calls[0][0].data;
    expect(data).toEqual({
      role: 'customer', name: 'Jane', email: 'jane@example.com', phone: '+32470123456',
      isEmailVerified: false, isPhoneVerified: true,
      customerType: 'business', companyName: 'Doe BV', vatNumber: 'BE0123456789', isVatVerified: true,
      location: { address: 'Meir 10', city: 'Antwerp', country: 'Belgium', postalCode: '2000', latitude: 51.2, longitude: 4.4 },
      marketingOptIn: true, marketingOptInEditable: true,
    });
    expect(JSON.stringify(data)).not.toMatch(/hash|111111/);
  });

  it('has the same gate as the update: session, signup roles, closed once verified', async () => {
    expect((await callGet(null)).status).toHaveBeenCalledWith(401);
    const stored: Record<string, any> = { _id: 'user-1', role: 'admin', isEmailVerified: false, isPhoneVerified: false };
    userFindById.mockImplementation(() => findByIdQuery(() => ({ ...stored })));
    expect((await callGet()).status).toHaveBeenCalledWith(403);
    Object.assign(stored, { role: 'professional', isEmailVerified: true, isPhoneVerified: true });
    expect((await callGet()).status).toHaveBeenCalledWith(409);
    userFindById.mockImplementation(() => findByIdQuery(() => null));
    expect((await callGet()).status).toHaveBeenCalledWith(404);
  });

  it('normalizes only valid international numbers', () => {
    expect(normalizeSignupPhone('+32470123456')).toBe('+32470123456');
    expect(normalizeSignupPhone('+31 6 12345678')).toBe('+31612345678');
    expect(normalizeSignupPhone('0470123456')).toBeNull();
    expect(normalizeSignupPhone('+3247')).toBeNull();
  });
});
