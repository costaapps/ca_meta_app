import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { readPocDatabaseConfig } from './db-config';
import { M104InitialSchema1761670000000 } from './migrations/1761670000000-M104InitialSchema';

export function createDataSource(): DataSource {
  const database = readPocDatabaseConfig();
  return new DataSource({
    type: 'mariadb',
    host: database.host,
    port: database.port,
    username: database.username,
    password: database.password,
    database: database.database,
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: true,
    entities: [],
    migrations: [M104InitialSchema1761670000000],
    migrationsTableName: 'm104_typeorm_migrations',
    synchronize: false,
    migrationsRun: false,
    migrationsTransactionMode: 'none',
    logging: false,
  });
}
