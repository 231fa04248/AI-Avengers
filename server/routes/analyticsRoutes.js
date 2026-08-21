import { Router } from 'express';
import { protect, authorize } from '../middleware/auth.js';
import * as controller from '../controllers/analyticsController.js';

const router = Router();
router.use(protect, authorize('admin', 'department_officer'));
router.get('/overview', controller.overview);
router.get('/category', controller.byCategory);
router.get('/priority', controller.byPriority);
router.get('/status', controller.byStatus);
router.get('/department', controller.byDepartment);
router.get('/recurring', controller.recurring);
router.get('/locations', controller.locations);
export default router;

