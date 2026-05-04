// reports.js
// Defines all CRUD API endpoints for trail condition reports.
// Mounted at /api/reports in server.js, so all routes here are relative to that prefix.
// Public endpoints (GET) require no authentication.
// Write endpoints (POST, PUT, DELETE) require a valid Cognito JWT via the auth middleware.

const express = require('express');
const router = express.Router();
const pool = require('../db');           // PostgreSQL connection pool
const auth = require('../middleware/auth'); // JWT verification middleware

// ──────────────────────────────────────────
// READ — Get all reports (public, no auth)
// GET /api/reports
// Optional query params: status, type, severity
// Returns a GeoJSON FeatureCollection for use by Leaflet.js
// ──────────────────────────────────────────
router.get('/', async (req, res) => {
  // Default to 'active' if no status param provided
  const { status = 'active', type, severity } = req.query;

  try {
    // Build the query dynamically based on which filters were provided.
    // ST_AsGeoJSON converts the PostGIS GEOGRAPHY column to a GeoJSON string,
    // then ::json casts it to a JSON object so it embeds correctly in the response.
    let query = `
      SELECT
        id,
        trail_name,
        condition_type,
        severity,
        description,
        photo_url,
        status,
        created_at,
        updated_at,
        ST_AsGeoJSON(location)::json AS location
      FROM reports
      WHERE status = $1
    `;

    // Parameterized queries ($1, $2, etc.) prevent SQL injection by
    // separating the query structure from user-supplied values
    const params = [status];

    // Append optional filters only if the query param was provided
    if (type) {
      params.push(type);
      query += ` AND condition_type = $${params.length}`;
    }

    if (severity) {
      params.push(severity);
      query += ` AND severity = $${params.length}`;
    }

    // Most recent reports appear first in the sidebar list
    query += ` ORDER BY created_at DESC`;

    const result = await pool.query(query, params);

    // Format the results as a GeoJSON FeatureCollection.
    // Leaflet's react-leaflet library expects this exact structure to render markers.
    const geojson = {
      type: 'FeatureCollection',
      features: result.rows.map(row => ({
        type: 'Feature',
        geometry: row.location,      // GeoJSON Point geometry with coordinates
        properties: {                // All non-spatial data goes in properties
          id: row.id,
          trail_name: row.trail_name,
          condition_type: row.condition_type,
          severity: row.severity,
          description: row.description,
          photo_url: row.photo_url,
          status: row.status,
          created_at: row.created_at,
          updated_at: row.updated_at,
        }
      }))
    };

    res.json(geojson);
  } catch (err) {
    console.error('GET /reports error:', err);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// ──────────────────────────────────────────
// READ — Get a single report by ID (public)
// GET /api/reports/:id
// Returns a single GeoJSON Feature object
// ──────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT
        id, trail_name, condition_type, severity,
        description, photo_url, status, user_id,
        created_at, updated_at,
        ST_AsGeoJSON(location)::json AS location
       FROM reports WHERE id = $1`,
      [id]
    );

    // Return 404 if no report exists with that UUID
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const row = result.rows[0];
    res.json({
      type: 'Feature',
      geometry: row.location,
      properties: {
        id: row.id,
        trail_name: row.trail_name,
        condition_type: row.condition_type,
        severity: row.severity,
        description: row.description,
        photo_url: row.photo_url,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }
    });
  } catch (err) {
    console.error('GET /reports/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch report' });
  }
});

// ──────────────────────────────────────────
// CREATE — Submit a new report (auth required)
// POST /api/reports
// Body: trail_name, condition_type, severity, description, lat, lng, photo_url
// ──────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const {
    trail_name,
    condition_type,
    severity,
    description,
    lat,
    lng,
    photo_url
  } = req.body;

  // Validate required fields before touching the database
  if (!trail_name || !condition_type || !severity || !lat || !lng) {
    return res.status(400).json({
      error: 'trail_name, condition_type, severity, lat, and lng are required'
    });
  }

  // Whitelist validation — reject any values not in these arrays.
  // These must match the values used in the front-end dropdowns and
  // the CHECK constraints defined in the database schema.
  const validTypes = ['ice_snow', 'flooding', 'blowdown', 'washout', 'closure', 'other'];
  const validSeverities = ['low', 'moderate', 'high'];

  if (!validTypes.includes(condition_type)) {
    return res.status(400).json({ error: 'Invalid condition_type' });
  }
  if (!validSeverities.includes(severity)) {
    return res.status(400).json({ error: 'Invalid severity' });
  }

  try {
    // The Cognito JWT sub (subject) is a unique identifier for the user.
    // It's extracted from the verified token payload by the auth middleware
    // and attached to req.user before this handler runs.
    const cognitoSub = req.user.sub;
    const email = req.user.email || req.user.username || cognitoSub;

    // Upsert the user record — creates a new row if this is the user's first
    // report, or does nothing if they already exist (ON CONFLICT DO NOTHING).
    // This avoids a foreign key violation on the reports.user_id column.
    await pool.query(
      `INSERT INTO users (cognito_sub, email, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (cognito_sub) DO NOTHING`,
      [cognitoSub, email, 'public']
    );

    // Fetch the internal UUID for this user — needed for the reports.user_id foreign key
    const userResult = await pool.query(
      'SELECT id FROM users WHERE cognito_sub = $1',
      [cognitoSub]
    );
    const userId = userResult.rows[0].id;

    // Insert the report with a spatial location value.
    // ST_GeogFromText converts a WKT POINT string into a PostGIS GEOGRAPHY value.
    // Note: PostGIS uses (longitude, latitude) order — the opposite of Leaflet's (lat, lng).
    // RETURNING lets us send the created record back in the response without a second query.
    const result = await pool.query(
      `INSERT INTO reports
        (trail_name, condition_type, severity, description, location, photo_url, user_id)
       VALUES
        ($1, $2, $3, $4,
         ST_GeogFromText('POINT(' || $5 || ' ' || $6 || ')'),
         $7, $8)
       RETURNING id, trail_name, condition_type, severity, status, created_at`,
      [
        trail_name,
        condition_type,
        severity,
        description || null,
        lng,          // Longitude first — PostGIS POINT format is (lng lat)
        lat,
        photo_url || null,
        userId
      ]
    );

    // 201 Created is the correct status code for a successful resource creation
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /reports error:', err);
    res.status(500).json({ error: 'Failed to create report' });
  }
});

// ──────────────────────────────────────────
// UPDATE — Edit an existing report (auth required)
// PUT /api/reports/:id
// Body: severity, description, status (all optional — only provided fields update)
// ──────────────────────────────────────────
router.put('/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { severity, description, status } = req.body;

  try {
    // Fetch the existing report to check who owns it before allowing changes
    const existing = await pool.query(
      'SELECT user_id FROM reports WHERE id = $1',
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // Look up the requesting user's internal UUID using their Cognito sub.
    // This is needed because reports.user_id stores the internal UUID,
    // not the Cognito sub directly.
    const userResult = await pool.query(
      'SELECT id FROM users WHERE cognito_sub = $1',
      [req.user.sub]
    );
    const userId = userResult.rows.length > 0 ? userResult.rows[0].id : null;

    // Allow edits if the user owns the report or has the land_manager role.
    // custom:role is a custom attribute stored in the Cognito JWT payload.
    const isOwner = existing.rows[0].user_id === userId;
    const isLandManager = req.user['custom:role'] === 'land_manager';

    if (!isOwner && !isLandManager) {
      return res.status(403).json({ error: 'You do not have permission to edit this report' });
    }

    // COALESCE returns the first non-null value.
    // Passing null for an unchanged field means the existing value is kept,
    // so partial updates work without needing to send all fields every time.
    const result = await pool.query(
      `UPDATE reports
       SET
         severity    = COALESCE($1, severity),
         description = COALESCE($2, description),
         status      = COALESCE($3, status),
         updated_at  = NOW()
       WHERE id = $4
       RETURNING id, trail_name, condition_type, severity, status, updated_at`,
      [severity || null, description || null, status || null, id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /reports/:id error:', err);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

// ──────────────────────────────────────────
// DELETE — Remove or resolve a report (auth required)
// DELETE /api/reports/:id
// Land managers: permanently delete the record
// Regular users: soft delete (set status to 'resolved', record stays in DB)
// ──────────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  const { id } = req.params;

  try {
    // Fetch the report to verify it exists and check ownership
    const existing = await pool.query(
      'SELECT user_id FROM reports WHERE id = $1',
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // Same ownership check pattern as the PUT route —
    // look up internal UUID from Cognito sub, then compare to report owner
    const userResult = await pool.query(
      'SELECT id FROM users WHERE cognito_sub = $1',
      [req.user.sub]
    );
    const userId = userResult.rows.length > 0 ? userResult.rows[0].id : null;
    const isOwner = existing.rows[0].user_id === userId;
    const isLandManager = req.user['custom:role'] === 'land_manager';

    if (!isOwner && !isLandManager) {
      return res.status(403).json({
        error: 'You do not have permission to delete this report'
      });
    }

    if (isLandManager) {
      // Hard delete — permanently removes the row from the database.
      // Only land managers have this permission, giving them full
      // control over report data for their managed trail areas.
      await pool.query('DELETE FROM reports WHERE id = $1', [id]);
      res.json({ message: 'Report permanently deleted' });
    } else {
      // Soft delete — marks the report as resolved without removing the row.
      // Keeps historical data intact and allows the report to be
      // excluded from active map views by filtering on status = 'active'.
      await pool.query(
        `UPDATE reports SET status = 'resolved', updated_at = NOW() WHERE id = $1`,
        [id]
      );
      res.json({ message: 'Report marked as resolved' });
    }
  } catch (err) {
    console.error('DELETE /reports/:id error:', err);
    res.status(500).json({ error: 'Failed to delete report' });
  }
});

module.exports = router;
