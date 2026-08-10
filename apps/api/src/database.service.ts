import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DockyardDatabase, PathResolver } from '@dockyard/db';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private database?: DockyardDatabase;
  async onModuleInit(): Promise<void> { this.database = await DockyardDatabase.open(new PathResolver(process.env.DOCKYARD_STATE_DIR)); }
  onModuleDestroy(): void { this.database?.close(); }
  get db(): DockyardDatabase { if (!this.database) throw new Error('数据库尚未初始化。'); return this.database; }
}
