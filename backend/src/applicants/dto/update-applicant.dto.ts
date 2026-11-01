import { PartialType } from '@nestjs/swagger';
import { CreateApplicantDto } from './create-applicant.dto';
export class UpdateApplicantDto extends PartialType(CreateApplicantDto) {}
