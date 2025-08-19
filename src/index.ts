import express, { Express, Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import errorHandler from './handlers/error';
import connectDB from './config/db';
import authRouter from './routes/Auth';
import userRouter from './routes/User';

dotenv.config();

const app: Express = express();

// 🚨 Allow ALL origins but still allow credentials (cookies)
app.use(cors({
  origin: true, // Reflects the request's Origin header
  credentials: true, // Allow cookies
}));

// Database connection middleware
app.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error('Database connection failed on request:', error);
    res.status(500).json({
      message: 'Internal Server Error: Could not connect to the database.',
    });
  }
});

// Body and cookie parsers
app.use(express.json());
app.use(cookieParser());

// Health check and root routes
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

// API routes
app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);

// Error handler (must be last)
app.use(errorHandler);

if (!process.env.VERCEL) {
  app.listen(4000, () => {
    
  });
}

export default app;
