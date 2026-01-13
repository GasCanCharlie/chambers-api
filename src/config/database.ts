/**
 * Database Configuration
 *
 * Prisma client singleton with connection handling
 */

import { PrismaClient } from '@prisma/client';
import { env, isDev } from './env.js';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isDev ? ['query', 'error', 'warn'] : ['error'],
  });

if (isDev) {
  globalForPrisma.prisma = prisma;
}

/**
 * Graceful shutdown handler
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
