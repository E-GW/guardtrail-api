// db.js
// Creates and exports a PostgreSQL connection pool used by all route handlers.
// A connection pool maintains multiple open database connections and reuses them
// across requests, which is far more efficient than opening a new connection
// for every API call.

const { Pool } = require('pg');
require('dotenv').config();

// Initialize the pool with connection settings from environment variables.
// In local development these come from the .env file.
// In production on ECS Fargate they are injected by the task definition.
const pool = new Pool({
  host:     process.env.DB_HOST,      // RDS endpoint address
  port:     process.env.DB_PORT,      // PostgreSQL default port 5432
  database: process.env.DB_NAME,      // Database name (postgres)
  user:     process.env.DB_USER,      // Master username
  password: process.env.DB_PASSWORD,  // Master password

  // SSL is required for all Amazon RDS connections.
  // rejectUnauthorized: false accepts RDS's self-signed certificate —
  // acceptable here because we trust the AWS network and RDS endpoint.
  ssl: {
    rejectUnauthorized: false
  }
});

// Fires once each time the pool opens a new connection to the database.
// Useful for confirming the API successfully reached RDS on startup.
pool.on('connect', () => {
  console.log('Connected to the database');
});

// Fires if a pooled connection encounters an unexpected error while idle.
// Calling process.exit(-1) forces the container to crash and restart,
// which is safer than continuing to run with a broken database connection.
// ECS will automatically restart the task when it exits.
pool.on('error', (err) => {
  console.error('Unexpected database error', err);
  process.exit(-1);
});

// Export the pool so any file can import it and call pool.query()
// without creating a new connection each time
module.exports = pool;
