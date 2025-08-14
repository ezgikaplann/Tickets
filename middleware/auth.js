// middleware/auth.js
const jwt = require('jsonwebtoken');

function auth(requiredRoles = []) {
  return (req, res, next) => {
    const token = req.cookies?.auth || req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      req.user = payload; // { id, role, email }
      if (requiredRoles.length && !requiredRoles.includes(payload.role)) {
        return res.status(403).json({ error: 'forbidden' });
      }
      next();
    } catch {
      res.status(401).json({ error: 'invalid_token' });
    }
  };
}

module.exports = auth;
