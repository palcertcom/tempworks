/**
 * Standalone Prisma client for the seed harness. Mirrors the
 * production app's pg-adapter wiring so SSL/local mode behaviour
 * is identical.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { join } from 'path';
import { resolvePoolSsl } from '../../../prisma/pg-ssl';

dotenv.config({ path: join(__dirname, '../../../.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolvePoolSsl(process.env.DATABASE_URL),
});

export const prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
