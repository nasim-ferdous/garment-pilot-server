const express = require("express");
const app = express();
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const stripe = require("stripe")(`${process.env.STRIPE_API_KEY}`);
const crypto = require("crypto");
const port = process.env.PORT || 3000;
const admin = require("firebase-admin");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

function generateTrackingId() {
  const prefix = "PRCL"; // your brand prefix

  // Format date as YYYYMMDD
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  // 6-char random hex
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `${prefix}-${date}-${random}`;
}

// middleware
app.use(cors());
app.use(express.json());

const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: "unauthorize access" });
  }
  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("from decoded", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    res.status(401).send({ message: "unauthorized access" });
  }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.picyulc.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
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

    const db = client.db("garmentPilot");
    const usersCollection = db.collection("users");
    const productsCollection = db.collection("products");
    const ordersCollection = db.collection("orders");

    // users api
    app.post("/users", async (req, res) => {
      const user = req.body;
      const email = user.email;
      const isExist = await usersCollection.findOne({ email });
      if (isExist) {
        return res.send({ message: "User already exists" });
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // products api
    // all product
    app.get("/products", async (req, res) => {
      const query = {};
      const { email } = req.query;
      if (email) {
        query.createdBy = email;
      }
      const cursor = productsCollection.find(query).sort({ createdAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });
    // our products
    app.get("/our-products", async (req, res) => {
      const query = {};
      const { showOnHomePage } = req.query;
      if (showOnHomePage) {
        query.showOnHomePage = showOnHomePage === "true";
      }

      const cursor = productsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(6);
      const result = await cursor.toArray();
      res.send(result);
    });
    app.get("/products/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await productsCollection.findOne(query);
      res.send(result);
    });

    app.post("/products", async (req, res) => {
      const product = req.body;
      const result = await productsCollection.insertOne(product);
      res.send(result);
    });

    // payment related api of stripe
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data: {
              currency: "usd",
              product_data: {
                name: `Please pay for ${paymentInfo?.productName} `,
                images: [paymentInfo?.image],
              },
              unit_amount: parseInt(paymentInfo?.totalPrice * 100),
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.email,
        mode: "payment",
        metadata: {
          productId: paymentInfo?.productId,
          orderQuantity: paymentInfo?.orderQuantity,
          manager: paymentInfo?.manager,
          status: paymentInfo?.status,
          orderedAt: paymentInfo?.orderedAt,
        },
        success_url: `${process.env.SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/product/${paymentInfo?.productId}`,
      });
      console.log(session);

      res.send({ url: session.url });
    });
    // success payment api
    app.patch("/success-payment", async (req, res) => {
      const sessionId = req.query.session_id;

      const session = await stripe.checkout.sessions.retrieve(sessionId);
      console.log(session);

      if (session.payment_status !== "paid") {
        return res.status(400).send({ message: "Payment not completed" });
      }

      const productId = session.metadata.productId;
      const orderQuantity = Number(session.metadata.orderQuantity);

      const productQuery = { _id: new ObjectId(productId) };
      const product = await productsCollection.findOne(productQuery);

      if (!product) {
        return res.status(404).send({ message: "Product not found" });
      }

      //  Prevent duplicate order
      const existingOrder = await ordersCollection.findOne({
        transactionId: session.payment_intent,
      });

      if (existingOrder) {
        return res.send({ message: "Order already processed" });
      }
      const trackingId = generateTrackingId();
      const updatedProduct = {
        $set: {
          quantity: Number(product.quantity) - orderQuantity,
        },
      };

      //  Update product quantity
      const result = await productsCollection.updateOne(
        productQuery,
        updatedProduct
      );

      //  Create order
      const orderInfo = {
        productId,
        productName: product.name,
        manager: session.metadata.manager,
        status: "pending",
        orderedAt: new Date().toLocaleString(),
        orderQuantity,
        buyer: session.customer_email,
        paymentOption: product.paymentOptions,
        paymentStatus: "paid",
        transactionId: session.payment_intent,
        trackingId: trackingId,
      };

      const orderResult = await ordersCollection.insertOne(orderInfo);

      res.send({
        success: true,
        orderId: orderResult.insertedId,
        result: result.modifiedCount,
        transactionId: session.payment_intent,
        trackingId: trackingId,
      });
    });

    // order api for cash on delivery orders
    app.post("/orders", async (req, res) => {
      const bookingInfo = req.body;
      console.log(bookingInfo);
      const productId = bookingInfo.productId;
      const productQuery = { _id: new ObjectId(productId) };
      const orderQuantity = Number(bookingInfo.orderQuantity);

      const product = await productsCollection.findOne(productQuery);
      if (!product) {
        return res.status(404).send({ message: "Product not found" });
      }

      const trackingId = generateTrackingId();
      const updatedProduct = {
        $set: {
          quantity: Number(product.quantity) - orderQuantity,
        },
      };
      //  Update product quantity
      const result = await productsCollection.updateOne(
        productQuery,
        updatedProduct
      );
      //  Create order
      const orderInfo = {
        productId: bookingInfo.productId,
        productName: product.name,
        manager: bookingInfo.manager,
        status: "pending",
        orderedAt: new Date().toLocaleString(),
        orderQuantity,
        buyer: bookingInfo.email,
        paymentOption: product.paymentOptions,
        paymentStatus: "cash on delivery",
        trackingId: trackingId,
      };
      const orderResult = await ordersCollection.insertOne(orderInfo);

      res.send({
        success: true,
        orderId: orderResult.insertedId,
        result: result.modifiedCount,
        trackingId: trackingId,
      });
    });

    // buyer order related apis
    app.get("/my-orders", verifyFBToken, async (req, res) => {
      const query = {};
      const email = req.query.email;

      if (email) {
        query.buyer = email;
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "forbidden access" });
        }
      }
      const cursor = ordersCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });
    // cancel order
    app.delete("/cancel-order/:id", async (req, res) => {
      const id = req.params.id;
      const result = await ordersCollection.deleteOne({
        _id: new ObjectId(id),
      });

      res.send(result);
    });

    // Send a ping to confirm a successful connection

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("garment pilot is garmenting");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
