import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HealthController } from './health.controller';
import { readPocDatabaseConfig } from './db-config';

const database = readPocDatabaseConfig();

@Module({
  controllers: [HealthController],
  imports: [
    TypeOrmModule.forRoot({
      type: 'mariadb',
      host: database.host,
      port: database.port,
      username: database.username,
      password: database.password,
      database: database.database,
      autoLoadEntities: true,
      synchronize: false,
      migrationsRun: false,
    }),
  ],
})
export class AppModule {}
