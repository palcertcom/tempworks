import { IsOptional, IsEnum, IsString, IsUUID, IsBoolean } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { EmployeeStatusEnum } from './create-employee.dto';

export class EmployeeFilterDto extends PaginationDto {
  @ApiPropertyOptional({ enum: EmployeeStatusEnum }) @IsOptional() @IsEnum(EmployeeStatusEnum) status?: EmployeeStatusEnum;
  @ApiPropertyOptional({ description: 'Agency UUID' }) @IsOptional() @IsUUID() agencyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() nationality?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() licenseCategory?: string;
  @ApiPropertyOptional({ description: 'Only employees with a licence number or category (drivers)' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  driversOnly?: boolean;
}
