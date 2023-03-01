const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const nodemailer = require("nodemailer");
const mg = require("nodemailer-mailgun-transport");
const stripe = require("stripe")(process.env.STRIPE_SK);
const port = process.env.PORT || 5000;

//middleware

app.use(cors());
app.use(express.json());

// mongodb connect

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.stpdj.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverApi: ServerApiVersion.v1,
});

function sendBookingEmail(bookings) {
  const { email, serviceName, appointmentDate, time } = bookings;

  const auth = {
    auth: {
      api_key: process.env.SEND_EMAIL_API_KEY,
      domain: process.env.SEND_EMAIL_DOMAIN,
    },
  };

  const transporter = nodemailer.createTransport(mg(auth));

  transporter.sendMail(
    {
      from: "saifulislam975317@gmail.com", // verified sender email
      to: email,
      subject: `Your appointment for ${serviceName} is confirmed`,
      text: "Hello world!", // plain text body
      html: `
    <h3>your appointment is confirmed</h3>
    <div>

    <p>Please visit us on ${appointmentDate} at${time}</p>
    <p>Thanks from SAIFUL Dentist center</p>
    </div>

    `,
    },
    function (error, info) {
      if (error) {
        console.log(error);
      } else {
        console.log("Email sent: " + info.response);
      }
    }
  );
}

function verifyJWT(req, res, next) {
  const authToken = req.headers.authorization;
  if (!authToken) {
    return res.status(401).send("unauthorized access");
  }
  const token = authToken.split(" ")[1];
  jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
    if (err) {
      return res.status(403).send({ message: "forbidden access" });
    }
    req.decoded = decoded;
    next();
  });
}

async function run() {
  try {
    const appointmentOptionsCollection = client
      .db("saifulDentistDb")
      .collection("appointmentOptions");

    const bookingCollection = client
      .db("saifulDentistDb")
      .collection("bookings");
    const usersCollection = client.db("saifulDentistDb").collection("users");
    const doctorsCollection = client
      .db("saifulDentistDb")
      .collection("doctors");
    const paymentsCollection = client
      .db("saifulDentistDb")
      .collection("payments");

    const verifyAdmin = async (req, res, next) => {
      const decodedEmail = req.decoded.email;
      const query = { email: decodedEmail };
      const user = await usersCollection.findOne(query);
      if (user?.role !== "admin") {
        return res.status(403).send({ message: "forbidden-access" });
      }
      next();
    };

    app.get("/appointmentSpecialty", async (req, res) => {
      const query = {};
      const result = await appointmentOptionsCollection
        .find(query)
        .project({ name: 1 })
        .toArray();
      res.send(result);
    });

    app.get("/appointmentOptions", async (req, res) => {
      const query = {};
      const date = req.query.date;
      const options = await appointmentOptionsCollection.find(query).toArray();
      const bookingQuery = { appointmentDate: date };
      const alreadyBooked = await bookingCollection
        .find(bookingQuery)
        .toArray();

      options.forEach((option) => {
        const optionBooked = alreadyBooked.filter(
          (book) => book.serviceName === option.name
        );
        const bookedTimes = optionBooked.map((book) => book.time);
        const remainingTimes = option.slots.filter(
          (slot) => !bookedTimes.includes(slot)
        );
        option.slots = remainingTimes;
      });

      res.send(options);
    });

    app.get("/bookings", verifyJWT, async (req, res) => {
      const email = req.query.email;
      const decodedEmail = req.decoded.email;
      if (email !== decodedEmail) {
        return res.status(403).send({ message: "forbidden-access" });
      }
      const query = { email: email };
      const bookings = await bookingCollection.find(query).toArray();
      res.send(bookings);
    });

    app.get("/bookings/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await bookingCollection.findOne(query);
      res.send(result);
    });

    app.post("/bookings", async (req, res) => {
      const bookings = req.body;
      const query = {
        appointmentDate: bookings.appointmentDate,
        serviceName: bookings.serviceName,
        email: bookings.email,
      };
      const alreadyBooked = await bookingCollection.find(query).toArray();
      if (alreadyBooked.length) {
        const message = `You already have booked on this date ${bookings.appointmentDate}`;
        return res.send({ acknowledged: false, message });
      }
      const result = await bookingCollection.insertOne(bookings);
      sendBookingEmail(bookings);
      res.send(result);
    });

    app.post("/create-payment-intent", async (req, res) => {
      const booking = req.body;
      const price = booking.price;
      const amount = price * 100;
      const paymentIntent = await stripe.paymentIntents.create({
        currency: "usd",
        amount: amount,
        payment_method_types: ["card"],
      });
      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    app.post("/payments", async (req, res) => {
      const payments = req.body;
      const result = await paymentsCollection.insertOne(payments);
      const id = payments.bookingId;
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          paid: true,
          transactionId: payments.transactionId,
        },
      };
      const updatedResult = await bookingCollection.updateOne(
        filter,
        updateDoc
      );
      res.send(result);
    });

    app.get("/jwt", async (req, res) => {
      const email = req.query.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      if (user) {
        const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, {
          expiresIn: "1d",
        });
        return res.send({ accessToken: token });
      }
      res.status(401).send({ accessToken: "Unauthorized access" });
    });

    app.get("/users", async (req, res) => {
      const query = {};
      const users = await usersCollection.find(query).toArray();
      res.send(users);
    });

    app.get("/users/admin/:email", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ isAdmin: user?.role === "admin" });
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.put("/users/admin/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const options = { upsert: true };
      const updateDoc = {
        $set: {
          role: "admin",
        },
      };
      const result = await usersCollection.updateOne(
        filter,
        updateDoc,
        options
      );
      res.send(result);
    });

    app.get("/doctors", verifyJWT, verifyAdmin, async (req, res) => {
      const query = {};
      const doctors = await doctorsCollection.find(query).toArray();
      res.send(doctors);
    });

    app.post("/doctors", verifyJWT, verifyAdmin, async (req, res) => {
      const doctors = req.body;
      const result = await doctorsCollection.insertOne(doctors);
      res.send(result);
    });

    app.delete("/doctors/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const result = await doctorsCollection.deleteOne(filter);
      res.send(result);
    });
  } finally {
  }
}
run().catch((error) => console.error(error));

app.get("/", (req, res) => {
  res.send("saiful dentist server is running ");
});

app.listen(port, () => {
  console.log(`port is running on ${port}`);
});
