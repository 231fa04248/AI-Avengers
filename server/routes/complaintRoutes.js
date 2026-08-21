import { Router } from 'express';
import { protect, authorize } from '../middleware/auth.js';
import { complaintUpload } from '../middleware/upload.js';
import * as controller from '../controllers/complaintController.js';

const router = Router();
router.use(protect);
router.post('/', authorize('citizen', 'admin'), complaintUpload.array('images', 6), controller.create);
router.get('/', controller.list);
router.get('/:id', controller.getOne);
router.put('/:id', complaintUpload.array('images', 6), controller.update);
router.delete('/:id', controller.remove);
router.post('/:id/assign', authorize('admin', 'department_officer'), controller.assign);
router.post('/:id/status', controller.changeStatus);
router.post('/:id/resolve', authorize('admin', 'department_officer', 'field_worker'), complaintUpload.array('images', 6), controller.resolve);
router.post('/:id/close', authorize('admin', 'department_officer', 'citizen'), controller.close);
router.post('/:id/reopen', authorize('admin', 'citizen'), controller.reopen);
router.get('/:id/timeline', controller.timeline);
router.post('/:id/updates', complaintUpload.array('images', 6), controller.addUpdate);
router.post('/:id/duplicate-override', authorize('admin'), controller.overrideDuplicate);
export default router;

