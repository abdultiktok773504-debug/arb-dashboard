"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const arb_1 = __importDefault(require("./routes/arb"));
const app = (0, express_1.default)();
const PORT = process.env.PORT ?? 10000;
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
app.get("/health", (_req, res) => {
    res.json({ status: "ok", ts: new Date().toISOString() });
});
app.use("/api", arb_1.default);
app.listen(PORT, () => {
    console.log(`[ARB] Server running on port ${PORT}`);
});
