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
    credential: admin.credential.cert(serviceAccount)
});


const generateTrackingId = () => {
    const prefix = "PRCL";  // brand prefix
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");  // YYYYMMDD
    const random = crypto.randomBytes(3).toString("hex").toUpperCase();  // 6-char random hex
    
    return `${prefix}-${date}-${random}`;
}

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
}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.gkaujxr.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();
        const db = client.db("zapShiftDB");
        const parcelsCollection = db.collection("parcels");
        const paymentCollection = db.collection("payments");

        // parcel related api's
        app.get("/parcels", async (req, res) => {
            const { email } = req.query;
            const query = {};
            if (email) {
                query.senderEmail = email;
            }
            const options = { sort: { createdAt: -1 } };
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

        app.post("/parcels", async (req, res) => {
            const parcel = req.body;
            parcel.createdAt = new Date();
            const result = await parcelsCollection.insertOne(parcel);
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
                },
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
            });

            res.send({ url: session.url });
        });

        app.patch("/payment-success", async (req, res) => {
            const sessionId = req.query.session_id;
            const session = await stripe.checkout.sessions.retrieve(sessionId);
            
            // stop double transaction
            const transactionId = session.payment_intent;
            const query = { transactionId: transactionId };
            const paymentExist = await paymentCollection.findOne(query);
            if (paymentExist) {
                return res.send({ 
                    message: "already exist", 
                    transactionId,
                    trackingId: paymentExist.trackingId
                });
            }

            const trackingId = generateTrackingId();

            if (session.payment_status === "paid") {
                const id = session.metadata.parcelId;
                const query = { _id: new ObjectId(id) };
                const update = {
                    $set: {
                        paymentStatus: "paid",
                        trackingId: trackingId
                    }
                };
                const options = {};
                const result = await parcelsCollection.updateOne(query, update, options);

                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEmail: session.customer_email,
                    parcelId: session.metadata.parcelId,
                    parcelName: session.metadata.parcelName,
                    transactionId: session.payment_intent,
                    paymentStatus: session.payment_status,
                    paidAt: new Date(),
                    trackingId: trackingId
                }

                if (session.payment_status === "paid") {
                    const resultPayment = await paymentCollection.insertOne(payment);
                    res.send({ success: true, 
                        modifyParcel: result, 
                        trackingId: trackingId,
                        transactionId: session.payment_intent,
                        paymentInfo: resultPayment 
                    });
                }
            }
            res.send({ success: false });
        });

        // payment related api's
        app.get("/payments", verifyFirebaseToken, async (req, res) => {
            const email = req.query.email;
            const query = {};
            if (email) {
                query.customerEmail = email;
                if (email !== req.token_email) {
                    return res.status(403).send({ message: "Forbidden Access" });
                }
            }
            const cursor = paymentCollection.find(query);
            const result = await cursor.toArray();
            res.send(result);
        });

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!",);
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
    console.log(
        `Zap Shift Server listening on ${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}`,
    );
});
