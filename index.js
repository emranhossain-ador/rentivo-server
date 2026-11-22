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

    const equipment = await equipmentsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!equipment) {
      return res.status(404).send({
        success: false,
        message: "Equipment not found",
      });
    }

    res.send({
      success: true,
      data: equipment,
    });
  } catch (error) {
    console.error(error);

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



//----------------- Equipments Api End ------------------------


app.listen(PORT, () => {
  console.log(`Example app listening on port ${PORT}`)
})

export default app;

