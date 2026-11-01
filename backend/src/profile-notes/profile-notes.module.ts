import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../common/storage/storage.module';
import { ProfileNotesController } from './profile-notes.controller';
import { ProfileNotesService } from './profile-notes.service';

@Module({
  imports: [PrismaModule, StorageModule],
  controllers: [ProfileNotesController],
  providers: [ProfileNotesService],
  exports: [ProfileNotesService],
})
export class ProfileNotesModule {}
