import { duplicateKeyResponse } from './mongoErrors';
import { errorCodeForStatus, isUserFacingError, type ErrorCode } from './appErrors';
import { safeErrorSummary } from './safeErrorLog';

export type HandlerErrorBody = {
  success: false;
  msg: string;
  code?: ErrorCode;
  field?: string;
  /** Invalid field paths for form highlighting (never shown as text). */
  fields?: string[];
};

type HandlerErrorResult = {
  status: number;
  body: HandlerErrorBody;
};

const DEFAULT_MESSAGE = 'Something went wrong on our side. Please try again in a moment.';

function safeFallback(fallback: string | undefined): string {
  const message = typeof fallback === 'string' ? fallback.trim() : '';
  return message || DEFAULT_MESSAGE;
}

/**
 * Mongoose's built-in validator messages expose schema internals ("Path
 * `email` is required.", "`x` is not a valid enum value for path `y`",
 * "Cast to Number failed ...") and are English-only. They are never shown;
 * the affected field names go in `fields` for form highlighting instead.
 * Custom messages written in the schemas (e.g. "Name is required") are kept.
 */
const MONGOOSE_DEFAULT_MESSAGE_RES: RegExp[] = [
  /\bPath `[^`]*`/,
  /`[^`]*` is not a valid enum value/,
  /\bCast to [A-Za-z]+ failed\b/,
  /\bValidator failed for path\b/,
  /is (?:shorter|longer) than the (?:minimum|maximum) allowed length/,
  /is (?:less|more) than (?:minimum|maximum) allowed value/,
];

export function isMongooseDefaultMessage(message: string): boolean {
  return MONGOOSE_DEFAULT_MESSAGE_RES.some((pattern) => pattern.test(message));
}

const GENERIC_VALIDATION_MESSAGE = 'Some fields are invalid. Check the highlighted fields and try again.';

function validationErrorResult(error: unknown): HandlerErrorResult | null {
  if (!error || typeof error !== 'object' || (error as { name?: string }).name !== 'ValidationError') {
    return null;
  }
  const validationError = error as { errors?: Record<string, { message?: unknown; path?: unknown }> };
  const entries = Object.entries(validationError.errors || {});
  const fields = Array.from(
    new Set(
      entries
        .map(([key, entry]) => (typeof entry?.path === 'string' && entry.path.trim() ? entry.path.trim() : key))
        .filter(Boolean),
    ),
  );
  const messages = entries
    .map(([, entry]) => (typeof entry?.message === 'string' ? entry.message.trim() : ''))
    .filter(Boolean);
  const safe = messages.length > 0 && messages.every((message) => !isMongooseDefaultMessage(message));
  return {
    status: 400,
    body: {
      success: false,
      msg: safe ? Array.from(new Set(messages)).join(', ') : GENERIC_VALIDATION_MESSAGE,
      code: 'VALIDATION',
      ...(fields.length ? { fields } : {}),
    },
  };
}

function castErrorResult(error: unknown): HandlerErrorResult | null {
  if (!error || typeof error !== 'object' || (error as { name?: string }).name !== 'CastError') {
    return null;
  }
  const path = (error as { path?: unknown }).path;
  const field = typeof path === 'string' && path.trim() ? path.trim() : undefined;
  return {
    status: 400,
    body: {
      success: false,
      msg: 'One of the values has an invalid format. Check your input and try again.',
      code: 'VALIDATION',
      ...(field ? { field } : {}),
    },
  };
}

function versionErrorResult(error: unknown): HandlerErrorResult | null {
  if (!error || typeof error !== 'object' || (error as { name?: string }).name !== 'VersionError') {
    return null;
  }
  // Mongoose optimistic concurrency: another request changed this document
  // between the read and the write. Never silently overwrite it.
  return {
    status: 409,
    body: {
      success: false,
      msg: 'This item changed while you were editing it. Refresh and try again.',
      code: 'CONFLICT',
    },
  };
}

function bsonErrorResult(error: unknown): HandlerErrorResult | null {
  if (!error || typeof error !== 'object') return null;
  const name = (error as { name?: string }).name;
  if (name !== 'BSONError' && name !== 'BSONTypeError') return null;
  return {
    status: 400,
    body: {
      success: false,
      msg: 'The request contains an invalid identifier.',
      code: 'VALIDATION',
    },
  };
}

function parserErrorResult(error: unknown): HandlerErrorResult | null {
  if (!error || typeof error !== 'object') return null;
  const type = (error as { type?: unknown }).type;
  switch (type) {
    case 'entity.parse.failed':
      return {
        status: 400,
        body: { success: false, msg: 'The request body is not valid JSON.', code: 'VALIDATION' },
      };
    case 'entity.too.large':
      return {
        status: 413,
        body: {
          success: false,
          msg: 'The request is too large. Reduce the amount of data and try again.',
          code: 'VALIDATION',
        },
      };
    case 'encoding.unsupported':
      return {
        status: 415,
        body: {
          success: false,
          msg: 'The request uses an unsupported content encoding.',
          code: 'VALIDATION',
        },
      };
    case 'request.aborted':
      return {
        status: 400,
        body: { success: false, msg: 'The request was interrupted. Please try again.', code: 'VALIDATION' },
      };
    default:
      return null;
  }
}

function infrastructureErrorResult(error: unknown): HandlerErrorResult | null {
  if (!error || typeof error !== 'object') return null;
  const err = error as { name?: unknown; code?: unknown; type?: unknown; cause?: unknown };
  const name = typeof err.name === 'string' ? err.name : '';
  const code = typeof err.code === 'string' ? err.code : '';
  const type = typeof err.type === 'string' ? err.type : '';
  const cause = err.cause && typeof err.cause === 'object'
    ? (err.cause as { code?: unknown })
    : undefined;
  const causeCode = typeof cause?.code === 'string' ? cause.code : '';
  const networkCodes = [code, causeCode];

  if (name === 'MongooseServerSelectionError' || name === 'MongoNetworkError' || name === 'MongoNetworkTimeoutError') {
    return {
      status: 503,
      body: {
        success: false,
        msg: 'The service is temporarily unavailable. Please try again in a moment.',
        code: 'UNAVAILABLE',
      },
    };
  }

  if (networkCodes.some((entry) => ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(entry)) || name === 'TimeoutError') {
    return {
      status: 504,
      body: {
        success: false,
        msg: 'The service took too long to respond. Please try again.',
        code: 'UNAVAILABLE',
      },
    };
  }

  if (networkCodes.some((entry) => ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(entry))) {
    return {
      status: 503,
      body: {
        success: false,
        msg: 'The service is temporarily unavailable. Please try again in a moment.',
        code: 'UNAVAILABLE',
      },
    };
  }

  if (type.startsWith('Stripe')) {
    return {
      status: 502,
      body: {
        success: false,
        msg: 'The payment service is temporarily unavailable. Please try again.',
        code: 'UNAVAILABLE',
      },
    };
  }

  return null;
}

function uploadErrorResult(error: unknown): HandlerErrorResult | null {
  if (!error || typeof error !== 'object' || (error as { name?: string }).name !== 'MulterError') {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  const message =
    code === 'LIMIT_FILE_SIZE'
      ? 'The uploaded file is too large. Choose a smaller file and try again.'
      : code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_PART_COUNT'
        ? 'Too many files were uploaded. Reduce the number of files and try again.'
        : code === 'LIMIT_UNEXPECTED_FILE'
          ? 'Unexpected file field in the upload. Check the form and try again.'
          : code === 'LIMIT_FIELD_KEY' || code === 'LIMIT_FIELD_VALUE'
            ? 'An upload field is too long. Shorten it and try again.'
            : 'The file upload could not be processed. Check the file and try again.';
  return { status: 400, body: { success: false, msg: message, code: 'VALIDATION' } };
}

export function toHandlerError(error: unknown, fallback: string): HandlerErrorResult {
  const duplicate = duplicateKeyResponse(error);
  if (duplicate) {
    return {
      status: duplicate.status,
      body: { success: false, msg: duplicate.msg, code: 'CONFLICT', field: duplicate.field },
    };
  }

  const validation = validationErrorResult(error);
  if (validation) return validation;

  const cast = castErrorResult(error);
  if (cast) return cast;

  const version = versionErrorResult(error);
  if (version) return version;

  const bson = bsonErrorResult(error);
  if (bson) return bson;

  const parser = parserErrorResult(error);
  if (parser) return parser;

  const upload = uploadErrorResult(error);
  if (upload) return upload;

  const infrastructure = infrastructureErrorResult(error);
  if (infrastructure) return infrastructure;

  if (isUserFacingError(error)) {
    const status = error.status >= 400 && error.status <= 599 ? error.status : 500;
    return {
      status,
      body: {
        success: false,
        msg: error.message,
        code: error.code || errorCodeForStatus(status),
        ...(error.field ? { field: error.field } : {}),
      },
    };
  }

  const errorStatus =
    error && typeof error === 'object'
      ? (error as { status?: unknown; statusCode?: unknown }).status ??
        (error as { statusCode?: unknown }).statusCode
      : undefined;
  const status = typeof errorStatus === 'number' ? errorStatus : 500;

  // Unknown 4xx errors keep their status but never their raw text.
  if (status >= 400 && status < 500) {
    console.error(fallback, safeErrorSummary(error));
    return {
      status,
      body: {
        success: false,
        msg: status === 401
          ? 'Please sign in to continue.'
          : status === 403
            ? 'You do not have permission to do that.'
            : status === 404
              ? 'The requested item could not be found.'
              : status === 409
                ? 'This request conflicts with the current state. Refresh and try again.'
                : status === 429
                  ? 'Too many requests. Please wait a moment and try again.'
                  : 'The request could not be processed. Check the details and try again.',
        code: errorCodeForStatus(status),
      },
    };
  }

  console.error(fallback, safeErrorSummary(error));
  return {
    status: 500,
    body: { success: false, msg: safeFallback(fallback), code: 'INTERNAL' },
  };
}

export function sendHandlerError(
  res: { status: (code: number) => { json: (body: HandlerErrorBody) => unknown } },
  error: unknown,
  fallback: string,
) {
  const { status, body } = toHandlerError(error, fallback);
  return res.status(status).json(body);
}
