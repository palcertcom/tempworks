import { IsObject, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CreateApplicantDto } from '../../applicants/dto/create-applicant.dto';

/**
 * Final-submit payload. The client sends the same CreateApplicantDto
 * shape the existing POST /applicants endpoint accepts (flattened
 * personal fields + an `applicationData` blob). The draft is deleted
 * once the applicant row has been created successfully.
 */
export class SubmitDraftDto extends CreateApplicantDto {
  @ApiPropertyOptional({ description: 'Agency the new applicant is pinned to (admin-only; ignored for agency-side callers whose agency is auto-assigned).' })
  @IsOptional()
  @IsString()
  agencyId?: string;

  @ApiProperty({ description: 'Raw ApplicantFormData stored on the resulting applicant for traceability and used as the submitted snapshot.' })
  @IsObject()
  applicationData!: Record<string, any>;
}
