export interface PocDatabaseConfig {
  host: 'db';
  port: 3306;
  username: 'm104_poc';
  password: string;
  database: 'm104_poc';
}

const ALLOWED_TARGET = {
  DB_HOST: 'db',
  DB_PORT: '3306',
  DB_USER: 'm104_poc',
  DB_NAME: 'm104_poc',
} as const;

export function readPocDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PocDatabaseConfig {
  for (const [key, value] of Object.entries(ALLOWED_TARGET)) {
    if (environment[key] !== value) {
      throw new Error(`${key} must equal the isolated Compose target ${value}`);
    }
  }

  const password = environment.DB_PASSWORD;
  if (!password) throw new Error('DB_PASSWORD must be set to a disposable test value');

  return {
    host: 'db',
    port: 3306,
    username: 'm104_poc',
    password,
    database: 'm104_poc',
  };
}
