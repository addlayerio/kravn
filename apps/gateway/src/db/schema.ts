/**
 * Deprecated. The hand-rolled `CREATE TABLE IF NOT EXISTS` bootstrap was replaced by versioned,
 * cross-dialect Knex migrations. See ./migrations.ts (and ./knex.ts / ./store.ts).
 */
export { runMigrations } from './migrations.js';
