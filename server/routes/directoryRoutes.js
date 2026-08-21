import { Router } from 'express';
import { protect, authorize } from '../middleware/auth.js';
import * as controller from '../controllers/directoryController.js';

const router = Router();
router.use(protect);
router.get('/departments', controller.listDepartments);
router.post('/departments', authorize('admin'), controller.createDepartment);
router.put('/departments/:id', authorize('admin'), controller.updateDepartment);
router.delete('/departments/:id', authorize('admin'), controller.deleteDepartment);
router.get('/teams', controller.listTeams);
router.post('/teams', authorize('admin', 'department_officer'), controller.createTeam);
router.put('/teams/:id', authorize('admin', 'department_officer'), controller.updateTeam);
router.delete('/teams/:id', authorize('admin'), controller.deleteTeam);
router.get('/users', authorize('admin'), controller.listUsers);
router.put('/users/:id', authorize('admin'), controller.updateUser);
export default router;

