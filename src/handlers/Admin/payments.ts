import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Payment from '../../models/payment';
import { captureAndTransferPayment } from '../Stripe/payment';
import {
  createManualInvoiceArtifact,
  ensureBookingInvoiceArtifacts,
  ensureCreditInvoiceArtifacts,
  type ManualInvoiceCorrectionInput,
} from '../../services/invoiceArtifacts';
import { presignS3Url } from '../../utils/s3Upload';
import { parseFlexibleNumber } from '../../utils/vatManagement';
import { buildOversightTransferStatusExpression, canRetryTransfer, getTransferStatus } from '../../utils/paymentSafety';
import { auditLog } from '../../utils/auditLogger';
import { maskAnonymizedUser } from '../../utils/accountAnonymity';

class ManualInvoiceValidationError extends Error {
  readonly code = 'MANUAL_INVOICE_VALIDATION_ERROR';
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isValidPaymentId = (paymentId: string | string[] | undefined): paymentId is string =>
  typeof paymentId === 'string' && mongoose.Types.ObjectId.isValid(paymentId);

const presignMaybe = async (url?: string | null) => {
  if (!url) return url;
  return (await presignS3Url(url)) || url;
};

const withPresignedInvoiceUrls = async <T extends Record<string, any>>(payment: T): Promise<T> => {
  const [
    invoiceUrl,
    invoiceUblUrl,
    creditNoteUrl,
    creditNoteUblUrl,
    supplierInvoiceUrl,
    supplierInvoiceUblUrl,
    supplierCreditNoteUrl,
    supplierCreditNoteUblUrl,
  ] = await Promise.all([
    presignMaybe(payment.invoiceUrl),
    presignMaybe(payment.invoiceUblUrl),
    presignMaybe(payment.creditNoteUrl),
    presignMaybe(payment.creditNoteUblUrl),
    presignMaybe(payment.supplierInvoiceUrl),
    presignMaybe(payment.supplierInvoiceUblUrl),
    presignMaybe(payment.supplierCreditNoteUrl),
    presignMaybe(payment.supplierCreditNoteUblUrl),
  ]);

  return {
    ...payment,
    invoiceUrl,
    invoiceUblUrl,
    creditNoteUrl,
    creditNoteUblUrl,
    supplierInvoiceUrl,
    supplierInvoiceUblUrl,
    supplierCreditNoteUrl,
    supplierCreditNoteUblUrl,
  };
};

export const getPayments = async (req: Request, res: Response) => {
  try {
    const { status, page = '1', limit = '25', search } = req.query;
    const pageNumber = Math.max(parseInt(page as string, 10) || 1, 1);
    const limitNumber = Math.min(Math.max(parseInt(limit as string, 10) || 25, 5), 100);

    const query: Record<string, any> = {};
    const filters: Record<string, any>[] = [];

    if (status && typeof status === 'string' && status !== 'all') {
      if (status === 'transfer_failed') {
        filters.push({
          status: 'completed',
          $or: [
            { transferStatus: 'failed' },
            { 'metadata.transferFailed': true },
          ],
        });
      } else if (status === 'transfer_pending') {
        filters.push({
          status: 'completed',
          $or: [
            { transferStatus: 'pending' },
            { transferStatus: { $exists: false }, stripeTransferId: { $exists: false } },
          ],
          $nor: [{ 'metadata.transferFailed': true }],
        });
      } else {
        filters.push({ status });
      }
    }

    if (typeof search === 'string' && search.trim().length > 0) {
      const term = search.trim();
      const regex = new RegExp(escapeRegex(term), 'i');
      filters.push({ $or: [
        { bookingNumber: regex },
        { stripePaymentIntentId: regex },
        { stripeChargeId: regex },
        { stripeTransferId: regex },
      ] });
    }
    if (filters.length > 0) query.$and = filters;

    const skip = (pageNumber - 1) * limitNumber;

    const [payments, totalCount, statusBreakdown] = await Promise.all([
      Payment.find(query)
        .populate('booking', 'status bookingType bookingNumber createdAt')
        .populate('customer', 'name email isAnonymized deletedAt')
        .populate('professional', 'name email businessInfo companyName isAnonymized deletedAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),
      Payment.countDocuments(query),
      Payment.aggregate([
        { $match: query },
        {
          $addFields: {
            oversightStatus: {
              $cond: [
                { $ne: ['$status', 'completed'] },
                '$status',
                buildOversightTransferStatusExpression(),
              ],
            },
          },
        },
        {
          $group: {
            _id: { status: '$oversightStatus', currency: '$currency' },
            count: { $sum: 1 },
            totalVolume: {
              $sum: {
                $add: [
                  { $ifNull: ['$totalWithVat', 0] },
                  { $ifNull: ['$extraCostAmount', 0] },
                ],
              },
            }
          }
        }
      ])
    ]);

    const paymentsWithSignedUrls = await Promise.all(
      payments.map((payment) => withPresignedInvoiceUrls(payment))
    ).then((rows) => rows.map((payment) => ({
      ...payment,
      customer: maskAnonymizedUser(payment.customer),
      professional: maskAnonymizedUser(payment.professional),
    })));

    res.json({
      success: true,
      data: {
        payments: paymentsWithSignedUrls,
        pagination: {
          page: pageNumber,
          limit: limitNumber,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limitNumber)
        },
        stats: statusBreakdown
          .map(item => ({
            status: item._id?.status,
            currency: item._id?.currency,
            count: item.count,
            totalVolume: item.totalVolume
          }))
      }
    });
  } catch (error: any) {
    console.error('[ADMIN][PAYMENTS] Failed to fetch payments', error);
    res.status(500).json({
      success: false,
      msg: "We couldn't load payments. Please try again."
    });
  }
};

export const capturePayment = async (req: Request, res: Response) => {
  try {
    const { paymentId } = req.params;

    if (!isValidPaymentId(paymentId)) {
      return res.status(400).json({ success: false, msg: 'Invalid payment ID' });
    }

    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, msg: 'Payment not found' });
    }

    const transferStatus = getTransferStatus(payment);
    const retryingFailedTransfer = canRetryTransfer({
      status: payment.status,
      transferStatus,
      stripeTransferId: payment.stripeTransferId,
      metadata: payment.metadata,
    });
    if (payment.status !== 'authorized' && !retryingFailedTransfer) {
      return res.status(400).json({
        success: false,
        msg: `Cannot release payment with status "${payment.status}". Only authorized payments or failed transfers can be released.`
      });
    }

    const bookingId = payment.booking.toString();
    const result = await captureAndTransferPayment(bookingId);

    if (!result.success) {
      if (result.error?.code === 'TRANSFER_FAILED') {
        return res.status(502).json({
          success: false,
          msg: 'Payment capture succeeded, but transfer to professional failed. Retry is available.',
          warning: {
            code: result.error.code,
            details: result.error,
          },
          data: {
            bookingId,
            captureSucceeded: true,
            transferSucceeded: false,
            transferStatus: 'failed',
          },
        });
      }

      return res.status(500).json({
        success: false,
        msg: 'Failed to capture and transfer payment',
        error: result.error
      });
    }

    return res.json({
      success: true,
      msg: retryingFailedTransfer
        ? 'Transfer retried and completed successfully'
        : 'Payment captured and transferred successfully',
      data: {
        bookingId,
        captureSucceeded: true,
        transferSucceeded: true,
        transferStatus: 'succeeded',
      },
    });
  } catch (error: any) {
    console.error('[ADMIN][PAYMENTS] Failed to capture payment', error);
    res.status(500).json({
      success: false,
      msg: "We couldn't release this payment. Check its current status before retrying."
    });
  }
};

type PaymentArtifactOptions = {
  allowedStatuses: string[];
  statusErrorMessage: (status: string) => string;
  preValidate?: (payment: { status: string; invoiceNumber?: string }) => string | null;
  generate: (bookingId: string, paymentId: string) => Promise<unknown>;
  failureMessage: string;
  successMessage: string;
  logLabel: string;
};

const withPaymentArtifact = async (req: Request, res: Response, options: PaymentArtifactOptions) => {
  try {
    const { paymentId } = req.params;

    if (!isValidPaymentId(paymentId)) {
      return res.status(400).json({ success: false, msg: 'Invalid payment ID' });
    }

    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, msg: 'Payment not found' });
    }

    if (options.preValidate) {
      const preValidationError = options.preValidate(payment);
      if (preValidationError) {
        return res.status(400).json({ success: false, msg: preValidationError });
      }
    }

    if (!options.allowedStatuses.includes(payment.status)) {
      return res.status(400).json({
        success: false,
        msg: options.statusErrorMessage(payment.status),
      });
    }

    const result = await options.generate(payment.booking.toString(), payment._id.toString());
    if (!result) {
      return res.status(400).json({ success: false, msg: options.failureMessage });
    }

    const signedResult =
      result && typeof result === 'object'
        ? await withPresignedInvoiceUrls(result as Record<string, any>)
        : result;

    return res.json({
      success: true,
      msg: options.successMessage,
      data: signedResult,
    });
  } catch (error: any) {
    console.error(`[ADMIN][PAYMENTS] ${options.logLabel}`, error);
    return res.status(500).json({
      success: false,
      msg: options.failureMessage,
    });
  }
};

export const generatePaymentInvoice = async (req: Request, res: Response) =>
  withPaymentArtifact(req, res, {
    allowedStatuses: ['completed', 'authorized'],
    statusErrorMessage: (status) => `Cannot generate invoice for payment with status "${status}".`,
    generate: (bookingId, paymentId) => ensureBookingInvoiceArtifacts(bookingId, paymentId),
    failureMessage: 'Unable to generate invoice artifacts for this booking',
    successMessage: 'Invoice artifacts generated',
    logLabel: 'Failed to generate invoice artifacts',
  });

export const generatePaymentCreditNote = async (req: Request, res: Response) =>
  withPaymentArtifact(req, res, {
    // Authorized is included so admins can correct invoices before capture/completion.
    allowedStatuses: ['authorized', 'completed', 'refunded', 'partially_refunded'],
    statusErrorMessage: (status) => `Cannot generate credit note for payment with status "${status}".`,
    preValidate: (payment) =>
      payment.invoiceNumber && !String(payment.invoiceNumber).startsWith('GENERATING-')
        ? null
        : 'Generate the original invoice before creating a credit note',
    generate: (bookingId, paymentId) => ensureCreditInvoiceArtifacts(bookingId, paymentId),
    failureMessage: 'Unable to generate credit note for this booking',
    successMessage: 'Credit note artifacts generated',
    logLabel: 'Failed to generate credit note artifacts',
  });

const parseManualNumber = (value: unknown): number => {
  // parseFlexibleNumber rejects ambiguous grouped input such as "1,500"
  // instead of guessing whether the comma is a decimal or thousands separator.
  const parsed = parseFlexibleNumber(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const isBlankManualField = (value: unknown): boolean =>
  value === undefined || value === null || value === '';

const roundManualNumber = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const readManualParty = (value: unknown) => {
  if (!value || typeof value !== 'object') return undefined;
  const party = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const key of ['name', 'email', 'businessName', 'address', 'postalCode', 'city', 'country', 'vatNumber']) {
    if (party[key] !== undefined && party[key] !== null) {
      const text = String(party[key]).trim();
      if (text) result[key] = text.slice(0, 320);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

export const createManualPaymentArtifact = async (req: Request, res: Response) => {
  try {
    const { paymentId } = req.params;
    if (!isValidPaymentId(paymentId)) {
      return res.status(400).json({ success: false, msg: 'Invalid payment ID' });
    }

    const payment = await Payment.findById(paymentId).lean();
    if (!payment) return res.status(404).json({ success: false, msg: 'Payment not found' });
    if (!['authorized', 'completed', 'refunded', 'partially_refunded'].includes(payment.status)) {
      return res.status(400).json({ success: false, msg: `Cannot create a manual artifact for payment status "${payment.status}".` });
    }

    const body = (req.body || {}) as Record<string, any>;
    const side = body.side === 'supplier' ? 'supplier' : body.side === 'customer' ? 'customer' : null;
    const documentType = body.documentType === 'credit_note' ? 'credit_note' : body.documentType === 'invoice' ? 'invoice' : null;
    if (!side || !documentType) {
      return res.status(400).json({ success: false, msg: 'side must be customer or supplier and documentType must be invoice or credit_note.' });
    }

    if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 50) {
      return res.status(400).json({ success: false, msg: 'Provide between 1 and 50 invoice lines.' });
    }
    const lines = body.lines.map((rawLine: any, index: number) => {
      const amount = parseManualNumber(rawLine?.amount);
      const vatRate = parseManualNumber(rawLine?.vatRate);
      const quantity = isBlankManualField(rawLine?.quantity) ? undefined : parseManualNumber(rawLine.quantity);
      const unitPrice = isBlankManualField(rawLine?.unitPrice) ? undefined : parseManualNumber(rawLine.unitPrice);
      const description = String(rawLine?.description || '').trim();
      if (!description || description.length > 500) throw new ManualInvoiceValidationError(`Line ${index + 1} needs a description of at most 500 characters.`);
      if (!Number.isFinite(amount) || amount < 0) throw new ManualInvoiceValidationError(`Line ${index + 1} has an invalid amount.`);
      if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100) throw new ManualInvoiceValidationError(`Line ${index + 1} has an invalid VAT rate.`);
      if (quantity !== undefined && (!Number.isFinite(quantity) || quantity <= 0)) throw new ManualInvoiceValidationError(`Line ${index + 1} has an invalid quantity.`);
      if (unitPrice !== undefined && (!Number.isFinite(unitPrice) || unitPrice < 0)) throw new ManualInvoiceValidationError(`Line ${index + 1} has an invalid unit price.`);
      return {
        description,
        amount: roundManualNumber(amount),
        vatRate: roundManualNumber(vatRate),
        vatLabel: rawLine?.vatLabel ? String(rawLine.vatLabel).trim().slice(0, 120) : undefined,
        quantity,
        unitPrice,
        unit: rawLine?.unit ? String(rawLine.unit).trim().slice(0, 40) : undefined,
      };
    });

    const paymentInput = body.payment && typeof body.payment === 'object' ? body.payment : {};
    const netAmount = roundManualNumber(parseManualNumber(paymentInput.netAmount));
    const vatAmount = roundManualNumber(parseManualNumber(paymentInput.vatAmount));
    const totalWithVat = roundManualNumber(parseManualNumber(paymentInput.totalWithVat));
    const vatRate = roundManualNumber(parseManualNumber(paymentInput.vatRate));
    const currency = String(paymentInput.currency || payment.currency || 'EUR').trim().toUpperCase();
    const reverseCharge = paymentInput.reverseCharge === true;
    if (![netAmount, vatAmount, totalWithVat, vatRate].every(Number.isFinite) || netAmount < 0 || vatAmount < 0 || totalWithVat < 0 || vatRate < 0 || vatRate > 100) {
      return res.status(400).json({ success: false, msg: 'Manual invoice totals and VAT rate must be valid non-negative numbers.' });
    }
    if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ success: false, msg: 'Currency must be a three-letter ISO code.' });

    const lineNet = roundManualNumber(lines.reduce((sum: number, line: any) => sum + line.amount, 0));
    const expectedVat = reverseCharge
      ? 0
      : roundManualNumber(lines.reduce(
        (sum: number, line: any) => sum + roundManualNumber(line.amount * line.vatRate / 100),
        0,
      ));
    if (Math.abs(lineNet - netAmount) > 0.02) return res.status(400).json({ success: false, msg: `Line net total (${lineNet.toFixed(2)}) must match payment net amount (${netAmount.toFixed(2)}).` });
    if (Math.abs(expectedVat - vatAmount) > 0.02) return res.status(400).json({ success: false, msg: `Line VAT total (${expectedVat.toFixed(2)}) must match payment VAT amount (${vatAmount.toFixed(2)}).` });
    if (Math.abs(roundManualNumber(netAmount + vatAmount) - totalWithVat) > 0.02) return res.status(400).json({ success: false, msg: 'Total with VAT must equal net amount plus VAT amount.' });

    const input: ManualInvoiceCorrectionInput = {
      side,
      documentType,
      relatedInvoiceNumber: body.relatedInvoiceNumber ? String(body.relatedInvoiceNumber).trim().slice(0, 80) : undefined,
      serviceDescription: body.serviceDescription ? String(body.serviceDescription).trim().slice(0, 4000) : undefined,
      lines,
      payment: {
        netAmount,
        vatAmount,
        vatRate,
        totalWithVat,
        currency,
        reverseCharge,
        vatLabel: paymentInput.vatLabel ? String(paymentInput.vatLabel).trim().slice(0, 120) : undefined,
      },
      customer: readManualParty(body.customer),
      professional: readManualParty(body.professional),
    };

    // Idempotency protection: a client retry must not allocate a second
    // invoice number and a second set of PDF/UBL artifacts. The claim is
    // reserved atomically before generation and released if generation fails.
    const idempotencyKey = body.idempotencyKey ? String(body.idempotencyKey).trim().slice(0, 128) : '';
    if (idempotencyKey) {
      const claimResult = await Payment.findOneAndUpdate(
        { _id: paymentId, 'manualArtifactClaims.key': { $ne: idempotencyKey } },
        {
          $push: {
            manualArtifactClaims: { key: idempotencyKey, side, documentType, createdAt: new Date() },
          },
        },
        { new: true }
      ).lean();
      if (!claimResult) {
        const existingPayment = await Payment.findById(paymentId).lean();
        const priorClaim = existingPayment?.manualArtifactClaims?.find((claim: any) => claim.key === idempotencyKey);
        return res.status(409).json({
          success: false,
          msg: 'A manual artifact with this idempotency key was already created for this payment.',
          data: priorClaim?.invoiceNumber ? { invoiceNumber: priorClaim.invoiceNumber } : undefined,
        });
      }
    }

    let result;
    try {
      result = await createManualInvoiceArtifact(payment.booking.toString(), paymentId, input);
    } catch (error: any) {
      // Release the idempotency claim so a corrected retry can proceed.
      if (idempotencyKey) {
        await Payment.updateOne(
          { _id: paymentId },
          { $pull: { manualArtifactClaims: { key: idempotencyKey } } }
        ).catch(() => undefined);
      }
      console.error('[ADMIN][PAYMENTS] Failed to create manual invoice artifact', error);
      if (error instanceof ManualInvoiceValidationError) {
        return res.status(400).json({ success: false, msg: error.message });
      }
      return res.status(500).json({ success: false, msg: 'Failed to create manual invoice artifact' });
    }

    try {
      if (idempotencyKey) {
        await Payment.updateOne(
          { _id: paymentId, 'manualArtifactClaims.key': idempotencyKey },
          { $set: { 'manualArtifactClaims.$.invoiceNumber': result.invoiceNumber } }
        );
      }
      await auditLog({
        req,
        action: 'admin.manual_invoice_artifact_created',
        targetType: 'Payment',
        targetId: paymentId,
        details: {
          side,
          documentType,
          invoiceNumber: result.invoiceNumber,
          netAmount,
          vatAmount,
          totalWithVat,
          currency,
          lineCount: lines.length,
        },
      });
      const signedResult = await withPresignedInvoiceUrls(result as Record<string, any>);
      return res.status(201).json({ success: true, msg: 'Manual invoice artifact created', data: signedResult });
    } catch (error: any) {
      // The artifact exists. Keep the claim and report the post-processing failure.
      console.error('[ADMIN][PAYMENTS] Manual artifact created but post-processing failed', error);
      return res.status(500).json({
        success: false,
        msg: 'Manual invoice artifact created, but the response could not be finalized',
        data: { invoiceNumber: result.invoiceNumber },
      });
    }
  } catch (error: any) {
    console.error('[ADMIN][PAYMENTS] Failed to create manual invoice artifact', error);
    if (error instanceof ManualInvoiceValidationError) {
      return res.status(400).json({ success: false, msg: error.message });
    }
    return res.status(500).json({ success: false, msg: 'Failed to create manual invoice artifact' });
  }
};
