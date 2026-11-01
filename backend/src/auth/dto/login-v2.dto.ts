import { IsEmail, IsString, MinLength } from 'class-validator';

/**
 * Phase 3.13 — Tenant-aware login DTO.
 * Frontend may label `company` as "Company", "Workspace", or "Tenant".
 */
export class LoginV2Dto {
  @IsString() @MinLength(1) company!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(1) password!: string;
}
