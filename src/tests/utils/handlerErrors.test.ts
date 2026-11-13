import { describe, expect, it } from 'vitest';
import { toHandlerError } from '../../utils/handlerErrors';
import { UserFacingError } from '../../utils/appErrors';

describe('handlerErrors', () => {
  it('maps duplicate key errors to field-specific responses', () => {
    const result = toHandlerError(
      {
        code: 11000,
        message:
          'E11000 duplicate key error collection: fixera.users index: phone_1 dup key: { phone: "+918128463740" }',
      },
      'Failed to invite staff'
    );

    expect(result).toEqual({
      status: 409,
      body: {
        success: false,
        msg: 'A user with this phone number already exists',
        code: 'CONFLICT',
        field: 'phone',
      },
    });
  });

  it('never shows mongoose default validator text; lists the fields instead', () => {
    const result = toHandlerError(
      {
        name: 'ValidationError',
        errors: {
          email: { message: 'Path `email` is required.', path: 'email' },
          status: { message: '`bogus` is not a valid enum value for path `status`.', path: 'status' },
        },
      },
      'Failed to save'
    );

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      success: false,
      msg: 'Some fields are invalid. Check the highlighted fields and try again.',
      code: 'VALIDATION',
      fields: ['email', 'status'],
    });
    expect(JSON.stringify(result.body)).not.toMatch(/Path `|enum value/);
  });

  it('keeps custom schema validation messages written for users', () => {
    const result = toHandlerError(
      {
        name: 'ValidationError',
        errors: {
          name: { message: 'Name is required', path: 'name' },
          phone: { message: 'Enter a valid phone number', path: 'phone' },
        },
      },
      'Failed to save'
    );
    expect(result.body).toEqual({
      success: false,
      msg: 'Name is required, Enter a valid phone number',
      code: 'VALIDATION',
      fields: ['name', 'phone'],
    });
  });

  it('a mix of custom and default messages falls back to the generic copy', () => {
    const result = toHandlerError(
      {
        name: 'ValidationError',
        errors: {
          name: { message: 'Name is required', path: 'name' },
          'items.0.amount': { message: 'Path `amount` (-5) is less than minimum allowed value (0).', path: 'items.0.amount' },
        },
      },
      'Failed to save'
    );
    expect(result.body.msg).toBe('Some fields are invalid. Check the highlighted fields and try again.');
    expect(result.body.fields).toEqual(['name', 'items.0.amount']);
  });

  it('does not echo cast values', () => {
    const result = toHandlerError(
      {
        name: 'CastError',
        path: 'amount',
        value: 'super-secret-value',
        message: 'Cast to Number failed for value "super-secret-value" at path "amount"',
      },
      'Failed to save'
    );

    expect(result.status).toBe(400);
    expect(result.body.msg).toBe('One of the values has an invalid format. Check your input and try again.');
    expect(result.body.field).toBe('amount');
    expect(JSON.stringify(result.body)).not.toContain('super-secret-value');
  });

  it('maps invalid BSON identifiers to a safe validation error', () => {
    const result = toHandlerError(
      { name: 'BSONError', message: 'input must be a 24 character hex string' },
      'Failed'
    );

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      success: false,
      msg: 'The request contains an invalid identifier.',
      code: 'VALIDATION',
    });
  });

  it('handles validation errors without field messages', () => {
    const result = toHandlerError({ name: 'ValidationError', errors: {} }, 'Failed');

    expect(result.status).toBe(400);
    expect(result.body.msg).toBe('Some fields are invalid. Check the highlighted fields and try again.');
  });

  it('keeps explicit user-facing errors', () => {
    const result = toHandlerError(
      new UserFacingError(400, 'Insufficient points: has 10, needs 20', 'VALIDATION'),
      'Failed to adjust points'
    );

    expect(result).toEqual({
      status: 400,
      body: {
        success: false,
        msg: 'Insufficient points: has 10, needs 20',
        code: 'VALIDATION',
      },
    });
  });

  it('never exposes an unknown error message', () => {
    const result = toHandlerError(
      new Error('MongoServerError: password=secret at db.internal:27017'),
      "We couldn't load your projects. Please try again."
    );

    expect(result).toEqual({
      status: 500,
      body: {
        success: false,
        msg: "We couldn't load your projects. Please try again.",
        code: 'INTERNAL',
      },
    });
    expect(JSON.stringify(result.body)).not.toContain('secret');
  });

  it('handles non-Error throws', () => {
    const result = toHandlerError('stripe key sk_live_123', 'Failed safely');

    expect(result.status).toBe(500);
    expect(result.body.msg).toBe('Failed safely');
    expect(JSON.stringify(result.body)).not.toContain('sk_live_123');
  });

  it('maps JSON parse and payload errors without body-parser text', () => {
    expect(
      toHandlerError({ type: 'entity.parse.failed', message: 'Unexpected token < in JSON' }, 'Failed').body
    ).toEqual({
      success: false,
      msg: 'The request body is not valid JSON.',
      code: 'VALIDATION',
    });

    expect(
      toHandlerError({ type: 'entity.too.large', message: 'request entity too large' }, 'Failed').status
    ).toBe(413);
  });

  it('maps multer limits to actionable upload errors', () => {
    expect(
      toHandlerError({ name: 'MulterError', code: 'LIMIT_FILE_SIZE', message: 'File too large' }, 'Failed')
        .body.msg
    ).toBe('The uploaded file is too large. Choose a smaller file and try again.');
  });

  it('maps database/network failures to unavailable', () => {
    const db = toHandlerError({ name: 'MongooseServerSelectionError', message: 'connection refused' }, 'Failed');
    expect(db.status).toBe(503);
    expect(db.body.code).toBe('UNAVAILABLE');

    const timeout = toHandlerError({ name: 'TimeoutError', message: 'timed out' }, 'Failed');
    expect(timeout.status).toBe(504);
  });

  it('keeps unknown 4xx status but replaces raw text', () => {
    const result = toHandlerError({ status: 429, message: 'rate limit key abc123 exceeded' }, 'Failed');
    expect(result.status).toBe(429);
    expect(result.body).toEqual({
      success: false,
      msg: 'Too many requests. Please wait a moment and try again.',
      code: 'RATE_LIMITED',
    });
  });
});
