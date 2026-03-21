import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError, EnrollResponse, EnrolledUser } from '../types';

const router = Router();

const enrolledUsers = new Map<string, EnrolledUser>();

const enrollRequestSchema = z.object({
  tenant_id: z.string().min(1, 'tenant_id is required'),
  user_id: z.string().min(1, 'user_id is required'),
  face_descriptor: z.array(z.number()).min(1, 'face_descriptor is required'),
});

router.post(
  '/auth/enroll',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedBody = enrollRequestSchema.parse(req.body);
      const { tenant_id, user_id, face_descriptor } = validatedBody;

      if (face_descriptor.length === 0) {
        throw new AppError(422, 'NO_FACE_DETECTED', 'No face descriptor provided');
      }

      const enrollmentKey = `${tenant_id}:${user_id}`;
      const enrolledAt = new Date().toISOString();

      const enrolledUser: EnrolledUser = {
        user_id,
        tenant_id,
        embedding: face_descriptor,
        enrolled_at: enrolledAt,
      };

      enrolledUsers.set(enrollmentKey, enrolledUser);

      console.log(`User enrolled: tenant=${tenant_id}, user=${user_id}`);

      const response: EnrollResponse = {
        success: true,
        user_id,
        enrolled_at: enrolledAt,
      };

      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  }
);

export { enrolledUsers };
export default router;
