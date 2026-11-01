import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UserResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
  @ApiPropertyOptional() phone?: string;
  @ApiProperty() status: string;
  @ApiPropertyOptional() agencyId?: string;
  @ApiPropertyOptional() lastLoginAt?: Date;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
  @ApiProperty() role: { id: string; name: string; description?: string };
}
