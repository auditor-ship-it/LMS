import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import * as authController from '../controllers/auth.controller.js';

const router = Router();

// Public (no session yet)
router.post('/login', asyncHandler(authController.login));
router.post('/otp/request', asyncHandler(authController.requestOtp));
router.post('/otp/reset', asyncHandler(authController.resetPassword));

// Authenticated
router.post('/logout', requireAuth, asyncHandler(authController.logout));
router.post('/heartbeat', requireAuth, asyncHandler(authController.heartbeat));
router.get('/me', requireAuth, asyncHandler(authController.me));
router.get('/access-bundle', requireAuth, asyncHandler(authController.accessBundle));
router.get('/permissions', requireAuth, asyncHandler(authController.permissions));
router.get('/sidebar-visibility', requireAuth, asyncHandler(authController.sidebarVisibility));
router.get('/login-activity', requireAuth, asyncHandler(authController.loginActivity));
router.post('/admin/add-user', requireAuth, asyncHandler(authController.addUser));

export default router;
