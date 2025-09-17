import express, { Express, Request, Response} from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import errorHandler from './handlers/error';
import connectDB from './config/db';
import authRouter from './routes/Auth';
import userRouter from './routes/User';
import adminRouter from './routes/Admin';
import projectRouter from './routes/Project';

dotenv.config();

const app: Express = express();

// 🚨 Allow ALL origins but still allow credentials (cookies)
app.use(cors({
  origin: true, // Reflects the request's Origin header
  credentials: true, // Allow cookies
}));

// Body and cookie parsers
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
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
app.use('/api/admin', adminRouter);
app.use('/api/projects', projectRouter);

// Error handler (must be last)
app.use(errorHandler);

// Traditional server: connect once at startup, then listen
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

export default app;
