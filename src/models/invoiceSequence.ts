import { Schema, model, Document } from "mongoose";

export interface IInvoiceSequence extends Document {
  year: number;
  value: number;
}

const InvoiceSequenceSchema = new Schema<IInvoiceSequence>(
  {
    year: { type: Number, required: true, unique: true, index: true },
    value: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

const InvoiceSequence = model<IInvoiceSequence>("InvoiceSequence", InvoiceSequenceSchema);

export default InvoiceSequence;

