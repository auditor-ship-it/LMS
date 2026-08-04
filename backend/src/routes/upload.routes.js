import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { uploadFile } from '../controllers/upload.controller.js';

const router = Router();
router.post('/', requireAuth, asyncHandler(uploadFile));

export default router;
