import { loadConfig } from "./config.js";
import { openDatabase, seedDevelopmentData } from "./db/index.js";
import { createAdapterRegistry } from "./channels/core/registry.js";
import { OutboxWorker } from "./outbox/worker.js";
import { createApp } from "./app.js";
import { ChannelSyncScheduler } from "./channels/core/scheduler.js";

const config=loadConfig();const db=openDatabase(config.databasePath);if(!config.production)seedDevelopmentData(db);const registry=createAdapterRegistry(config);const worker=new OutboxWorker(db,registry,config);const scheduler=new ChannelSyncScheduler(db,registry);worker.start();scheduler.start();const app=createApp({db,config,registry,worker});const server=app.listen(config.port,()=>console.log(`Customer Hub listening on :${config.port}`));
const shutdown=()=>{worker.stop();scheduler.stop();server.close(()=>{db.close();process.exit(0);});};process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
