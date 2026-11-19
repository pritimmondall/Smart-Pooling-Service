import { Router } from 'express';
import { register, login, getMe } from './auth.controller.js';
import { protect } from '../../middleware/auth.js';
import { requireBodyFields } from '../../middleware/validate.js';

const router = Router();

router.post('/register', requireBodyFields('name', 'email', 'password'), register);
router.post('/login', requireBodyFields('email', 'password'), login);
router.get('/me', protect, getMe);

export default router;
