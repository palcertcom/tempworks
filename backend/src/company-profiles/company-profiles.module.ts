import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CompanyProfilesController } from './company-profiles.controller';
import { CompanyProfilesService } from './company-profiles.service';

@Module({
  imports: [PrismaModule],
  controllers: [CompanyProfilesController],
  providers: [CompanyProfilesService],
  exports: [CompanyProfilesService],
})
export class CompanyProfilesModule {}
