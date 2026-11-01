import { PartialType } from '@nestjs/swagger';
import { CreateJobAdDto } from './create-job-ad.dto';

export class UpdateJobAdDto extends PartialType(CreateJobAdDto) {}
