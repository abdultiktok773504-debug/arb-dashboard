import "dotenv/config";
import express from "express";
import cors from "cors";
import arbRouter from "./routes/arb";

const app = express();
const PORT = process.env.PORT ?? 10000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

app.use("/api", arbRouter);

app.listen(PORT, () => {
  console.log(`[ARB] Server running on port ${PORT}`);
});
