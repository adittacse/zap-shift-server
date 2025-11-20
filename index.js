const express = require("express");
const app = express();
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();
const port = process.env.PORT || 3000;

// middleware
app.use(express());
app.use(cors());

app.get("/", (req, res) => {
    res.send("Zap Shift server is running!");
});

app.listen(port, () => {
    console.log(`Zap Shift Server listening on ${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}`);
});