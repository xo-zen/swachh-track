import 'dotenv/config';
import { seedDatabase } from '../apps/api/src/seed-data.js';

await seedDatabase();
