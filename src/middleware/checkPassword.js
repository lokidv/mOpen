module.exports = function checkPassword(req, res, next) {
  const providedPassword = req.header("x-api-password");
  const requiredPassword = process.env.API_PASSWORD;

  if (!providedPassword || providedPassword !== requiredPassword) {
    return res.status(403).json({ error: "Forbidden: Invalid password" });
  }

  next();
};
