import { IsOptional, IsString, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum VerifyActionEnum {
  VERIFY = 'VERIFY',
  REJECT = 'REJECT',
}

export class VerifyDocumentDto {
  @ApiPropertyOptional({ enum: VerifyActionEnum, default: VerifyActionEnum.VERIFY })
  @IsEnum(VerifyActionEnum)
  action: VerifyActionEnum = VerifyActionEnum.VERIFY;

  @ApiPropertyOptional({ description: 'Reason for rejection' })
  @IsOptional()
  @IsString()
  reason?: string;
}
