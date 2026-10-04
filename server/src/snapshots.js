import path from 'node:path';
import { config } from './config.js';

/** Where an event's photo (impact snapshot) is stored. */
export const snapshotPath = (eventId) => path.join(config.dataDir, 'snapshots', `${eventId}.jpg`);
