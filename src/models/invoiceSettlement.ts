import { Schema } from 'mongoose';

export type InvoiceSideSettlement = {
  netAmount: number;
  vatAmount: number;
  totalWithVat: number;
  /** Cumulative customer refund already represented by the issued invoice. */
  refundAmount: number;
};
export type InvoiceSettlementBasis = { customer?: InvoiceSideSettlement; supplier?: InvoiceSideSettlement };
export type RefundCreditFact = {
  key: string;
  side: 'customer' | 'supplier';
  refundAmount: number;
  netAmount: number;
  vatAmount: number;
  invoiceNumber: string;
  invoiceUrl?: string;
  invoiceUblUrl?: string;
  generatedAt: Date;
};
const side = new Schema<InvoiceSideSettlement>({
  netAmount: Number, vatAmount: Number, totalWithVat: Number, refundAmount: Number,
}, { _id: false });
export const InvoiceSettlementBasisSchema = new Schema<InvoiceSettlementBasis>({ customer: side, supplier: side }, { _id: false });
export const RefundCreditFactSchema = new Schema<RefundCreditFact>({
  key: { type: String, required: true }, side: { type: String, enum: ['customer', 'supplier'], required: true },
  refundAmount: Number, netAmount: Number, vatAmount: Number, invoiceNumber: String,
  invoiceUrl: String, invoiceUblUrl: String, generatedAt: Date,
}, { _id: false });
