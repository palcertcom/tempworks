import { defineConfig } from 'prisma/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';
import { resolvePoolSsl } from './prisma/pg-ssl';

dotenv.config();

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL!,
  },
  migrate: {
    async adapter(env) {
      const pool = new Pool({
        connectionString: env.DATABASE_URL,
        ssl: resolvePoolSsl(env.DATABASE_URL),
      });
      return new PrismaPg(pool);
    },
  },
});
