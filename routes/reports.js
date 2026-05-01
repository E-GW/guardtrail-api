const express = require('express');
const router = express.Router();
const pool = require('../db');
const auth = require('../middleware/auth');

// ──────────────────────────────────────────
// READ — Get all reports (public, no auth)
// GET /api/reports
// Optional query params: status, type, severity
// ──────────────────────────────────────────
router.get('/', async (req, res) => {
  const { status = 'active', type, severity } = req.query;

  try {
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

    const params = [status];

    if (type) {
      params.push(type);
      query += ` AND condition_type = $${params.length}`;
    }

    if (severity) {
      params.push(severity);
      query += ` AND severity = $${params.length}`;
    }

    query += ` ORDER BY created_at DESC`;

    const result = await pool.query(query, params);

    // Return as GeoJSON FeatureCollection for Leaflet
    const geojson = {
      type: 'FeatureCollection',
      features: result.rows.map(row => ({
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
 
  if (!trail_name || !condition_type || !severity || !lat || !lng) {
    return res.status(400).json({
      error: 'trail_name, condition_type, severity, lat, and lng are required'
    });
  }

  const validTypes = ['ice_snow', 'flooding', 'blowdown', 'washout', 'closure', 'other'];
  const validSeverities = ['low', 'moderate', 'high'];

  if (!validTypes.includes(condition_type)) {
    return res.status(400).json({ error: 'Invalid condition_type' });
  }
  if (!validSeverities.includes(severity)) {
    return res.status(400).json({ error: 'Invalid severity' });
  }

  try {
    // Auto-create the user row if it doesn't exist yet
    // This handles the first time a Cognito user submits a report
    const cognitoSub = req.user.sub;
    const email = req.user.email || req.user.username || cognitoSub;

    await pool.query(
      `INSERT INTO users (cognito_sub, email, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (cognito_sub) DO NOTHING`,
      [cognitoSub, email, 'public']
    );

    // Get the internal user ID
    const userResult = await pool.query(
      'SELECT id FROM users WHERE cognito_sub = $1',
      [cognitoSub]
    );
    const userId = userResult.rows[0].id;

    // Insert the report
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
        lng,
        lat,
        photo_url || null,
        userId
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /reports error:', err);
    res.status(500).json({ error: 'Failed to create report' });
  }
});

// ──────────────────────────────────────────
// UPDATE — Edit an existing report (auth required)
// PUT /api/reports/:id
// ──────────────────────────────────────────
router.put('/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { severity, description, status } = req.body;

  try {
    // Fetch the report first to check ownership
    const existing = await pool.query(
      'SELECT user_id FROM reports WHERE id = $1',
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // In PUT route — replace the ownership check with:
    const userResult = await pool.query(
      'SELECT id FROM users WHERE cognito_sub = $1',
      [req.user.sub]
    );
    const userId = userResult.rows.length > 0 ? userResult.rows[0].id : null;
    const isOwner = existing.rows[0].user_id === userId;
    const isLandManager = req.user['custom:role'] === 'land_manager';

    if (!isOwner && !isLandManager) {
      return res.status(403).json({ error: 'You do not have permission to edit this report' });
    }

    const result = await pool.query(
      `UPDATE reports
       SET
         severity = COALESCE($1, severity),
         description = COALESCE($2, description),
         status = COALESCE($3, status),
         updated_at = NOW()
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
// ──────────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  const { id } = req.params;

  try {
    // Fetch the report to check ownership
    const existing = await pool.query(
      'SELECT user_id FROM reports WHERE id = $1',
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // In PUT route — replace the ownership check with:
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
      // Land managers can hard delete
      await pool.query('DELETE FROM reports WHERE id = $1', [id]);
      res.json({ message: 'Report permanently deleted' });
    } else {
      // Regular users soft delete by resolving
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
