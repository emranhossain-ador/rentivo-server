import express from "express";
import cors from "cors";
const app = express();

import { MongoClient, ObjectId } from 'mongodb';

import 'dotenv/config'

const PORT = process.env.PORT || 5001;

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

// Create unique index
await favoritesCollection.createIndex(
  { userId: 1, equipmentId: 1 },
  { unique: true }
);



app.get('/', (req, res)=>{
    res.send("Welcome to the Rentivo server");
});

// Get All users Api http://localhost:5001/users
app.get('/users', async (req, res) => {
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

// User Update Api http://localhost:5001/user/:Id/role
app.patch('/user/:Id/role', async (req, res) => {
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

// Create Equipment api http://localhost:5001/equipment
app.post("/equipment", async (req, res) => {
  try {
    const equipmentData = {
      ...req.body,
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
app.get("/equipment/:id", async (req, res) => {
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


// Equipment Update Api
app.patch("/equipment/:id", async (req, res) => {
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

// Equipment Delete api
app.delete("/equipment/:id", async (req, res) => {
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


// Get Equipments by Owner Id
app.get("/equipment/owner/:ownerId", async (req, res) => {
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


// Status update api
app.patch("/equipment/:id/status", async (req, res) => {
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


// Add favorites
app.post("/favorites", async (req, res) => {
  try {
    const { equipmentId, userId } = req.body;

    if (!ObjectId.isValid(equipmentId) || !ObjectId.isValid(userId)) {
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



app.get("/favorites/:equipmentId/:userId",  async (req, res) => {
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



app.get("/favorites/:userId", async (req, res) => {
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




app.delete("/favorites/:favoriteId/:userId", async (req, res) => {
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


app.listen(PORT, () => {
  console.log(`Example app listening on port ${PORT}`)
})

export default app;

