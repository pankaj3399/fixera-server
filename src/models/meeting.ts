import { Schema, model, Document } from "mongoose";

export type MeetingType = 'planning' | 'team';

export interface IMeetingAttendee {
    userId: string;
    name: string;
    role: 'professional' | 'team_member';
    status: 'pending' | 'accepted' | 'declined';
    responseAt?: Date;
}

export interface IMeeting extends Document {
    projectId: string;
    professionalId: string;
    meetingType: MeetingType;
    title: string;
    description?: string;

    // Meeting date and time
    scheduledDate: Date;
    startTime: string; // Format: "HH:mm"
    endTime: string; // Format: "HH:mm"
    duration: number; // In minutes

    // Attendees
    attendees: IMeetingAttendee[];

    // Meeting details
    location?: string;
    meetingLink?: string; // For online meetings
    isOnline: boolean;

    // Meeting status
    status: 'scheduled' | 'cancelled' | 'completed' | 'rescheduled';
    cancellationReason?: string;
    cancelledAt?: Date;
    cancelledBy?: string;

    // Rescheduling
    previousScheduledDate?: Date;
    rescheduledBy?: string;
    rescheduledAt?: Date;
    reschedulingReason?: string;

    // Notes and attachments
    agenda?: string;
    notes?: string;
    attachments?: string[];

    // Metadata
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
}

const MeetingAttendeeSchema = new Schema<IMeetingAttendee>({
    userId: { type: String, required: true },
    name: { type: String, required: true },
    role: { type: String, enum: ['professional', 'team_member'], required: true },
    status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending' },
    responseAt: { type: Date }
});

const MeetingSchema = new Schema<IMeeting>({
    projectId: { type: String, required: true, index: true },
    professionalId: { type: String, required: true, index: true },
    meetingType: {
        type: String,
        enum: ['planning', 'team'],
        required: true
    },
    title: {
        type: String,
        required: true,
        maxlength: 200
    },
    description: {
        type: String,
        maxlength: 1000
    },

    // Meeting date and time
    scheduledDate: {
        type: Date,
        required: true,
        index: true
    },
    startTime: {
        type: String,
        required: true,
        validate: {
            validator: function(v: string) {
                return /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/.test(v);
            },
            message: 'Invalid time format. Use HH:mm'
        }
    },
    endTime: {
        type: String,
        required: true,
        validate: {
            validator: function(v: string) {
                return /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/.test(v);
            },
            message: 'Invalid time format. Use HH:mm'
        }
    },
    duration: {
        type: Number,
        required: true,
        min: 15,
        max: 480 // 8 hours max
    },

    // Attendees
    attendees: [MeetingAttendeeSchema],

    // Meeting details
    location: {
        type: String,
        maxlength: 300
    },
    meetingLink: {
        type: String,
        maxlength: 500
    },
    isOnline: {
        type: Boolean,
        default: false
    },

    // Meeting status
    status: {
        type: String,
        enum: ['scheduled', 'cancelled', 'completed', 'rescheduled'],
        default: 'scheduled',
        index: true
    },
    cancellationReason: {
        type: String,
        maxlength: 500
    },
    cancelledAt: { type: Date },
    cancelledBy: { type: String },

    // Rescheduling
    previousScheduledDate: { type: Date },
    rescheduledBy: { type: String },
    rescheduledAt: { type: Date },
    reschedulingReason: {
        type: String,
        maxlength: 500
    },

    // Notes and attachments
    agenda: {
        type: String,
        maxlength: 2000
    },
    notes: {
        type: String,
        maxlength: 5000
    },
    attachments: [{ type: String }],

    // Metadata
    createdBy: { type: String, required: true },
}, {
    timestamps: true
});

// Indexes for efficient querying
MeetingSchema.index({ projectId: 1, meetingType: 1 });
MeetingSchema.index({ professionalId: 1, scheduledDate: 1 });
MeetingSchema.index({ professionalId: 1, status: 1 });
MeetingSchema.index({ 'attendees.userId': 1, scheduledDate: 1 });

// Virtual for checking if meeting is in the past
MeetingSchema.virtual('isPast').get(function() {
    return new Date() > this.scheduledDate;
});

const Meeting = model<IMeeting>('Meeting', MeetingSchema);

export default Meeting;
