import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import express, { Express, Request, Response} from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import errorHandler from './handlers/error';
import connectDB from './config/db';
import BacklinkSubmission from './models/backlinkSubmission';
import { recoverStuckVerifyingSubmissions } from './utils/backlink/verifySubmission';
import authRouter from './routes/Auth';
import userRouter from './routes/User';
import adminRouter from './routes/Admin';
import projectRouter from './routes/Project';
import publicRouter from './routes/Public';
import meetingRouter from './routes/Meeting';
import serviceCategoryRouter from './routes/ServiceCategory';
import professionalRouter from './routes/Professional';
import professionalPaymentRouter from './routes/ProfessionalPayment';
import searchRouter from './routes/Search';
import bookingRouter from './routes/Booking';
import quotationRouter from './routes/Quotation';
import stripeRouter from './routes/Stripe';
import chatRouter from './routes/Chat';
import warrantyClaimRouter from './routes/WarrantyClaim';
import favoritesRouter from './routes/Favorites';
import supportRouter from './routes/Support';

const app: Express = express();

// Vercel (and similar hosts) terminate TLS and forward the real client IP in
// X-Forwarded-For. Trust one proxy hop so req.ip / express-rate-limit key on
// the client, not the edge. Use `1` (not `true`) to avoid permissive trust.
app.set('trust proxy', 1);

// 🚨 Allow ALL origins but still allow credentials (cookies)
app.use(cors({
  origin: true, // Reflects the request's Origin header
  credentials: true, // Allow cookies
}));

app.use('/api/stripe/webhooks', express.raw({ type: 'application/json' }));

// Body and cookie parsers
// Project-copy requests contain only bounded text and must stay far below the
// legacy draft limit, which still needs room for existing base64 media drafts.
app.use('/api/projects/generate-copy', express.json({ limit: '16kb' }));
// Project drafts still embed media as data URLs, so keep the legacy-compatible
// ceiling until that flow is migrated to direct object-storage uploads.
const BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || '50mb';
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ limit: BODY_LIMIT, extended: true }));
app.use(cookieParser());

// Health check and root routes
app.get('/', (req: Request, res: Response) => {
  res.json({
    message: 'Fixtract API Server is running',
    status: 'Up',
    version: '1.0.0',
  });
});

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: "UP" });
});

// API routes
app.use('/api/public', publicRouter);
app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);
app.use('/api/admin', adminRouter);
app.use('/api/projects', projectRouter);
app.use('/api/meetings', meetingRouter);
app.use('/api/service-categories', serviceCategoryRouter);
app.use('/api/professionals', professionalRouter);
app.use('/api/search', searchRouter);
app.use('/api/bookings', bookingRouter);
app.use('/api/quotations', quotationRouter);
app.use('/api/stripe', stripeRouter);
app.use('/api/professional', professionalPaymentRouter);
app.use('/api/chat', chatRouter);
app.use('/api/warranty-claims', warrantyClaimRouter);
app.use('/api/favorites', favoritesRouter);
app.use('/api/support', supportRouter);

// Unknown API routes must return JSON, not Express' HTML 404 page.
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    msg: 'The requested resource could not be found.',
    message: 'The requested resource could not be found.',
    code: 'NOT_FOUND',
  });
});

// Error handler (must be last)
app.use(errorHandler);

// Traditional server: connect once at startup, then listen
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
const STUCK_VERIFY_SWEEP_MS = 10 * 60 * 1000;

connectDB()
  .then(async () => {
    try {
      await BacklinkSubmission.syncIndexes();
    } catch (error) {
      console.error('BacklinkSubmission.syncIndexes failed:', error);
    }
    try {
      await recoverStuckVerifyingSubmissions();
    } catch (error) {
      console.error('Initial stuck verification recovery failed:', error);
    }
    const sweepTimer = setInterval(() => {
      void recoverStuckVerifyingSubmissions().catch((error) => {
        console.error('Stuck verification sweep failed:', error);
      });
    }, STUCK_VERIFY_SWEEP_MS);
    sweepTimer.unref();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to connect to MongoDB at startup:', error);
    process.exit(1);
  });

export default app;
