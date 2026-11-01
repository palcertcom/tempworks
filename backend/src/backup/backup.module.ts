import { Module } from '@nestjs/common';
import { PrismaModule }    from '../prisma/prisma.module';
import { BackupController } from './backup.controller';
import { BackupService }    from './backup.service';
import { BackupScheduleService } from './backup-schedule.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports:     [PrismaModule, NotificationsModule],
  controllers: [BackupController],
  providers:   [BackupService, BackupScheduleService],
})
export class BackupModule {}
