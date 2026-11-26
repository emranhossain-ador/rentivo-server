import express from "express";
import cors from "cors";
const app = express();

import { MongoClient, ObjectId } from 'mongodb';
import { createAuthMiddleware } from './middleware/auth.js';

import 'dotenv/config'
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PORT = process.env.PORT || 5001;

// Stripe Webhook — MUST be before express.json()
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    console.log("🔥 WEBHOOK REQUEST RECEIVED!");

    const signature = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error(" Webhook Signature Error:", error.message);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    console.log("✅ Stripe Event:", event.type);

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        console.log("Session ID:", session.id);
        console.log("Payment Status:", session.payment_status);
        console.log("Booking ID:", session.metadata?.bookingId);

        const result = await confirmPaidCheckout(session);
        console.log("Checkout confirmation result:", result);
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error(" Webhook Processing Error:", error);
      return res.sendStatus(500);
    }
  }
);


// Adds headers: Access-Control-Allow-Origin: *
app.use(cors());
app.use(express.json());


// Database connection
const client = new MongoClient(process.env.MONGO_DB_URL);
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connetClient = await connectToMongoDB();
const db = connetClient.db('rentivodb');
const users = db.collection('user');
const equipmentsCollection = db.collection('equipments');
const categoriesCollection = db.collection('categories');
const favoritesCollection = db.collection("favorites");
const bookingsCollection = db.collection("bookings");
const paymentsCollection = db.collection("payments");

// Create unique index
await favoritesCollection.createIndex(
  { userId: 1, equipmentId: 1 },
  { unique: true }
);
await paymentsCollection.createIndex(
  { stripeSessionId: 1 },
  { unique: true }
);


// ---------------------- Auth middleware ----------------------
const {
  tokenVerify,
  verifyRole,
  verifyAdmin,
  verifyOwner,
  verifyCustomer,
  verifyOwnerOrAdmin,
} = createAuthMiddleware(db);

// Only the owner of the equipment (or an admin) may change it
async function verifyEquipmentOwner(req, res, next) {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    const equipment = await equipmentsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!equipment) {
      return res.status(404).send({
        success: false,
        message: "Equipment not found",
      });
    }

    const isOwner = String(equipment.ownerId) === String(req.user._id);
    const isAdmin = req.user.role === "admin";

    if (!isOwner && !isAdmin) {
      return res.status(403).send({
        success: false,
        message: "Forbidden! You don't own this equipment.",
      });
    }

    req.equipment = equipment;
    return next();
  } catch (error) {
    console.error("Equipment owner verification error:", error);

    return res.status(500).send({
      success: false,
      message: "Failed to verify equipment owner.",
    });
  }
}

// The logged in user can only act on their own :param (admins can do anything)
function verifySelf(param = "userId") {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).send({
        success: false,
        message: "Unauthorized! Access token is missing.",
      });
    }

    const requestedId = req.params[param];

    if (
      requestedId !== undefined &&
      String(requestedId) !== String(req.user._id) &&
      req.user.role !== "admin"
    ) {
      return res.status(403).send({
        success: false,
        message: "Forbidden! You can only access your own account data.",
      });
    }

    return next();
  };
}


// Confirm a paid Stripe checkout: record the payment + confirm the booking.
// Safe to call multiple times (webhook retries + success-page verification).
async function confirmPaidCheckout(session) {
  if (!session || session.payment_status !== "paid") {
    return { confirmed: false, reason: "Payment not completed" };
  }

  const stripeSessionId = session.id;
  const bookingId = session.metadata?.bookingId;

  if (!bookingId || !ObjectId.isValid(bookingId)) {
    console.error("❌ Missing/invalid bookingId in session metadata:", stripeSessionId);
    return { confirmed: false, reason: "Missing booking id" };
  }

  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id || null;

  // 1. Insert payment record (unique index on stripeSessionId keeps retries safe)
  try {
    await paymentsCollection.insertOne({
      stripeSessionId,
      paymentIntentId,
      bookingId,
      userId: session.metadata?.userId || null,
      equipmentId: session.metadata?.equipmentId || null,
      amount: session.amount_total, // smallest currency unit (poisha for BDT)
      currency: session.currency,
      status: session.payment_status,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (error) {
    if (error.code !== 11000) throw error; // 11000 = already recorded, continue
  }

  // 2. Update booking status
  const result = await bookingsCollection.updateOne(
    { _id: new ObjectId(bookingId) },
    {
      $set: {
        status: "confirmed",
        paymentStatus: "paid",
        stripeSessionId,
        paymentIntentId,
        amountPaid: session.amount_total,
        currency: session.currency,
        paidAt: new Date(),
        updatedAt: new Date(),
      },
    }
  );

  if (result.matchedCount === 0) {
    console.error("❌ Booking not found for session:", stripeSessionId, bookingId);
    return { confirmed: false, reason: "Booking not found" };
  }

  return { confirmed: true, bookingId };
}



app.get('/', (req, res)=>{
    res.send("Welcome to the Rentivo server");
});

// Public stats for the homepage (counts only, no private user data)
// http://localhost:5001/users/summary
app.get('/users/summary', async (req, res) => {
    try {
        const [total, owners, customers, ownerAvatars] = await Promise.all([
            users.countDocuments(),
            users.countDocuments({ role: "owner" }),
            users.countDocuments({ role: "customer" }),
            users
                .find(
                    { role: "owner" },
                    { projection: { _id: 1, name: 1, image: 1, role: 1 } }
                )
                .limit(5)
                .toArray(),
        ]);

        res.send({
            success: true,
            data: { total, owners, customers, ownerAvatars },
        });

    } catch (error) {
        console.error("Get user summary error:", error);

        res.status(500).send({
            success: false,
            message: "Failed to fetch user summary",
        });
    }
});


// Get All users Api http://localhost:5001/users  (admin only)
app.get('/users', tokenVerify, verifyAdmin, async (req, res) => {
    try {
        const { search, role } = req.query;

        const query = {};

        // Filter by role
        if (role && role !== "all") {
            query.role = role;
        }

        const result = await users.find(query).toArray();

        res.send(result);

    } catch (error) {
        res.status(500).send({
            success: false,
            message: "Failed to fetch users",
        });
    }
});

// User Update Api http://localhost:5001/user/:Id/role  (admin only)
app.patch('/user/:Id/role', tokenVerify, verifyAdmin, async (req, res) => {
    try {
        const { Id } = req.params;
        const { role } = req.body;

        if (!ObjectId.isValid(Id)) {
            return res.status(400).send({
                success: false,
                message: "Invalid ID!",
            });
        }

        const allowedRoles = ["admin", "owner", "customer"];

        if (!allowedRoles.includes(role)) {
            return res.status(400).send({
                success: false,
                message: "Invalid role!",
            });
        }

        const query = { _id: new ObjectId(Id) };

        const updateDoc = {
            $set: {
                role: role,
            },
        };

        const result = await users.updateOne(query, updateDoc);

        if (result.matchedCount === 0) {
            return res.status(404).send({
                success: false,
                message: "User not found!",
            });
        }

        res.send({
            success: true,
            message: "User role updated successfully!",
            result,
        });

    } catch (error) {
        res.status(500).send({
            success: false,
            message: "Internal server error!",
        });
    }
});


app.get('/categoris', async(req, res)=>{
  const result = await categoriesCollection.find().toArray();
  res.send(result);
})


//----------------- Equipments Api Start ----------------------

// Create Equipment api http://localhost:5001/equipment  (owner only)
app.post("/equipment", tokenVerify, verifyOwner, async (req, res) => {
  try {
    const equipmentData = {
      ...req.body,
      // Owner always comes from the logged in user, never from the request body
      ownerId: String(req.user._id),
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await equipmentsCollection.insertOne(equipmentData);

    res.status(201).send({
      success: true,
      message: "Equipment added successfully!",
      data: result,
    });
  } catch (error) {
    console.error("Add Equipment Error:", error);

    res.status(500).send({
      success: false,
      message: error instanceof Error
        ? error.message
        : "Failed to add equipment!",
    });
  }
});


// Get Single equipment by Id
app.get("/equipment/:id", tokenVerify, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    const result = await equipmentsCollection.aggregate([
      {
        $match: {
          _id: new ObjectId(id),
        },
      },
      {
        $addFields: {
          ownerObjectId: {
            $convert: {
              input: "$ownerId",
              to: "objectId",
              onError: null,
              onNull: null,
            },
          },
        },
      },
      {
        $lookup: {
          from: "user",
          localField: "ownerObjectId",
          foreignField: "_id",
          as: "owner",
        },
      },
      {
        $unwind: {
          path: "$owner",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          ownerObjectId: 0,

          // Only expose public owner information
          "owner.password": 0,
          "owner.__v": 0,
        },
      },
    ]).toArray();

    if (!result.length) {
      return res.status(404).send({
        success: false,
        message: "Equipment not found",
      });
    }

    res.status(200).send({
      success: true,
      data: result[0],
    });

  } catch (error) {
    console.error("Get equipment error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch equipment",
    });
  }
});


// Equipment Update Api  (owner of the equipment or admin)
app.patch("/equipment/:id", tokenVerify, verifyEquipmentOwner, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    const {
      equipmentName,
      description,
      categoryName,
      categorySlug,
      location,
      rentalPrice,
      rentalType,
      quantity,
      condition,
      brand,
      model,
      images,
      terms,
    } = req.body;

    // Only allow editable fields
    const updateData = {
      equipmentName,
      description,
      categoryName,
      categorySlug,
      location,
      rentalPrice,
      rentalType,
      quantity,
      condition,
      brand,
      model,
      images,
      terms,
      updatedAt: new Date(),
    };

    const result = await equipmentsCollection.updateOne(
      {
        _id: new ObjectId(id)
      },
      {
        $set: updateData,
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        success: false,
        message: "Equipment not found or access denied",
      });
    }

    res.send({
      success: true,
      message: "Equipment updated successfully!",
    });
  } catch (error) {
    console.error("Update Equipment Error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to update equipment",
    });
  }
});

// Equipment Delete api  (owner of the equipment or admin)
app.delete("/equipment/:id", tokenVerify, verifyEquipmentOwner, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).send({
                success: false,
                message: "Invalid equipment ID",
            });
        }

        const result = await equipmentsCollection.deleteOne({
            _id: new ObjectId(id),
        });

        if (result.deletedCount === 0) {
            return res.status(404).send({
                success: false,
                message: "Equipment not found",
            });
        }

        res.status(200).send({
            success: true,
            message: "Equipment deleted successfully!",
        });
    } catch (error) {
        console.error("Delete equipment error:", error);

        res.status(500).send({
            success: false,
            message: "Failed to delete equipment",
        });
    }
 });


// Get Equipments by Owner Id  (only the owner themselves, or an admin)
app.get("/equipment/owner/:ownerId", tokenVerify, verifySelf("ownerId"), async (req, res) => {
  try {
    const { ownerId } = req.params;

    if (!ownerId) {
      return res.status(400).send({
        success: false,
        message: "User ID is required",
      });
    }

    const result = await equipmentsCollection
        .find({ ownerId: ownerId })
        .sort({ createdAt: -1 })
        .toArray();

    res.status(200).send({
      success: true,
      message: "User equipment fetched successfully",
      data: result,
    });
  } catch (error) {
    console.error("Get User Equipment Error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch user equipment",
    });
  }
});


//Get All Equipments
app.get("/equipments", async (req, res) => {
  try {
    const { category, status, sortBy } = req.query;

    // Build filter
    const filter = {};

    if (category && category !== "all") {
      filter.categoryName = category;
    }

    if (status && status !== "all") {
      filter.status = status;
    }

    // Sorting options
    const sortOptions = {
      newest: { createdAt: -1 },
      oldest: { createdAt: 1 },
      first: { _id: 1 },
      "price:low-high": { rentalPrice: 1 },
      "price:high-low": { rentalPrice: -1 },
    };

    const sort = sortOptions[sortBy] || { createdAt: -1 };

    
    const result = await equipmentsCollection.aggregate([
      {
        $match: filter,
      },
      {
        $sort: sort,
      },
      {
        $addFields: {
          ownerObjectId: {
            $toObjectId: "$ownerId",
          },
        },
      },
      {
        $lookup: {
          from: "user",
          localField: "ownerObjectId",
          foreignField: "_id",
          as: "owner",
        },
      },
      {
        $unwind: {
          path: "$owner",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          ownerObjectId: 0,
          "owner.password": 0,
          "owner.__v": 0,
        },
      },
    ]).toArray();


    res.status(200).send({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Get equipments error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch equipments",
    });
  }
});


// Status update api  (admin only)
app.patch("/equipment/:id/status", tokenVerify, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // Validate equipment ID
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    // Allowed statuses
    const allowedStatuses = [
      "pending",
      "approved",
      "rejected",
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).send({
        success: false,
        message: "Invalid equipment status",
      });
    }

    // Update equipment status
    const result = await equipmentsCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status,
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        success: false,
        message: "Equipment not found",
      });
    }

    res.status(200).send({
      success: true,
      message: "Equipment status updated successfully!",
    });

  } catch (error) {
    console.error("Update equipment status error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to update equipment status",
    });
  }
});


app.get("/equipments/latest-approved", async (req, res) => {
  try {
    const result = await equipmentsCollection
      .find({ status: "approved" })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

    res.status(200).send({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to fetch latest approved equipment",
    });
  }
});

app.get("/approved-equipments", async (req, res) => {
  try {
    const {
      search,
      category,
      rentalType,
      minPrice,
      maxPrice,
      availability,
      sortBy = "recent",
    } = req.query;

    // Filter
    const filter = {
      status: "approved",
    };

    // Search by equipment name and location
    if (search && typeof search === "string") {
      const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      filter.$or = [
        { equipmentName: { $regex: escapedSearch, $options: "i" } },
        { location: { $regex: escapedSearch, $options: "i" } },
      ];
    }

    // Category Filter
    if (category && category !== "all") {
      filter.categorySlug = category;
    }

    // Rental Type Filter
    if (rentalType && rentalType !== "all") {
      filter.rentalType = rentalType;
    }

    // Price Range Filter
    if (minPrice !== undefined || maxPrice !== undefined) {
      filter.rentalPrice = {};

      if (minPrice !== undefined && minPrice !== "") {
        filter.rentalPrice.$gte = Number(minPrice);
      }

      if (maxPrice !== undefined && maxPrice !== "") {
        filter.rentalPrice.$lte = Number(maxPrice);
      }
    }

    // Availability Filter
    if (availability === "available") {
      filter.quantity = { $gt: 0 };
    } else if (availability === "unavailable") {
      filter.quantity = { $lte: 0 };
    }

    // Sorting
    const sortOptions = {
      "price-low-high": { rentalPrice: 1 },
      "price-high-low": { rentalPrice: -1 },
      recent: { createdAt: -1 },
    };

    const sort = sortOptions[sortBy] || sortOptions.recent;

    // Aggregation
    const result = await equipmentsCollection.aggregate([
      { $match: filter },

      { $sort: sort },

      {
        $addFields: {
          ownerObjectId: {
            $convert: {
              input: "$ownerId",
              to: "objectId",
              onError: null,
              onNull: null,
            },
          },
        },
      },

      {
        $lookup: {
          from: "user",
          localField: "ownerObjectId",
          foreignField: "_id",
          as: "owner",
        },
      },

      {
        $unwind: {
          path: "$owner",
          preserveNullAndEmptyArrays: true,
        },
      },

      {
        $project: {
          ownerObjectId: 0,
          "owner.password": 0,
          "owner.__v": 0,
        },
      },
    ]).toArray();

    res.status(200).send({
      success: true,
      total: result.length,
      data: result,
    });

  } catch (error) {
    console.error("Approved equipment error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch approved equipment",
    });
  }
});


// Add favorites  (any signed in user — the userId always comes from the token)
app.post("/favorites", tokenVerify, async (req, res) => {
  try {
    const { equipmentId } = req.body;
    const userId = String(req.user._id);

    if (!ObjectId.isValid(equipmentId)) {
      return res.status(400).send({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    const equipment = await equipmentsCollection.findOne({
      _id: new ObjectId(equipmentId),
      status: "approved",
    });

    if (!equipment) {
      return res.status(404).send({
        success: false,
        message: "Equipment not found",
      });
    }

    await favoritesCollection.insertOne({
      userId,
      equipmentId: new ObjectId(equipmentId),
      createdAt: new Date(),
    });

    res.status(201).send({
      success: true,
      message: "Added to favorites",
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).send({
        success: false,
        message: "Already added to favorites",
      });
    }

    console.error(error);
    res.status(500).send({
      success: false,
      message: "Failed to add favorite",
    });
  }
});



app.get("/favorites/:equipmentId/:userId", tokenVerify, verifySelf(), async (req, res) => {
  try {
    const { equipmentId, userId } = req.params;

    if (!ObjectId.isValid(equipmentId)) {
      return res.status(400).send({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    const favorite = await favoritesCollection.findOne({
      userId,
      equipmentId: new ObjectId(equipmentId),
    });

    res.status(200).send({
      success: true,
      isFavorite: !!favorite,
    });

  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to check favorite",
    });
  }
});



app.get("/favorites/:userId", tokenVerify, verifySelf(), async (req, res) => {
    try {
        const { userId } = req.params;

        const result = await favoritesCollection.aggregate([
            {
                $match: { userId },
            },
            {
                $sort: { createdAt: -1 },
            },
            {
                $lookup: {
                    from: "equipments",
                    localField: "equipmentId",
                    foreignField: "_id",
                    as: "equipment",
                },
            },
            {
                $unwind: "$equipment",
            },
        ]).toArray();

        res.status(200).send({
            success: true,
            total: result.length,
            data: result,
        });

    } catch (error) {
        console.error("Get favorites error:", error);

        res.status(500).send({
            success: false,
            message: "Failed to fetch favorites",
        });
    }
});


app.delete("/favorites/:favoriteId/:userId", tokenVerify, verifySelf(), async (req, res) => {
    try {
        const { favoriteId, userId } = req.params;


        // Validate equipment ID only
        if (!ObjectId.isValid(favoriteId)) {
            return res.status(400).send({
                success: false,
                message: "Invalid equipment ID",
            });
        }

        const result = await favoritesCollection.deleteOne({
            userId,
            _id: new ObjectId(favoriteId),
        });

        if (result.deletedCount === 0) {
            return res.status(404).send({
                success: false,
                message: "Favorite not found",
            });
        }

        res.status(200).send({
            success: true,
            message: "Removed from favorites successfully",
        });

    } catch (error) {
        console.error("Remove favorite error:", error);

        res.status(500).send({
            success: false,
            message: "Failed to remove favorite",
        });
    }
});


//----------------- Equipments Api End ------------------------


//----------------- Booking Api Start ------------------------

app.post("/create-checkout-session", tokenVerify, async (req, res) => {
  let bookingId;

  try {
    const {
      equipmentId,
      startDate,
      endDate,
      quantity,
      contactNumber,
      deliveryAddress,
      notes,
    } = req.body;

    // The booking always belongs to the signed in user (never the request body)
    const userId = String(req.user._id);

    // 1. Validate input
    if (
      !ObjectId.isValid(equipmentId) ||
      !startDate ||
      !endDate ||
      !contactNumber?.trim() ||
      !deliveryAddress?.trim()
    ) {
      return res.status(400).send({
        success: false,
        message: "Required booking information is missing",
      });
    }

    const requestedQuantity = Number(quantity);

    if (
      !Number.isInteger(requestedQuantity) ||
      requestedQuantity < 1
    ) {
      return res.status(400).send({
        success: false,
        message: "Invalid quantity",
      });
    }

    // 2. Validate dates
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);

    const rentalDays = Math.round(
      (end.getTime() - start.getTime()) / 86400000
    );

    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      rentalDays <= 0 ||
      startDate !== start.toISOString().slice(0, 10) ||
      endDate !== end.toISOString().slice(0, 10)
    ) {
      return res.status(400).send({
        success: false,
        message: "Invalid rental dates",
      });
    }

    // 3. Get equipment from database
    const equipment = await equipmentsCollection.findOne({
      _id: new ObjectId(equipmentId),
      status: "approved",
    });

    if (!equipment) {
      return res.status(404).send({
        success: false,
        message: "Equipment not found",
      });
    }

    // 4. Calculate rental amount on backend
    const price = Number(equipment.rentalPrice);

    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).send({
        success: false,
        message: "Invalid equipment price",
      });
    }

    let rentalPeriods = rentalDays;

    if (equipment.rentalType === "weekly") {
      rentalPeriods = Math.ceil(rentalDays / 7);
    } else if (equipment.rentalType === "monthly") {
      rentalPeriods = Math.ceil(rentalDays / 30);
    } else if (equipment.rentalType !== "daily") {
      return res.status(400).send({
        success: false,
        message: "Invalid rental type",
      });
    }

    const totalAmount =
      price * rentalPeriods * requestedQuantity;

    if (!Number.isSafeInteger(totalAmount)) {
      return res.status(400).send({
        success: false,
        message: "Invalid total amount",
      });
    }

    // 5. Check overlapping paid bookings
    const existingBookings = await bookingsCollection.find({
      equipmentId,
      status: "confirmed",
      paymentStatus: "paid",
      startDate: { $lt: endDate },
      endDate: { $gt: startDate },
    }).toArray();

    // Check availability for each rental day.
    for (
      let day = start.getTime();
      day < end.getTime();
      day += 86400000
    ) {
      const dayKey = new Date(day)
        .toISOString()
        .slice(0, 10);

      const alreadyBooked = existingBookings
        .filter(
          (booking) =>
            dayKey >= booking.startDate &&
            dayKey < booking.endDate
        )
        .reduce(
          (total, booking) =>
            total + Number(booking.quantity || 0),
          0
        );

      if (
        alreadyBooked + requestedQuantity >
        Number(equipment.quantity)
      ) {
        return res.status(409).send({
          success: false,
          message: `Not enough equipment available on ${dayKey}`,
        });
      }
    }

    // 6. Create pending booking
    const bookingData = {
      equipmentId,
      userId,
      equipmentName: equipment.equipmentName,
      rentalPrice: price,
      rentalType: equipment.rentalType,
      startDate,
      endDate,
      rentalDays,
      quantity: requestedQuantity,
      contactNumber: contactNumber.trim(),
      deliveryAddress: deliveryAddress.trim(),
      notes: notes?.trim() || "",
      totalAmount,
      status: "pending",
      paymentStatus: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const bookingResult = await bookingsCollection.insertOne(
      bookingData
    );

    bookingId = bookingResult.insertedId;

    // 7. Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: "payment",

      allowed_payment_method_types: ["card"],

      line_items: [
        {
          price_data: {
            currency: "bdt",
            product_data: {
              name: equipment.equipmentName,
            },
            unit_amount: Math.round(totalAmount * 100),
          },
          quantity: 1,
        },
      ],

      metadata: {
        bookingId: bookingResult.insertedId.toString(),
        userId,
        equipmentId,
      },

      success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,

      cancel_url: `${process.env.CLIENT_URL}/payment/cancel?bookingId=${bookingResult.insertedId}`,
    });

    // 8. Save Stripe session ID
    await bookingsCollection.updateOne(
      { _id: bookingId },
      {
        $set: {
          stripeSessionId: session.id,
          updatedAt: new Date(),
        },
      }
    );

    // 9. Send payment URL to frontend
    return res.status(201).send({
      success: true,
      message: "Checkout session created",
      paymentUrl: session.url,
      bookingId: bookingId.toString(),
    });

  } catch (error) {
    console.error("Checkout session error:", error);

    // Remove pending booking if checkout creation fails
    if (bookingId) {
      await bookingsCollection.deleteOne({
        _id: bookingId,
        paymentStatus: "pending",
      }).catch(console.error);
    }

    return res.status(500).send({
      success: false,
      message: "Failed to create checkout session",
    });
  }
});



app.get("/verify-payment", async (req, res) => {
  try {
    const { session_id } = req.query;

    if (!session_id || typeof session_id !== "string") {
      return res.status(400).send({
        success: false,
        message: "session_id is required",
      });
    }

    let session;

    try {
      session = await stripe.checkout.sessions.retrieve(session_id);
    } catch (error) {
      if (error?.code === "resource_missing") {
        return res.status(404).send({
          success: false,
          message: "Checkout session not found",
        });
      }
      throw error;
    }

    if (session.payment_status !== "paid") {
      return res.status(202).send({
        success: false,
        status: session.payment_status,
        message: "Payment not completed yet",
      });
    }

    const outcome = await confirmPaidCheckout(session);

    if (!outcome.confirmed) {
      return res.status(404).send({
        success: false,
        message: outcome.reason,
      });
    }

    const booking = await bookingsCollection.findOne({
      _id: new ObjectId(outcome.bookingId),
    });

    return res.status(200).send({
      success: true,
      message: "Payment verified",
      booking,
    });

  } catch (error) {
    console.error("Verify payment error:", error);

    return res.status(500).send({
      success: false,
      message: "Failed to verify payment",
    });
  }
});


app.get("/equipment/:equipmentId/booked-dates", async (req, res) => {
  try {
    const { equipmentId } = req.params;

    if (!ObjectId.isValid(equipmentId)) {
      return res.status(400).send({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    const bookings = await bookingsCollection
      .find({
        equipmentId: equipmentId, // Booking document-এ string হিসেবে save করা থাকলে
        status: "confirmed",
        paymentStatus: "paid",
      })
      .project({
        _id: 0,
        startDate: 1,
        endDate: 1,
        quantity: 1,
      })
      .toArray();

    return res.status(200).send({
      success: true,
      data: bookings,
    });
  } catch (error) {
    console.error("Booked dates error:", error);

    return res.status(500).send({
      success: false,
      message: "Failed to fetch booked dates",
    });
  }
});


// Get bookings by userId with equipment details  (own bookings only)
app.get("/bookings/user/:userId", tokenVerify, verifySelf(), async (req, res) => {
    try {
        const { userId } = req.params;

        if (!userId) {
            return res.status(400).send({
                success: false,
                message: "User ID is required",
            });
        }

        const result = await bookingsCollection.aggregate([
            {
                $match: { userId },
            },
            {
                $addFields: {
                    equipmentObjectId: {
                        $convert: {
                            input: "$equipmentId",
                            to: "objectId",
                            onError: null,
                            onNull: null,
                        },
                    },
                },
            },
            {
                $lookup: {
                    from: "equipments",
                    localField: "equipmentObjectId",
                    foreignField: "_id",
                    as: "equipment",
                },
            },
            {
                $unwind: {
                    path: "$equipment",
                    preserveNullAndEmptyArrays: true,
                },
            },
            {
                $project: {
                    equipmentObjectId: 0,
                },
            },
            {
                $sort: { createdAt: -1 },
            },
        ]).toArray();

        res.status(200).send({
            success: true,
            message: "Bookings fetched successfully",
            data: result,
        });

    } catch (error) {
        console.error("Get bookings error:", error);

        res.status(500).send({
            success: false,
            message: "Failed to fetch bookings",
        });
    }
});


// Get owner bookings with equipment and customer details  (owner only)
app.get("/owner/bookings/:ownerId", tokenVerify, verifyOwner, verifySelf("ownerId"), async (req, res) => {
    try {
        const { ownerId } = req.params;

        if (!ownerId) {
            return res.status(400).send({
                success: false,
                message: "Owner ID is required",
            });
        }

        const result = await bookingsCollection.aggregate([
            // Convert equipmentId to ObjectId
            {
                $addFields: {
                    equipmentObjectId: {
                        $convert: {
                            input: "$equipmentId",
                            to: "objectId",
                            onError: null,
                            onNull: null,
                        },
                    },
                    customerObjectId: {
                        $convert: {
                            input: "$userId",
                            to: "objectId",
                            onError: null,
                            onNull: null,
                        },
                    },
                },
            },

            // Get equipment details
            {
                $lookup: {
                    from: "equipments",
                    localField: "equipmentObjectId",
                    foreignField: "_id",
                    as: "equipment",
                },
            },
            {
                $unwind: "$equipment",
            },

            // Match owner's equipment
            {
                $match: {
                    $expr: {
                        $eq: [
                            { $toString: "$equipment.ownerId" },
                            ownerId,
                        ],
                    },
                },
            },

            // Get customer information
            {
                $lookup: {
                    from: "user",
                    localField: "customerObjectId",
                    foreignField: "_id",
                    as: "customer",
                },
            },
            {
                $unwind: {
                    path: "$customer",
                    preserveNullAndEmptyArrays: true,
                },
            },

            // Select required customer fields
            {
                $addFields: {
                    customer: {
                        _id: "$customer._id",
                        name: "$customer.name",
                        email: "$customer.email",
                        image: "$customer.image",
                        phone: "$customer.phone",
                    },
                },
            },

            // Latest bookings first
            {
                $sort: {
                    createdAt: -1,
                },
            },

            {
                $project: {
                    equipmentObjectId: 0,
                    customerObjectId: 0,
                },
            },
        ]).toArray();

        res.status(200).send({
            success: true,
            message: "Owner bookings fetched successfully",
            data: result,
        });

    } catch (error) {
        console.error("Get owner bookings error:", error);

        res.status(500).send({
            success: false,
            message: "Failed to fetch owner bookings",
        });
    }
});



// Get all bookings  (admin only)
app.get("/admin/bookings", tokenVerify, verifyAdmin, async (req, res) => {
  try {
    const result = await bookingsCollection.aggregate([
      // Convert booking IDs to ObjectId
      {
        $addFields: {
          equipmentObjectId: {
            $convert: {
              input: "$equipmentId",
              to: "objectId",
              onError: null,
              onNull: null,
            },
          },
          customerObjectId: {
            $convert: {
              input: "$userId",
              to: "objectId",
              onError: null,
              onNull: null,
            },
          },
        },
      },

      // Get equipment information
      {
        $lookup: {
          from: "equipments",
          localField: "equipmentObjectId",
          foreignField: "_id",
          as: "equipment",
        },
      },
      {
        $unwind: {
          path: "$equipment",
          preserveNullAndEmptyArrays: true,
        },
      },

      // Convert equipment ownerId to ObjectId
      {
        $addFields: {
          ownerObjectId: {
            $convert: {
              input: "$equipment.ownerId",
              to: "objectId",
              onError: null,
              onNull: null,
            },
          },
        },
      },

      // Get customer information
      {
        $lookup: {
          from: "user",
          localField: "customerObjectId",
          foreignField: "_id",
          as: "customer",
        },
      },
      {
        $unwind: {
          path: "$customer",
          preserveNullAndEmptyArrays: true,
        },
      },

      // Get owner information
      {
        $lookup: {
          from: "user",
          localField: "ownerObjectId",
          foreignField: "_id",
          as: "owner",
        },
      },
      {
        $unwind: {
          path: "$owner",
          preserveNullAndEmptyArrays: true,
        },
      },

      // Select safe fields
      {
        $project: {
          equipmentObjectId: 0,
          customerObjectId: 0,
          ownerObjectId: 0,

          "customer.password": 0,
          "customer.passwordHash": 0,
          "customer.accounts": 0,

          "owner.password": 0,
          "owner.passwordHash": 0,
          "owner.accounts": 0,
        },
      },

      // Latest bookings first
      {
        $sort: {
          createdAt: -1,
        },
      },
    ]).toArray();

    res.status(200).send({
      success: true,
      message: "All bookings fetched successfully",
      total: result.length,
      data: result,
    });
  } catch (error) {
    console.error("Get admin bookings error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to fetch bookings",
    });
  }
});


// Update booking status  (admin only)
app.patch("/admin/bookings/:bookingId", tokenVerify, verifyAdmin, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { status, paymentStatus } = req.body;

    if (!ObjectId.isValid(bookingId)) {
      return res.status(400).send({
        success: false,
        message: "Invalid booking ID",
      });
    }

    const allowedStatus = [
      "pending",
      "confirmed",
      "completed",
      "cancelled",
    ];

    const allowedPaymentStatus = [
      "pending",
      "paid",
      "failed",
      "refunded",
    ];

    if (
      !allowedStatus.includes(status) ||
      !allowedPaymentStatus.includes(paymentStatus)
    ) {
      return res.status(400).send({
        success: false,
        message: "Invalid status",
      });
    }

    const result = await bookingsCollection.updateOne(
      { _id: new ObjectId(bookingId) },
      {
        $set: {
          status,
          paymentStatus,
          updatedAt: new Date(),
        },
      }
    );

    if (!result.matchedCount) {
      return res.status(404).send({
        success: false,
        message: "Booking not found",
      });
    }

    res.send({
      success: true,
      message: "Booking updated successfully",
    });
  } catch (error) {
    console.error("Booking update error:", error);
    res.status(500).send({
      success: false,
      message: "Internal server error",
    });
  }
});


app.listen(PORT, () => {
  console.log(`Example app listening on port ${PORT}`)
})

export default app;

