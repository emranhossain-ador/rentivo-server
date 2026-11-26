import { ObjectId } from "mongodb";

/**
 * Auth middleware factory.
 *
 * The frontend sends the better-auth session token as:
 *    Authorization: Bearer <session.token>
 *
 * We validate that token against the `session` collection (better-auth stores
 * it in plain text) and attach the logged in user to `req.user`, so route
 * handlers never trust ids coming from the request body/params.
 *
 * Usage:
 *   const { tokenVerify, verifyAdmin, verifyOwner, verifyCustomer } =
 *       createAuthMiddleware(db);
 *
 *   app.get("/users", tokenVerify, verifyAdmin, handler);
 */
export function createAuthMiddleware(db) {
  const sessionsCollection = db.collection("session");
  const usersCollection = db.collection("user");

  // Read the raw token from "Authorization: Bearer <token>"
  function extractToken(req) {
    const authHeader = req.headers.authorization || req.headers.Authorization;

    if (typeof authHeader !== "string") return null;

    const [scheme, ...parts] = authHeader.trim().split(/\s+/);

    if (!scheme || scheme.toLowerCase() !== "bearer") return null;

    return parts.join(" ") || null;
  }

  // better-auth ids can be stored as ObjectId or string depending on the
  // adapter/id generator, so look the user up both ways.
  async function findUserById(userId) {
    if (userId === null || userId === undefined || userId === "") return null;

    const queries = [{ _id: userId }];

    if (typeof userId === "string") {
      try {
        if (ObjectId.isValid(userId)) queries.unshift({ _id: new ObjectId(userId) });
      } catch {
        // not a valid ObjectId string — keep the plain string query only
      }
    } else if (userId instanceof ObjectId) {
      queries.unshift({ _id: userId.toHexString() });
    }

    return usersCollection.findOne({ $or: queries });
  }

  // Verifies the session token and loads the user onto req.user
  async function tokenVerify(req, res, next) {
    try {
      const token = extractToken(req);

      if (!token) {
        return res.status(401).send({
          success: false,
          message: "Unauthorized! Access token is missing.",
        });
      }

      const session = await sessionsCollection.findOne({ token });

      if (!session) {
        return res.status(401).send({
          success: false,
          message: "Unauthorized! Invalid or expired token.",
        });
      }

      const expiresAt = new Date(session.expiresAt).getTime();

      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return res.status(401).send({
          success: false,
          message: "Unauthorized! Session expired, please sign in again.",
        });
      }

      const user = await findUserById(session.userId);

      if (!user) {
        return res.status(401).send({
          success: false,
          message: "Unauthorized! User not found.",
        });
      }

      req.user = user;
      req.authSession = session;

      return next();
    } catch (error) {
      console.error("Token verification error:", error);

      return res.status(500).send({
        success: false,
        message: "Failed to verify access token.",
      });
    }
  }

  // Role guard — must run after tokenVerify
  function verifyRole(...roles) {
    return (req, res, next) => {
      if (!req.user) {
        return res.status(401).send({
          success: false,
          message: "Unauthorized! Access token is missing.",
        });
      }

      if (!roles.includes(req.user.role)) {
        return res.status(403).send({
          success: false,
          message: `Forbidden! ${roles.join(" or ")} access required.`,
        });
      }

      return next();
    };
  }

  const verifyAdmin = verifyRole("admin");
  const verifyOwner = verifyRole("owner");
  const verifyCustomer = verifyRole("customer");
  const verifyOwnerOrAdmin = verifyRole("owner", "admin");

  return {
    extractToken,
    findUserById,
    tokenVerify,
    verifyRole,
    verifyAdmin,
    verifyOwner,
    verifyCustomer,
    verifyOwnerOrAdmin,
  };
}
