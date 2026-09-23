import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
//
// defineConfig comes from vitest/config rather than vite so the `test` block
// below is typed and validated. Vite itself ignores `test`.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.{js,jsx}'],
    // Explicit imports (describe/it/expect from 'vitest') rather than globals,
    // matching the backend suite and keeping ESLint's no-undef honest.
    globals: false,
  },
})
