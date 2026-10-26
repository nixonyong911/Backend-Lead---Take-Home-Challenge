import { Sequelize } from 'sequelize';
import { config } from '../config';

export const sequelize = new Sequelize(config.databaseUrl, {
  dialect: 'postgres',
  logging: false,
  define: { underscored: true },
  // Concurrency tests fire 10 parallel requests that each hold a connection while waiting on a row lock.
  pool: { max: 20 },
});
