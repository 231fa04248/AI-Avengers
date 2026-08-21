import { Router } from 'express';
import { protect } from '../middleware/auth.js';
import * as controller from '../controllers/notificationController.js';

const router = Router();
router.use(protect);
router.get('/', controller.list);
router.put('/:id/read', controller.read);
router.put('/read-all', controller.readAll);
export default router;

