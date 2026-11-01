import { IsString, IsIn, MinLength, IsOptional } from 'class-validator';

const LEVELS = ['SUPPORT', 'OPERATOR', 'SUPER'] as const;
export type PlatformAdminLevel = typeof LEVELS[number];

export class GrantPlatformAdminDto {
  @IsString() @MinLength(1) userId!: string;
  @IsString() @IsIn(LEVELS as unknown as string[]) level!: PlatformAdminLevel;
  @IsString() @MinLength(1) reason!: string;
}

export class RevokePlatformAdminDto {
  @IsString() @MinLength(1) reason!: string;
  @IsOptional() @IsString() userAgent?: string;
}
