/**
 * Tests for how src/app.js mounts the routers, driven through the real app.
 * Importing app.js would start a server, so express's listen is stubbed before
 * the import; supertest starts its own server and never calls app.listen.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { rpc, requireAuth, startBackgroundJobs } = vi.hoisted(() => ({
  rpc: vi.fn(),
  startBackgroundJobs: vi.fn(() => []),
  // Counts each authentication: the real one is a getUser call and a profile read.
  requireAuth: vi.fn((req, _res, next) => {
    req.user = { id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', email: 'tech@example.com', role: 'technical_support_staff' };
    next();
  }),
}));

vi.mock('dotenv/config', () => ({}));

vi.mock('../src/jobs/backgroundJobs.js', () => ({ startBackgroundJobs }));

vi.mock('../src/config/supabaseClient.js', () => {
  const client = { rpc };
  return { supabase: client, supabaseAdmin: client, supabaseAuth: client, default: client };
});

vi.mock('../src/middleware/requireAuth.js', () => ({
  requireAuth,
  createRequireAuth: () => requireAuth,
}));

const listen = vi.spyOn(express.application, 'listen').mockImplementation(() => ({}));
const { default: app } = await import('../src/app.js');
listen.mockRestore();
// Vitest clears call history before each test, so the import's calls are kept here.
const jobStartsAtImport = startBackgroundJobs.mock.calls.slice();

beforeEach(() => {
  rpc.mockReset();
  requireAuth.mockClear();
});

describe('background jobs', () => {
  it('SCRUM177_AC1_the_app_starts_its_background_jobs_once_with_the_process_environment', () => {
    // Which jobs that starts, and their switches, are in tests/jobs/backgroundJobs.test.js.
    expect(jobStartsAtImport).toEqual([[]]);
  });
});

describe('the equipment availability mount', () => {
  it('SCRUM23_AC1_authenticates_an_availability_request_once', async () => {
    rpc.mockResolvedValue({
      data: { found: true, retired: false, total: 10, damaged: 0, under_maintenance: 0, reserved: 0, available: 10, reservations: [] },
      error: null,
    });

    const res = await request(app).get('/api/equipment/availability').query({
      equipmentTypeId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      quantity: '4',
      startAt: '2026-12-01T10:00:00Z',
      endAt: '2026-12-01T12:00:00Z',
    });

    expect(res.status).toBe(200);
    expect(requireAuth).toHaveBeenCalledTimes(1);
  });
});
