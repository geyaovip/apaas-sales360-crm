import 'reflect-metadata';
import 'dotenv/config';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { AuthController } from './auth';
import { ApiErrorFilter, SessionGuard } from './common';
import { PrismaService } from './prisma.service';
import { CrmController, HealthController } from './crm.controller';
import { CrmService } from './crm.service';
import { CsmController } from './csm.controller';
import { CsmService } from './csm.service';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

@Module({ controllers: [AuthController, CrmController, CsmController, AiController, HealthController], providers: [PrismaService, SessionGuard, CrmService, CsmService, AiService] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: true });
  app.use(cookieParser());
  app.use((req: { requestId?: string; headers: Record<string, unknown> }, res: { setHeader: (key: string, value: string) => void }, next: () => void) => {
    const incoming = req.headers['x-request-id'];
    req.requestId = typeof incoming === 'string' && incoming.length < 100 ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  });
  app.useGlobalFilters(new ApiErrorFilter());
  app.enableCors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:4300', credentials: true });
  const port = Number(process.env.PORT || 4301);
  const host = process.env.HOST || '127.0.0.1';
  await app.listen(port, host);
  console.log(`Sales 360 API listening on ${host}:${port}`);
}
bootstrap();
