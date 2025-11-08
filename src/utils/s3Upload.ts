import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Request } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'fixera-uploads';

// Configure multer for memory storage
const storage = multer.memoryStorage();

// File filter for ID proofs (images and PDFs only)
const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedMimeTypes = [
    // Images
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    // Documents
    'application/pdf',
    // Videos
    'video/mp4',
    'video/quicktime', // .mov
    'video/x-msvideo', // .avi
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Allowed: JPEG, PNG, WebP, PDF, MP4, MOV, AVI'));
  }
};

// Multer configuration
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit (for videos)
  },
});

// Generate unique filename
export const generateFileName = (originalName: string, userId: string, type: string): string => {
  const ext = path.extname(originalName);
  const timestamp = Date.now();
  const randomString = crypto.randomBytes(8).toString('hex');
  return `${type}/${userId}/${timestamp}-${randomString}${ext}`;
};

// Upload file to S3
export const uploadToS3 = async (
  file: Express.Multer.File,
  fileName: string
): Promise<{ url: string; key: string }> => {
  try {
    console.log(`📤 S3: Uploading file ${fileName} to S3...`);
    
    const uploadParams = {
      Bucket: BUCKET_NAME,
      Key: fileName,
      Body: file.buffer,
      ContentType: file.mimetype,
      ContentDisposition: 'inline', // Allow viewing in browser
    };

    const command = new PutObjectCommand(uploadParams);
    await s3Client.send(command);

    const fileUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${fileName}`;
    
    console.log(`✅ S3: File uploaded successfully - ${fileUrl}`);
    
    return {
      url: fileUrl,
      key: fileName
    };
  } catch (error) {
    console.error('❌ S3: Upload failed:', error);
    throw new Error('Failed to upload file to S3');
  }
};

// Delete file from S3
export const deleteFromS3 = async (key: string): Promise<void> => {
  try {
    console.log(`🗑️ S3: Deleting file ${key} from S3...`);
    
    const deleteParams = {
      Bucket: BUCKET_NAME,
      Key: key,
    };

    const command = new DeleteObjectCommand(deleteParams);
    await s3Client.send(command);
    
    console.log(`✅ S3: File deleted successfully - ${key}`);
  } catch (error) {
    console.error('❌ S3: Delete failed:', error);
    throw new Error('Failed to delete file from S3');
  }
};

// Generate presigned URL for secure file viewing
export const getPresignedUrl = async (key: string, expiresIn: number = 3600): Promise<string> => {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });

    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn });
    return signedUrl;
  } catch (error) {
    console.error('❌ S3: Failed to generate presigned URL:', error);
    throw new Error('Failed to generate file access URL');
  }
};

// Validate file before upload
export const validateFile = (file: Express.Multer.File): { valid: boolean; error?: string } => {
  // Check file size (5MB limit)
  if (file.size > 5 * 1024 * 1024) {
    return { valid: false, error: 'File size must be less than 5MB' };
  }

  // Check file type
  const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
  if (!allowedMimeTypes.includes(file.mimetype)) {
    return { valid: false, error: 'Invalid file type. Only JPEG, PNG, and PDF files are allowed' };
  }

  // Check filename
  if (!file.originalname || file.originalname.length > 255) {
    return { valid: false, error: 'Invalid filename' };
  }

  return { valid: true };
};

// Validate image file
export const validateImageFile = (file: Express.Multer.File): { valid: boolean; error?: string } => {
  if (file.size > 5 * 1024 * 1024) {
    return { valid: false, error: 'Image must be less than 5MB' };
  }
  const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (!allowedImageTypes.includes(file.mimetype)) {
    return { valid: false, error: 'Invalid image type' };
  }
  return { valid: true };
};

// Validate video file
export const validateVideoFile = (file: Express.Multer.File): { valid: boolean; error?: string } => {
  if (file.size > 50 * 1024 * 1024) {
    return { valid: false, error: 'Video must be less than 50MB' };
  }
  const allowedVideoTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo'];
  if (!allowedVideoTypes.includes(file.mimetype)) {
    return { valid: false, error: 'Invalid video type. Use MP4, MOV, or AVI' };
  }
  return { valid: true };
};

// Validate certification file
export const validateCertificationFile = (file: Express.Multer.File): { valid: boolean; error?: string } => {
  if (file.size > 10 * 1024 * 1024) {
    return { valid: false, error: 'Certification must be less than 10MB' };
  }
  const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png'];
  if (!allowedTypes.includes(file.mimetype)) {
    return { valid: false, error: 'Certification must be PDF or image' };
  }
  return { valid: true };
};

// Upload project file
export const uploadProjectFile = async (
  file: Express.Multer.File,
  userId: string,
  projectId: string,
  fileType: 'image' | 'video' | 'certification' | 'attachment'
): Promise<{ url: string; key: string }> => {
  const fileName = generateFileName(file.originalname, userId, `projects/${projectId}/${fileType}`);
  return uploadToS3(file, fileName);
};

// Helper to parse S3 object key from the stored URL
export const parseS3KeyFromUrl = (url: string): string | null => {
  try {
    const u = new URL(url);
    return u.pathname.startsWith('/') ? u.pathname.slice(1) : u.pathname;
  } catch {
    return null;
  }
};
