// Public lead capture web form (F3.1). No login; protected by rate limiting, validation and a honeypot.
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, tx } from '../db/pool.js';
import { Router, parse, HttpError } from '../lib/http.js';
import { normalizePhone } from '../lib/phone.js';
import { createLead } from '../services/leads.js';

const r = Router();
const limiter = rateLimit({ windowMs: 10 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many submissions. Please try again in a few minutes.' } });

async function wsByToken(token) {
  const ws = token && token.length >= 10 ? await one('SELECT id, name FROM workspaces WHERE webhook_token = $1', [token]) : null;
  if (!ws) throw new HttpError(404, 'This form does not exist.');
  return ws;
}

r.get('/forms/:token', async (req, res) => {
  const ws = await wsByToken(req.params.token);
  res.json({ workspace: ws.name });
});

r.post('/forms/:token', limiter, async (req, res) => {
  const ws = await wsByToken(req.params.token);
  const b = parse(z.object({
    name: z.string().trim().min(1, 'Please enter your name').max(120),
    email: z.string().trim().email('Please enter a valid email').max(200).optional().or(z.literal('')),
    phone: z.string().trim().max(30).optional().or(z.literal('')),
    message: z.string().trim().max(3000).optional().or(z.literal('')),
    website: z.string().max(0).optional().or(z.literal('')), // honeypot: real people leave it empty
  }).refine((v) => v.email || v.phone, { message: 'Please give an email or a phone number so we can reply', path: ['email'] }), req.body);
  if (b.phone && !normalizePhone(b.phone)) throw new HttpError(400, 'Please enter the phone number in international format, e.g. +923001234567');
  const [firstName, ...rest] = b.name.split(/\s+/);
  await tx((db) => createLead(db, {
    workspaceId: ws.id, source: 'web_form',
    contact: { firstName, lastName: rest.join(' '), email: b.email || null, phone: b.phone || null },
    message: b.message || null, actor: null,
  }));
  res.status(201).json({ ok: true, message: `Thanks! ${ws.name} has received your request and will contact you shortly.` });
});

export default r;
