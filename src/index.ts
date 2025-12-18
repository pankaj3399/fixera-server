import express, { Express, Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import errorHandler from './handlers/error';
import connectDB from './config/db';
import authRouter from './routes/Auth';
import userRouter from './routes/User';
import adminRouter from './routes/Admin';
import projectRouter from './routes/Project';
import publicRouter from './routes/Public';
import meetingRouter from './routes/Meeting';
import serviceCategoryRouter from './routes/ServiceCategory';
import professionalRouter from './routes/Professional';
import searchRouter from './routes/Search';
import bookingRouter from './routes/Booking';

dotenv.config();

const app: Express = express();

// CORS configuration - allow all origins with credentials
const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    // or reflect the origin for any request
    callback(null, origin || true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
  exposedHeaders: ['Set-Cookie'],
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Handle preflight requests explicitly for all routes
app.options('*', cors(corsOptions));

// Body and cookie parsers
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

// Health check and root routes (before DB middleware - no DB needed)
app.get('/', (req: Request, res: Response) => {
  res.json({
    message: 'Fixera API Server is running',
    status: 'Up',
    version: '1.0.0',
  });
});

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: "UP" });
});

// Database connection middleware for Vercel serverless (only for /api routes)
app.use('/api', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error('Database connection error:', error);
    res.status(500).json({ success: false, msg: 'Database connection failed' });
  }
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

// Error handler (must be last)
app.use(errorHandler);

// Only start server locally (not on Vercel)
const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true';

if (!isVercel) {
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;

  connectDB()
    .then(() => {
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
      });
    })
    .catch((error) => {
      console.error('Failed to connect to MongoDB at startup:', error);
      process.exit(1);
    });
}

export default app;
