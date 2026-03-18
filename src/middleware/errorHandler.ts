import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError, ErrorResponse } from '../types';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const timestamp = new Date().toISOString();

  if (err instanceof AppError) {
    const response: ErrorResponse = {
      success: false,
      error: err.errorCode,
      message: err.message,
      timestamp,
    };
    res.status(err.statusCode).json(response);
    return;
  }

  if (err instanceof ZodError) {
    const response: ErrorResponse = {
      success: false,
      error: 'VALIDATION_ERROR',
      message: err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', '),
      timestamp,
    };
    res.status(400).json(response);
    return;
  }

  console.error('Unhandled error:', err);

  const response: ErrorResponse = {
    success: false,
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    timestamp,
  };
  res.status(500).json(response);
}
