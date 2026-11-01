import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { StoragePurgeService } from './storage-purge.service';

@Global()
@Module({
  providers: [StorageService, StoragePurgeService],
  exports: [StorageService, StoragePurgeService],
})
export class StorageModule {}
