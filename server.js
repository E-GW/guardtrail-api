// server.js
// Entry point for the GuardTrail API server.
// Sets up Express middleware, registers routes, and starts listening for requests.

// Load environment variables from .env file first — must be called before any
// other code that reads process.env, such as database or Cognito config
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
 
const app = express();

// ── Middleware ──
// express.json() parses incoming request bodies with Content-Type: application/json
// and makes the parsed data available as req.body in route handlers
app.use(express.json());

// cors() allows the React front-end (running on a different origin/port)
// to make requests to this API. Without this, browsers block cross-origin requests.
app.use(cors());

// helmet() sets security-related HTTP response headers automatically,
// protecting against common web vulnerabilities like XSS and clickjacking
app.use(helmet());

// ── Routes ──
// Mount the reports router at /api/reports.
// All routes defined in reports.js will be prefixed with /api/reports
// e.g. router.get('/') becomes GET /api/reports
//      router.post('/') becomes POST /api/reports
//      router.delete('/:id') becomes DELETE /api/reports/:id
const reportsRouter = require('./routes/reports');
app.use('/api/reports', reportsRouter);

// Confirms both routes loaded successfully on server startup
console.log('Routes registered: /health and /api/reports');

// ── Health check endpoint ──
// Returns a simple ok response with a timestamp.
// AWS Application Load Balancer calls this endpoint periodically to confirm
// the container is alive. If it stops responding, ECS restarts the task.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── 404 handler ──
// Catches any request that didn't match a registered route.
// Must be placed after all route definitions so it only fires as a fallback.
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Global error handler ──
// Express recognizes error-handling middleware by its four-parameter signature (err, req, res, next).
// Any route that calls next(err) or throws an unhandled error will land here.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start the server ──
// Falls back to port 3000 if PORT is not set in the environment.
// In production on ECS, PORT is injected as an environment variable in the task definition.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GuardTrail API running on port ${PORT}`);
});
