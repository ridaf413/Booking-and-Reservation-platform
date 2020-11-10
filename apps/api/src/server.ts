import { app } from './app.js';
import { connect } from './db.js';
import { config } from './config.js';
import mongoose from 'mongoose';
await connect();
const server = app.listen(config.port, '0.0.0.0', () => console.log(`Roomly API listening on ${config.port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(async () => { await mongoose.disconnect(); process.exit(0); }));
