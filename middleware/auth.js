// auth.js
// Express middleware that validates Cognito JWT access tokens on protected routes.
// Any route that requires authentication imports and uses this middleware.
// If the token is missing, invalid, or expired, the request is rejected
// with a 401 Unauthorized response before it reaches the route handler.

const { CognitoJwtVerifier } = require('aws-jwt-verify');
require('dotenv').config();

// Create a verifier instance configured for this app's Cognito User Pool.
// The verifier caches Cognito's public keys (JWKS) so it doesn't need to
// fetch them on every request — only on the first verification or key rotation.
// tokenUse: 'access' means only access tokens are accepted, not ID tokens.
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_POOL_ID,
  tokenUse: 'access',
  clientId: process.env.COGNITO_CLIENT_ID,
});

// Export as a standard Express middleware function.
// Usage in routes: router.post('/', auth, async (req, res) => { ... })
module.exports = async (req, res, next) => {

  // JWT tokens are sent in the Authorization header using the Bearer scheme:
  // Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
  const authHeader = req.headers.authorization;

  // Reject requests with no Authorization header or wrong format
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  // Extract just the token string after "Bearer "
  const token = authHeader.split(' ')[1];

  try {
    // Verify the token's signature against Cognito's public keys,
    // check it hasn't expired, and confirm it belongs to this User Pool.
    // Returns the decoded token payload containing user claims like sub, email,
    // and custom attributes such as custom:role.
    const payload = await verifier.verify(token);

    // Attach the decoded payload to req.user so route handlers can access
    // user identity (req.user.sub) and role (req.user['custom:role'])
    req.user = payload;

    // Pass control to the next middleware or route handler
    next();
  } catch (err) {
    // Verification fails if the token is expired, tampered with, or
    // was issued by a different User Pool
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
