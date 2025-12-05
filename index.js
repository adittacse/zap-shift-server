const express = require("express");
const app = express();
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const dotenv = require("dotenv");
dotenv.config();
const port = process.env.PORT || 3000;
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const crypto = require("crypto");
const admin = require("firebase-admin");

const serviceAccount = require("./zap-shift-firebase-adminsdk.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const generateTrackingId = () => {
    const prefix = "PRCL"; // brand prefix
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
    const random = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6-char random hex

    return `${prefix}-${date}-${random}`;
};

// middleware
app.use(cors());
app.use(express.json());

const verifyFirebaseToken = async (req, res, next) => {
    const authorization = req.headers.authorization;
    if (!authorization) {
        return res.status(401).send({ message: "Unauthorized Access" });
    }

    const token = authorization.split(" ")[1];
    if (!token) {
        return res.status(401).send({ message: "Unauthorized Access" });
    }

    try {
        const userInfo = await admin.auth().verifyIdToken(token);
        req.token_email = userInfo.email;
        next();
    } catch {
        return res.status(401).send({ message: "Unauthorized Access" });
    }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.gkaujxr.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();
        const db = client.db("zapShiftDB");
        const userCollection = db.collection("users");
        const parcelsCollection = db.collection("parcels");
        const paymentCollection = db.collection("payments");
        const ridersCollection = db.collection("riders");
        const trackingsCollection = db.collection("trackings");

        // admin middleware before allowing admin activity
        // must be use after verifyFirebaseToken middleware
        const verifyAdmin = async (req, res, next) => {
            const email = req.token_email;
            const query = { email: email };
            const result = await userCollection.findOne(query);
            if (!result || result.role !== "admin") {
                return res.status(403).send({ message: "Forbidden Access" });
            }
            next();
        };

        // rider middleware before allowing rider activity
        // must be use after verifyFirebaseToken middleware
        const verifyRider = async (req, res, next) => {
            const email = req.token_email;
            const query = { email: email };
            const result = await userCollection.findOne(query);
            if (!result || result.role !== "rider") {
                return res.status(403).send({ message: "Forbidden Access" });
            }
            next();
        };

        const logTracking = async (trackingId, status) => {
            const log = {
                trackingId,
                status,
                details: status.split("_").join(" "),
                createdAt: new Date()
            };

            const result = await trackingsCollection.insertOne(log);
            return result;
        }

        // user's related api's
        app.get("/users", verifyFirebaseToken, async (req, res) => {
            const searchText = req.query.searchText;
            const query = {};
            if (searchText) {
                query.$or = [
                    { displayName: { $regex: searchText, $options: "i" } },
                    { email: { $regex: searchText, $options: "i" } },
                ];
            }
            const cursor = userCollection
                .find(query)
                .sort({ displayName: 1 })
                .limit(5);
            const result = await cursor.toArray();
            res.send(result);
        });

        app.get("/users/:id", verifyFirebaseToken, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await userCollection.findOne(query);
            res.send(result);
        });

        app.get("/users/:email/role", verifyFirebaseToken, async (req, res) => {
            const email = req.params.email;
            const query = { email: email };
            const user = await userCollection.findOne(query);
            res.send({ role: user?.role || "user" });
        });

        app.post("/users", async (req, res) => {
            const user = req.body;
            user.role = "user";
            user.createdAt = new Date();

            const email = user.email;
            const userExists = await userCollection.findOne({ email });
            if (userExists) {
                return res.send({ message: "user exists" });
            }

            const result = await userCollection.insertOne(user);
            res.send(result);
        });

        app.patch("/users/:id/role", verifyFirebaseToken, verifyAdmin, async (req, res) => {
                const id = req.params.id;
                const roleInfo = req.body;
                const query = { _id: new ObjectId(id) };
                const update = {
                    $set: {
                        role: roleInfo.role,
                    },
                };
                const options = {};
                const result = await userCollection.updateOne(
                    query,
                    update,
                    options,
                );
                res.send(result);
            },
        );

        // parcel related api's
        app.get("/parcels", verifyFirebaseToken, async (req, res) => {
            const { email, deliveryStatus } = req.query;
            const query = {};
            if (email) {
                query.senderEmail = email;
            }
            if (deliveryStatus) {
                query.deliveryStatus = deliveryStatus;
            }
            const options = { sort: { createdAt: -1 } };
            const cursor = parcelsCollection.find(query, options);
            const result = await cursor.toArray();
            res.send(result);
        });

        app.get("/parcels/rider", verifyFirebaseToken, verifyRider, async (req, res) => {
            const { riderEmail, deliveryStatus } = req.query;
            const query = {};
            if (riderEmail) {
                query.riderEmail=riderEmail;
            }
            if (deliveryStatus !== "parcel_delivered") {
                query.deliveryStatus = { 
                    // $in: ["driver_assigned", "rider_arriving"]
                    $nin: ["parcel_delivered"]
                };
            } else {
                query.deliveryStatus = deliveryStatus;
            }
            const options = { sort: { createdAt: 1 } };
            const cursor = parcelsCollection.find(query, options);
            const result = await cursor.toArray();
            res.send(result);
        });

        app.get("/parcels/:id", async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await parcelsCollection.findOne(query);
            res.send(result);
        });

        app.get("/parcels/delivery-status/stats", async (req, res) => {
            const pipeline = [
                { 
                    $group: {
                        _id: "$deliveryStatus",
                        count: { $sum: 1 }
                    }
                },
                {
                    $project: {
                        status: "$_id",
                        count: 1,
                    }
                }
            ];
            const cursor = parcelsCollection.aggregate(pipeline);
            const result = await cursor.toArray();
            res.send(result);
        });

        app.post("/parcels", async (req, res) => {
            const parcel = req.body;
            const trackingId = generateTrackingId();
            parcel.createdAt = new Date();
            parcel.trackingId = trackingId;
            parcel.deliveryStatus = "parcel_created";

            await logTracking(trackingId, "parcel_created");

            const result = await parcelsCollection.insertOne(parcel);
            res.send(result);
        });

        app.patch("/parcels/:id", async (req, res) => {
            const { riderId, riderName, riderEmail, trackingId } = req.body;
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const update = {
                $set: {
                    deliveryStatus: "driver_assigned",
                    riderId: riderId,
                    riderName: riderName,
                    riderEmail: riderEmail
                }
            };
            const result = await parcelsCollection.updateOne(query, update);
            
            // update rider information
            const riderQuery = { _id: new ObjectId(riderId) };
            const riderUpdate = {
                $set: {
                    workStatus: "in_delivery"
                }
            };
            const riderResult = await ridersCollection.updateOne(riderQuery, riderUpdate);

            await logTracking(trackingId, "driver_assigned");

            res.send(riderResult);
        });

        app.patch("/parcels/:id/status", async (req, res) => {
            const { deliveryStatus, riderId, trackingId } = req.body;
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const update = {
                $set: {
                    deliveryStatus: deliveryStatus
                }
            };

            if (deliveryStatus === "parcel_delivered") {
                // update rider information
                const riderQuery = { _id: new ObjectId(riderId) };
                const riderUpdate = {
                    $set: {
                        workStatus: "available"
                    }
                };
                const riderResult = await ridersCollection.updateOne(riderQuery, riderUpdate);
            }

            const result = await parcelsCollection.updateOne(query, update);

            await logTracking(trackingId, deliveryStatus);

            res.send(result);
        });

        app.delete("/parcels/:id", async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await parcelsCollection.deleteOne(query);
            res.send(result);
        });

        // stripe payment related api's
        app.post("/create-checkout-session", async (req, res) => {
            const paymentInfo = req.body;
            const amount = parseInt(paymentInfo.cost) * 100;

            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        price_data: {
                            currency: "USD",
                            product_data: {
                                name: `Please pay for ${paymentInfo.parcelName}`,
                            },
                            unit_amount: amount,
                        },
                        quantity: 1,
                    },
                ],
                customer_email: paymentInfo.senderEmail,
                mode: "payment",
                metadata: {
                    parcelId: paymentInfo.parcelId,
                    parcelName: paymentInfo.parcelName,
                    trackingId: paymentInfo.trackingId
                },
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
            });

            res.send({ url: session.url });
        });
        
        app.patch("/payment-success", async (req, res) => {
            const sessionId = req.query.session_id;
            const session = await stripe.checkout.sessions.retrieve(sessionId);
            
            if (!session.payment_intent) {
                return res.send({
                    success: false,
                    message: "No payment_intent found in Stripe session",
                });
            }
            
            const transactionId = session.payment_intent;
            const trackingId = session.metadata.trackingId;

            if (session.payment_status === "paid") {
                const parcelId = session.metadata.parcelId;
                const parcelQuery = { _id: new ObjectId(parcelId) };
                const parcelUpdate = {
                    $set: {
                        paymentStatus: "paid",
                        deliveryStatus: "parcel_paid",
                    }
                };
                const parcelOptions = {};
                const parcelResult = await parcelsCollection.updateOne(parcelQuery, parcelUpdate, parcelOptions);
                
                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEmail: session.customer_email,
                    parcelId: parcelId,
                    parcelName: session.metadata.parcelName,
                    transactionId: transactionId,
                    paymentStatus: session.payment_status,
                    paidAt: new Date(),
                    trackingId: trackingId
                };
                
                const query = { transactionId: transactionId };
                const update = { $setOnInsert: payment };
                const options = { upsert: true };
                const paymentResult = await paymentCollection.updateOne(query, update, options);
                
                // check if it newly inserted or existing
                const newlyCreated = paymentResult.upsertedCount === 1;
                
                const paymentQuery = {
                    transactionId: transactionId
                }
                const existingPayment = await paymentCollection.findOne(paymentQuery);

                if (newlyCreated) {
                    await logTracking(trackingId, "parcel_paid");
                }
                
                return res.send({
                    success: true,
                    newlyCreated,
                    trackingId: trackingId,
                    transactionId: transactionId,
                    parcelUpdateResult: parcelResult,
                    paymentUpdateResult: paymentResult,
                    paymentInfo: existingPayment,
                });
            }

            return res.send({ success: false });
        });

        // payment related api's
        app.get("/payments", verifyFirebaseToken, async (req, res) => {
            const email = req.query.email;
            const query = {};
            if (email) {
                query.customerEmail = email;
                if (email !== req.token_email) {
                    return res
                        .status(403)
                        .send({ message: "Forbidden Access" });
                }
            }
            const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
            const result = await cursor.toArray();
            res.send(result);
        });

        // rider's related api's
        app.get("/riders", async (req, res) => {
            const { status, district, workStatus } = req.query;
            const query = {};
            if (status) {
                query.status = status;
            }
            if (district) {
                query.riderDistrict = district;
            }
            if (workStatus) {
                query.workStatus = workStatus;
            }
            const cursor = ridersCollection.find(query).sort({ createdAt: -1 });
            const result = await cursor.toArray();
            res.send(result);
        });

        app.get("/rider/delivery-per-day", async (req, res) => {
            const email = req.query.email;
            const pipeline = [
                {
                    $match: {
                        riderEmail: email,
                        deliveryStatus: "parcel_delivered"
                    }
                },
                {
                    $lookup: {
                        from: "trackings",
                        localField: "trackingId",
                        foreignField: "trackingId",
                        as: "parcel_tracking"
                    }
                },
                {
                    $unwind: "$parcel_tracking"
                },
                {
                    $match: {
                        "parcel_tracking.status": "parcel_delivered"
                    }
                },
                {
                    $addFields: {
                        deliveryDay: {
                            $dateToString: {
                                format: "%d-%m-%Y",
                                date: "$parcel_tracking.createdAt"
                            }
                        }
                    }
                },
                {
                    $group: {
                        _id: "$deliveryDay",
                        deliveredCount: {
                            $sum: 1
                        }
                    }
                }
            ];
            const cursor = parcelsCollection.aggregate(pipeline);
            const result = await cursor.toArray();
            res.send(result);
        });

        app.post("/riders", async (req, res) => {
            const rider = req.body;
            rider.status = "pending";
            rider.createdAt = new Date();

            const riderEmail = rider.riderEmail;
            const riderExist = await ridersCollection.findOne({ riderEmail });
            if (riderExist) {
                return res.send({ message: "already a rider" });
            }

            const result = await ridersCollection.insertOne(rider);
            res.send(result);
        });

        app.patch("/riders/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
                const status = req.body.status;
                const id = req.params.id;
                const query = { _id: new ObjectId(id) };
                const updatedDoc = {
                    $set: {
                        status: status,
                        workStatus: "available",
                    },
                };
                const options = {};
                const result = await ridersCollection.updateOne(query, updatedDoc, options);

                if (status === "approved") {
                    const email = req.body.email;
                    const userQuery = { email: email };
                    const updateUser = {
                        $set: {
                            role: "rider",
                        },
                    };
                    const userOptions = {};
                    const userResult = await userCollection.updateOne(
                        userQuery,
                        updateUser,
                        userOptions,
                    );
                }

                res.send(result);
            },
        );

        app.delete("/riders/:id", async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await ridersCollection.deleteOne(query);
            res.send(result);
        });

        // trackings related api's
        app.get("/tracking/:trackingId/logs", async (req, res) => {
            const trackingId = req.params.trackingId;
            const query = { trackingId: trackingId };
            const cursor = trackingsCollection.find(query);
            const result = await cursor.toArray();
            res.send(result);
        });

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);

app.get("/", (req, res) => {
    res.send("Zap Shift server is running!");
});

app.listen(port, () => {
    console.log(`Zap Shift Server listening on ${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}`);
});
