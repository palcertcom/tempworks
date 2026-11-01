import { Module } from '@nestjs/common';
import { ApplicationDraftsController } from './application-drafts.controller';
import { ApplicationDraftsService } from './application-drafts.service';
import { ApplicantsModule } from '../applicants/applicants.module';

@Module({
  imports: [ApplicantsModule],
  controllers: [ApplicationDraftsController],
  providers: [ApplicationDraftsService],
})
export class ApplicationDraftsModule {}
