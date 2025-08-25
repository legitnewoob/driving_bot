/**
 * Authentication middleware for protecting routes
 */

/**
 * Basic HTTP authentication middleware
 * Prompts for username/password and validates credentials
 */
const basicAuth = (req, res, next) => {
  // Get auth header value
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    // No authorization header
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Access"');
    return res.status(401).send('Authentication required');
  }
  
  // Check if it's Basic auth
  if (!authHeader.startsWith('Basic ')) {
    return res.status(401).send('Authentication method not supported');
  }
  
  // Get credentials (decode from base64)
  const base64Credentials = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
  const [username, password] = credentials.split(':');
  
  // Check credentials (replace these with environment variables in production)
  const validUsername = process.env.ADMIN_USERNAME || 'admin';
  const validPassword = process.env.ADMIN_PASSWORD || 'admin';
  
  if (username === validUsername && password === validPassword) {
    next(); // Credentials are valid, proceed to the route
  } else {
    // Credentials are invalid
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Access"');
    return res.status(401).send('Invalid credentials');
  }
};

module.exports = { basicAuth };