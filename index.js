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

        // Search by name and email
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: "i" } },
                { email: { $regex: search, $options: "i" } },
            ];
        }

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

//----------------- Equipments Api End ------------------------


app.listen(PORT, () => {
  console.log(`Example app listening on port ${PORT}`)
})

export default app;

