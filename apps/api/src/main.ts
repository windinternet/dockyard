import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();
  await mountWebClient(app);
  await app.listen(process.env.DOCKYARD_PORT ?? 4318, '127.0.0.1');
}

async function mountWebClient(app: NestExpressApplication): Promise<void> {
  const workspaceRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const webRoot = join(workspaceRoot, 'apps', 'web');

  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const vite = await createServer({ root: webRoot, server: { middlewareMode: true }, appType: 'custom' });
    app.use(vite.middlewares);
    app.use(async (request: Request, response: Response, next: NextFunction) => {
      if (!isWebNavigation(request)) return next();
      const template = await readFile(join(webRoot, 'index.html'), 'utf8');
      const html = await vite.transformIndexHtml(request.originalUrl, template);
      response.status(200).setHeader('Content-Type', 'text/html').end(html);
    });
    return;
  }

  const webDist = join(webRoot, 'dist');
  app.useStaticAssets(webDist);
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (isWebNavigation(request)) {
      response.sendFile(join(webDist, 'index.html'));
      return;
    }
    next();
  });
}

function isWebNavigation(request: Request): boolean {
  return request.method === 'GET' && !request.path.startsWith('/health') && !request.path.startsWith('/api') && !extname(request.path);
}

void bootstrap();
