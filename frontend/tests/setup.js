// tests/setup.js
//
// Runs before every frontend test file (vite.config.js -> test.setupFiles).
//
// jest-dom adds DOM matchers such as toBeInTheDocument to Vitest's expect.
// cleanup unmounts whatever a test rendered; with globals off, Testing Library
// cannot register this itself, so it is done here once for every file.

import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(cleanup)
