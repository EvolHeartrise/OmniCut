// Bun natively loads .env files — no dotenv import needed

// Initialize persistent state from SQLite on server startup.
// Top-level await ensures the database is ready before any requests are handled.
import { initStreamManager } from '$lib/server/streamManager.js';
await initStreamManager();
