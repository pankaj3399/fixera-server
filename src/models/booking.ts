import { Schema, model, Document, Types } from "mongoose";

export type BookingStatus =
  | 'rfq'           // Request for Quote - Initial state when customer requests
  | 'quoted'        // Professional has provided a quote
  | 'quote_accepted'// Customer accepted the quote
  | 'quote_rejected'// Customer rejected the quote
  | 'payment_pending' // Payment is being processed
  | 'booked'        // Payment successful, booking confirmed
  | 'in_progress'   // Work has started
  | 'completed'     // Work finished
  | 'cancelled'     // Booking cancelled by either party
  | 'dispute'       // Issue raised
  | 'refunded';     // Payment refunded

export type BookingType = 'professional' | 'project';

export interface IRFQAnswer {
  questionId?: string;
  question: string;
  answer: string;
  fieldType?: 'text' | 'number' | 'date' | 'dropdown' | 'checkbox' | 'file';
}

export interface IQuote {
  amount: number;
  currency: string;
  description?: string;
  breakdown?: {
    item: string;
    quantity?: number;
    unitPrice?: number;
    totalPrice: number;
  }[];
  validUntil?: Date;
  termsAndConditions?: string;
  estimatedDuration?: string; // e.g., "2 weeks", "3 days"
  submittedAt: Date;
  submittedBy: Types.ObjectId; // Professional who submitted the quote
}

export interface IBooking extends Document {
  // Core references
  customer: Types.ObjectId; // Reference to User (customer)
  bookingType: BookingType; // 'professional' or 'project'
  professional?: Types.ObjectId; // Reference to User (professional) - for direct bookings
  project?: Types.ObjectId; // Reference to Project - for project bookings

  // Status and lifecycle
  status: BookingStatus;
  statusHistory: {
    status: BookingStatus;
    timestamp: Date;
    updatedBy?: Types.ObjectId;
    note?: string;
  }[];

  // RFQ (Request for Quote) data
  rfqData: {
    serviceType: string; // What service is needed
    description: string; // Detailed description of the work needed
    answers: IRFQAnswer[]; // Answers to project/professional-specific questions
    preferredStartDate?: Date;
    urgency?: 'low' | 'medium' | 'high' | 'urgent';
    budget?: {
      min?: number;
      max?: number;
      currency: string;
    };
    attachments?: string[]; // S3 URLs for uploaded files
  };

  // Quote from professional
  quote?: IQuote;

  // Booking location (customer's location from their profile)
  location: {
    type: 'Point';
    coordinates: [number, number]; // [longitude, latitude]
    address?: string;
    city?: string;
    country?: string;
    postalCode?: string;
  };

  // Payment information
  payment?: {
    amount: number;
    currency: string;
    method?: 'card' | 'bank_transfer' | 'cash';
    status: 'pending' | 'completed' | 'failed' | 'refunded';
    stripePaymentIntentId?: string;
    stripeChargeId?: string;
    paidAt?: Date;
    refundedAt?: Date;
    refundReason?: string;
  };

  // Scheduling
  scheduledStartDate?: Date;
  scheduledExecutionEndDate?: Date;
  scheduledBufferStartDate?: Date;
  scheduledBufferEndDate?: Date;
  scheduledBufferUnit?: "hours" | "days";
  scheduledStartTime?: string;
  scheduledEndTime?: string;
  actualStartDate?: Date;
  actualEndDate?: Date;

  // Team members (for project bookings)
  assignedTeamMembers?: Types.ObjectId[]; // References to User (employees)

  customerBlocks?: {
    dates?: { date: Date; reason?: string }[];
    windows?: {
      date: Date;
      startTime: string;
      endTime: string;
      reason?: string;
    }[];
  };

  // Communication
  messages?: {
    senderId: Types.ObjectId;
    message: string;
    timestamp: Date;
    attachments?: string[];
  }[];

  // Reviews and ratings (after completion)
  customerReview?: {
    rating: number; // 1-5
    comment?: string;
    reviewedAt: Date;
  };
  professionalReview?: {
    rating: number; // 1-5
    comment?: string;
    reviewedAt: Date;
  };

  // Cancellation
  cancellation?: {
    cancelledBy: Types.ObjectId; // User who cancelled
    reason: string;
    cancelledAt: Date;
    refundAmount?: number;
  };

  // Dispute
  dispute?: {
    raisedBy: Types.ObjectId;
    reason: string;
    description: string;
    raisedAt: Date;
    resolvedAt?: Date;
    resolution?: string;
    resolvedBy?: Types.ObjectId; // Admin who resolved
  };

  // Post-booking questions (filled after booking is confirmed)
  postBookingData?: {
    questionId: string;
    question: string;
    answer: string;
  }[];

  // Metadata
  bookingNumber: string; // Unique booking reference number (e.g., BK-2024-001234)
  notes?: string; // Internal notes
  createdAt: Date;
  updatedAt: Date;
}

const TIME_24H_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

const BookingSchema = new Schema({
  // Core references
  customer: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Customer reference is required'],
    index: true
  },
  bookingType: {
    type: String,
    enum: ['professional', 'project'],
    required: [true, 'Booking type is required']
  },
  professional: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: function(this: IBooking) {
      return this.bookingType === 'professional';
    },
    index: true
  },
  project: {
    type: Schema.Types.ObjectId,
    ref: 'Project',
    required: function(this: IBooking) {
      return this.bookingType === 'project';
    },
    index: true
  },

  // Status and lifecycle
  status: {
    type: String,
    enum: ['rfq', 'quoted', 'quote_accepted', 'quote_rejected', 'payment_pending', 'booked', 'in_progress', 'completed', 'cancelled', 'dispute', 'refunded'],
    default: 'rfq',
    required: true,
    index: true
  },
  statusHistory: [{
    status: {
      type: String,
      enum: ['rfq', 'quoted', 'quote_accepted', 'quote_rejected', 'payment_pending', 'booked', 'in_progress', 'completed', 'cancelled', 'dispute', 'refunded'],
      required: true
    },
    timestamp: {
      type: Date,
      default: Date.now,
      required: true
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    note: {
      type: String,
      maxlength: 500
    }
  }],

  // RFQ data
  rfqData: {
    serviceType: {
      type: String,
      required: [true, 'Service type is required'],
      trim: true,
      maxlength: 200
    },
    description: {
      type: String,
      required: [true, 'Description is required'],
      trim: true,
      maxlength: 2000
    },
    answers: [{
      questionId: { type: String },
      question: {
        type: String,
        required: true,
        maxlength: 500
      },
      answer: {
        type: String,
        required: true,
        maxlength: 1000
      },
      fieldType: {
        type: String,
        enum: ['text', 'number', 'date', 'dropdown', 'checkbox', 'file']
      }
    }],
    preferredStartDate: {
      type: Date
    },
    urgency: {
      type: String,
      enum: ['low', 'medium', 'high', 'urgent'],
      default: 'medium'
    },
    budget: {
      min: { type: Number, min: 0 },
      max: { type: Number, min: 0 },
      currency: {
        type: String,
        default: 'EUR',
        enum: ['USD', 'EUR', 'GBP', 'CAD', 'AUD']
      }
    },
    attachments: [{
      type: String // S3 URLs
    }]
  },

  // Quote
  quote: {
    amount: {
      type: Number,
      required: function(this: IBooking) {
        return this.status !== 'rfq';
      },
      min: 0
    },
    currency: {
      type: String,
      enum: ['USD', 'EUR', 'GBP', 'CAD', 'AUD'],
      default: 'EUR'
    },
    description: {
      type: String,
      maxlength: 1000
    },
    breakdown: [{
      item: { type: String, required: true, maxlength: 200 },
      quantity: { type: Number, min: 0 },
      unitPrice: { type: Number, min: 0 },
      totalPrice: { type: Number, required: true, min: 0 }
    }],
    validUntil: {
      type: Date
    },
    termsAndConditions: {
      type: String,
      maxlength: 2000
    },
    estimatedDuration: {
      type: String,
      maxlength: 100
    },
    submittedAt: {
      type: Date
    },
    submittedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    }
  },

  // Location
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      required: [true, 'Location coordinates are required'],
      validate: {
        validator: function(v: number[]) {
          return v.length === 2 &&
                 v[0] >= -180 && v[0] <= 180 && // longitude
                 v[1] >= -90 && v[1] <= 90;     // latitude
        },
        message: 'Invalid coordinates format. Expected [longitude, latitude]'
      }
    },
    address: { type: String, maxlength: 200 },
    city: { type: String, maxlength: 100 },
    country: { type: String, maxlength: 100 },
    postalCode: { type: String, maxlength: 20 }
  },

  // Payment
  payment: {
    amount: { type: Number, min: 0 },
    currency: {
      type: String,
      enum: ['USD', 'EUR', 'GBP', 'CAD', 'AUD'],
      default: 'EUR'
    },
    method: {
      type: String,
      enum: ['card', 'bank_transfer', 'cash']
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'refunded'],
      default: 'pending'
    },
    stripePaymentIntentId: { type: String },
    stripeChargeId: { type: String },
    paidAt: { type: Date },
    refundedAt: { type: Date },
    refundReason: { type: String, maxlength: 500 }
  },

  // Scheduling
  scheduledStartDate: { type: Date },
  scheduledExecutionEndDate: { type: Date },
  scheduledBufferStartDate: { type: Date },
  scheduledBufferEndDate: { type: Date },
  scheduledBufferUnit: { type: String, enum: ["hours", "days"] },
  scheduledStartTime: {
    type: String,
    trim: true,
    match: [TIME_24H_REGEX, "Invalid time format. Expected HH:mm"],
  },
  scheduledEndTime: {
    type: String,
    trim: true,
    match: [TIME_24H_REGEX, "Invalid time format. Expected HH:mm"],
  },
  actualStartDate: { type: Date },
  actualEndDate: { type: Date },

  // Team members
  assignedTeamMembers: [{
    type: Schema.Types.ObjectId,
    ref: 'User'
  }],

  // Messages
  messages: [{
    senderId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    message: {
      type: String,
      required: true,
      maxlength: 2000
    },
    timestamp: {
      type: Date,
      default: Date.now,
      required: true
    },
    attachments: [{ type: String }]
  }],

  // Reviews
  customerReview: {
    rating: {
      type: Number,
      min: 1,
      max: 5
    },
    comment: {
      type: String,
      maxlength: 1000
    },
    reviewedAt: {
      type: Date,
      default: Date.now
    }
  },
  professionalReview: {
    rating: {
      type: Number,
      min: 1,
      max: 5
    },
    comment: {
      type: String,
      maxlength: 1000
    },
    reviewedAt: {
      type: Date,
      default: Date.now
    }
  },

  // Cancellation
  cancellation: {
    cancelledBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    reason: {
      type: String,
      maxlength: 500
    },
    cancelledAt: {
      type: Date,
      default: Date.now
    },
    refundAmount: {
      type: Number,
      min: 0
    }
  },

  // Dispute
  dispute: {
    raisedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    reason: {
      type: String,
      maxlength: 200
    },
    description: {
      type: String,
      maxlength: 2000
    },
    raisedAt: {
      type: Date,
      default: Date.now
    },
    resolvedAt: { type: Date },
    resolution: { type: String, maxlength: 2000 },
    resolvedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    }
  },

  // Post-booking data
  postBookingData: [{
    questionId: { type: String, required: true },
    question: { type: String, required: true, maxlength: 500 },
    answer: { type: String, required: true, maxlength: 1000 }
  }],

  customerBlocks: {
    dates: [{
      date: { type: Date, required: true },
      reason: { type: String, maxlength: 200 }
    }],
    windows: [{
      date: { type: Date, required: true },
      startTime: {
        type: String,
        required: true,
        trim: true,
        match: [TIME_24H_REGEX, "Invalid time format. Expected HH:mm"],
      },
      endTime: {
        type: String,
        required: true,
        trim: true,
        match: [TIME_24H_REGEX, "Invalid time format. Expected HH:mm"],
      },
      reason: { type: String, maxlength: 200 }
    }]
  },

  // Metadata
  bookingNumber: {
    type: String,
    unique: true,
    index: true
  },
  notes: {
    type: String,
    maxlength: 2000
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
BookingSchema.index({ customer: 1, status: 1 });
BookingSchema.index({ project: 1, status: 1 });
BookingSchema.index({ project: 1, status: 1, scheduledStartDate: 1 });
BookingSchema.index({ bookingType: 1, status: 1 });
BookingSchema.index({ 'location.coordinates': '2dsphere' }); // Geospatial queries
BookingSchema.index({ createdAt: -1 }); // Sort by creation date
BookingSchema.index({ scheduledStartDate: 1 }); // Upcoming bookings
BookingSchema.index({ scheduledBufferEndDate: 1 });
BookingSchema.index({ assignedTeamMembers: 1 });
// Compound index for schedule engine blocked data queries
BookingSchema.index({ assignedTeamMembers: 1, status: 1, scheduledStartDate: 1 });
BookingSchema.index({ professional: 1, status: 1, scheduledStartDate: 1 });
BookingSchema.index({ 'payment.status': 1 }); // Payment tracking
BookingSchema.index({ bookingNumber: 1 }); // Quick lookup by booking number

// Helper to parse HH:mm to minutes for comparison
const parseTimeToMinutes = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

// Pre-save middleware to generate booking number and validate scheduling fields
BookingSchema.pre('save', async function(next) {
  // Cross-field validation for scheduling times
  if (this.scheduledStartTime && this.scheduledEndTime) {
    const startMinutes = parseTimeToMinutes(this.scheduledStartTime);
    const endMinutes = parseTimeToMinutes(this.scheduledEndTime);
    if (startMinutes >= endMinutes) {
      return next(new Error('scheduledStartTime must be before scheduledEndTime'));
    }
  }

  // Cross-field validation for buffer dates
  // Allow equal dates (represents 0 buffer duration when no buffer is configured)
  if (this.scheduledBufferStartDate && this.scheduledBufferEndDate) {
    if (this.scheduledBufferStartDate > this.scheduledBufferEndDate) {
      return next(new Error('scheduledBufferStartDate must be at or before scheduledBufferEndDate'));
    }
  }

  // Buffer alignment validation with execution dates
  // Buffer should start at or after execution end
  if (this.scheduledBufferStartDate && this.scheduledExecutionEndDate) {
    if (this.scheduledBufferStartDate < this.scheduledExecutionEndDate) {
      return next(new Error('scheduledBufferStartDate must be at or after scheduledExecutionEndDate'));
    }
  }

  // Execution end should be at or before buffer end (if both exist)
  if (this.scheduledExecutionEndDate && this.scheduledBufferEndDate) {
    if (this.scheduledExecutionEndDate > this.scheduledBufferEndDate) {
      return next(new Error('scheduledExecutionEndDate must be at or before scheduledBufferEndDate'));
    }
  }

  // Scheduled start date should be before execution end date
  if (this.scheduledStartDate && this.scheduledExecutionEndDate) {
    if (this.scheduledStartDate >= this.scheduledExecutionEndDate) {
      return next(new Error('scheduledStartDate must be before scheduledExecutionEndDate'));
    }
  }

  // Validate customerBlocks time windows
  if (this.customerBlocks?.windows) {
    for (const window of this.customerBlocks.windows) {
      if (window.startTime && window.endTime) {
        const startMinutes = parseTimeToMinutes(window.startTime);
        const endMinutes = parseTimeToMinutes(window.endTime);
        if (startMinutes >= endMinutes) {
          return next(new Error('customerBlocks window startTime must be before endTime'));
        }
      }
    }
  }

  if (this.isNew && !this.bookingNumber) {
    const year = new Date().getFullYear();
    const count = await model('Booking').countDocuments();
    this.bookingNumber = `BK-${year}-${String(count + 1).padStart(6, '0')}`;
  }

  // Initialize status history if empty
  if (this.isNew && this.statusHistory.length === 0) {
    this.statusHistory.push({
      status: this.status,
      timestamp: new Date(),
      note: 'Booking created'
    });
  }

  next();
});

// Method to update status with history tracking
BookingSchema.methods.updateStatus = function(
  newStatus: BookingStatus,
  updatedBy?: Types.ObjectId,
  note?: string
) {
  this.status = newStatus;
  this.statusHistory.push({
    status: newStatus,
    timestamp: new Date(),
    updatedBy,
    note
  });
  return this.save();
};

const Booking = model<IBooking>('Booking', BookingSchema);

export default Booking;
