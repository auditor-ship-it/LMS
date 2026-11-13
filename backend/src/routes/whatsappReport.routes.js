import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requirePermission } from '../middlewares/permission.middleware.js';
import * as whatsappReportController from '../controllers/whatsappReport.controller.js';

/** Daily WhatsApp Report admin API — mounted at /api/whatsapp-report. Admin-only
 *  (whatsappReportAdmin permission, see config/permissions.config.js). */
const router = Router();
router.use(requireAuth, requirePermission('whatsappReportAdmin'));

router.get('/', asyncHandler(whatsappReportController.getOverview));
router.put('/settings', asyncHandler(whatsappReportController.putSettings));
router.get('/status', asyncHandler(whatsappReportController.getStatus));
router.get('/session', asyncHandler(whatsappReportController.getSession));
router.post('/session/start', asyncHandler(whatsappReportController.postSessionStart));
router.post('/session/logout', asyncHandler(whatsappReportController.postSessionLogout));
router.get('/groups', asyncHandler(whatsappReportController.getGroups));
router.get('/preview', asyncHandler(whatsappReportController.getPreview));
router.post('/send-now', asyncHandler(whatsappReportController.postSendNow));

export default router;
