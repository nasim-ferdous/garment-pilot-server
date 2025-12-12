const express = require("express");
const app = express();
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const stripe = require("stripe")(`${process.env.STRIPE_API_KEY}`);
const port = process.env.PORT || 3000;

// middleware
app.use(cors());
app.use(express.json());

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
                name: paymentInfo?.productName,
                images: [paymentInfo?.image],
              },
              unit_amount: parseInt(paymentInfo?.totalPrice * 100), // amount in cents
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
        },
        success_url: `${process.env.SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/product/${paymentInfo?.productId}`,
      });
      

      res.send({ url: session.url });
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
