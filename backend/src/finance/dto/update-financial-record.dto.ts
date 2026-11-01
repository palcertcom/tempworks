import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateFinancialRecordDto } from './create-financial-record.dto';

/** All fields optional; entityType and entityId cannot be changed after creation. */
export class UpdateFinancialRecordDto extends PartialType(
  OmitType(CreateFinancialRecordDto, ['entityType', 'entityId'] as const),
) {}
