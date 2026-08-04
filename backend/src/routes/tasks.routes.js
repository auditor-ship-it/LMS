import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import * as tasksController from '../controllers/tasks.controller.js';

const router = Router();
router.use(requireAuth);

router.get('/mine', asyncHandler(tasksController.myTasks));
router.get('/employee/:employeeCode', asyncHandler(tasksController.employeeTasks));

export default router;
