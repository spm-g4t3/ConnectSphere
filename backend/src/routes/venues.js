/**
 * Venue catalogue routes.
 *
 * Thin wrappers around src/services/venueService.js.
 */

import express from 'express';

import {
  createVenue,
  updateVenue,
  getVenueById,
} from '../services/venueService.js';
import { AppError } from '../errors.js';

const router = express.Router();

function handleError(err, res) {
  if (err instanceof AppError) {
    const body = { error: err.message };
    if (err.details) body.details = err.details;
    return res.status(err.status).json(body);
  }
  console.error('Unexpected error in venues route:', err);
  return res.status(500).json({ error: 'Unexpected server error' });
}

router.post('/', async (req, res) => {
  try {
    const venue = await createVenue(req.body, req.body.userId ?? null);
    res.status(201).json(venue);
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const venue = await getVenueById(req.params.id);
    res.status(200).json(venue);
  } catch (err) {
    handleError(err, res);
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const venue = await updateVenue(req.params.id, req.body, req.body.userId ?? null);
    res.status(200).json(venue);
  } catch (err) {
    handleError(err, res);
  }
});

export default router;
