import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { M104InitialSchema1761670000000 } from './migrations/1761670000000-M104InitialSchema';

export function createDataSource(): DataSource {
  return new DataSource({
    type: 'mariadb',
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    username: process.env.DB_USER ?? 'm104_poc',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'm104_poc',
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
